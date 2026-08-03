/**
 * RecallCoordinator — orchestrates the full recall pipeline.
 *
 * Routing:
 *   ID only → Exact memory read
 *   ID + Query → Anchored memory + evidence search
 *   Query only → Intent-based lane routing
 *
 * Lanes (priority ordered by intent):
 *   ExactFactLane → ProfileLane → CurrentViewLane
 *   → ProjectLane → EventLane → ProcedureLane → KnowledgeLane
 *
 * Knowledge is NOT always run first. It only runs when the intent
 * is knowledge_lookup, cross_project_compare, or explicit mixed request.
 */

import type { SearchHit, SearchResult, MentisContextSnapshot } from "@pi-mentis/pi-mentis-core";
import type { MemoryService, PiScopeContext } from "@pi-mentis/pi-mentis-memory-core";
import type { RetrievalService } from "./service.js";
import { classifyIntent } from "./recall-intent.js";

// ─── Public Types (mirrors pi-extension-support contract) ─────────

export interface PublicRecallHit {
  readonly id: string;
  readonly content: string;
  readonly kind:
    | "user"
    | "agent"
    | "project"
    | "repository"
    | "task"
    | "topic"
    | "event"
    | "procedure"
    | "knowledge";
  readonly status: "current" | "historical" | "conflicted";
  readonly match: "exact" | "profile" | "view" | "lexical" | "semantic" | "anchored";
}

export interface PublicRecallResult {
  readonly found: boolean;
  readonly summary?: string;
  readonly hits: readonly PublicRecallHit[];
  readonly traceId?: string;
}

// ─── Request / Context ────────────────────────────────────────────

export interface RecallRequest {
  readonly query?: string;
  readonly id?: string;
}

export interface RecallExecutionContext {
  readonly scopeContext: PiScopeContext;
  readonly contextSnapshot?: MentisContextSnapshot;
  readonly signal?: AbortSignal;
}

// ─── Coordinator Interface ────────────────────────────────────────

export interface RecallCoordinator {
  recall(request: RecallRequest, context: RecallExecutionContext): Promise<PublicRecallResult>;
}

// ─── Constants ────────────────────────────────────────────────────

const MAX_HITS = 5;
const MAX_CONTENT_LENGTH = 300;

// ─── Hit Mapping ─────────────────────────────────────────────────

function mapKind(sourceKind: SearchHit["kind"], _namespace: string): PublicRecallHit["kind"] {
  if (sourceKind === "knowledge") return "knowledge";
  const ns = _namespace.toLowerCase();
  if (ns.includes("user") || ns.includes("profile")) return "user";
  if (ns.includes("agent") || ns.includes("assistant")) return "agent";
  if (ns.includes("repo")) return "repository";
  if (ns.includes("project")) return "project";
  if (ns.includes("task")) return "task";
  if (ns.includes("event") || ns.includes("episodic")) return "event";
  if (ns.includes("proc")) return "procedure";
  return "topic";
}

function trimContent(text: string): string {
  if (text.length <= MAX_CONTENT_LENGTH) return text;
  return text.slice(0, MAX_CONTENT_LENGTH) + "...";
}

function buildHits(result: SearchResult): readonly PublicRecallHit[] {
  return result.hits.slice(0, MAX_HITS).map((hit) => ({
    id: hit.id,
    content: trimContent(hit.text),
    kind: mapKind(hit.kind, hit.namespace),
    status: "current",
    match: "semantic",
  }));
}

function buildSummary(hits: readonly PublicRecallHit[]): string | undefined {
  if (hits.length === 0 || hits[0] === undefined) return undefined;
  const first = hits[0].content;
  return first.length > 150 ? first.slice(0, 150) + "..." : first;
}

// ─── Exact Read ──────────────────────────────────────────────────

async function exactRead(memory: MemoryService, recordId: string): Promise<PublicRecallResult> {
  try {
    const record = await memory.get(recordId);
    if (record === undefined) {
      return { found: false, hits: [] };
    }

    const hit: PublicRecallHit = {
      id: record.id,
      content: trimContent(record.content),
      kind: "topic",
      status:
        record.temporalState === "historical"
          ? "historical"
          : record.temporalState === "conflicted"
            ? "conflicted"
            : "current",
      match: "exact",
    };

    return {
      found: true,
      summary: record.content.length > 150 ? record.content.slice(0, 150) + "..." : record.content,
      hits: [hit],
    };
  } catch {
    return { found: false, hits: [] };
  }
}

// ─── Implementation ───────────────────────────────────────────────

export class DefaultRecallCoordinator implements RecallCoordinator {
  readonly #memory: MemoryService;
  readonly #retrieval: RetrievalService;

  constructor(memory: MemoryService, retrieval: RetrievalService) {
    this.#memory = memory;
    this.#retrieval = retrieval;
  }

  async recall(
    request: RecallRequest,
    context: RecallExecutionContext,
  ): Promise<PublicRecallResult> {
    const { query, id } = request;
    const { scopeContext, contextSnapshot, signal } = context;

    // Mode 1: ID only → exact read
    if (id !== undefined && query === undefined) {
      return exactRead(this.#memory, id);
    }

    // Mode 2: ID + Query → anchored search
    if (id !== undefined && query !== undefined) {
      const exact = await exactRead(this.#memory, id);
      // Also do a semantic search scoped to the memory's context
      try {
        const searchResult = await this.#retrieval.search(
          {
            text: query,
            limit: MAX_HITS,
            memoryScopes: [],
            memoryScopeContext: scopeContext,
            ...(contextSnapshot !== undefined ? { contextSnapshot } : {}),
          },
          {
            ...(signal !== undefined ? { signal } : {}),
            allowRerank: true,
          },
        );
        const searchHits = buildHits(searchResult);
        const summary = buildSummary([...exact.hits, ...searchHits]);
        return {
          found: exact.found || searchHits.length > 0,
          ...(summary !== undefined ? { summary } : {}),
          hits: [...exact.hits, ...searchHits].slice(0, MAX_HITS),
        };
      } catch {
        return exact;
      }
    }

    // Mode 3: Query only → intent-based lane routing
    if (query !== undefined) {
      const intent = classifyIntent(query);

      // No recall needed
      if (intent.primary === "no_recall") {
        return { found: false, hits: [] };
      }

      // Knowledge lookup → always run retrieval with knowledge
      const needsKnowledge =
        intent.primary === "knowledge_lookup" || intent.primary === "cross_project_compare";

      // For agent_profile / user_profile / explicit_memory_lookup
      // Run retrieval but skip knowledge by using memory-only search
      const isMemoryOnly =
        intent.primary === "agent_profile" ||
        intent.primary === "user_profile" ||
        intent.primary === "explicit_memory_lookup";

      try {
        if (isMemoryOnly) {
          // Memory-only: use MemoryService.search directly
          const memResult = await this.#memory.search(
            {
              text: query,
              limit: MAX_HITS,
              scopeContext,
            },
            { ...(signal !== undefined ? { signal } : {}) },
          );
          const hits = buildHits(memResult);
          const summary = buildSummary(hits);
          return {
            found: hits.length > 0,
            ...(summary !== undefined ? { summary } : {}),
            hits,
          };
        }

        // Otherwise use RetrievalService (which may include knowledge)
        const result = await this.#retrieval.search(
          {
            text: query,
            limit: MAX_HITS,
            memoryScopes: needsKnowledge ? undefined : [],
            memoryScopeContext: scopeContext,
            ...(contextSnapshot !== undefined ? { contextSnapshot } : {}),
          },
          {
            ...(signal !== undefined ? { signal } : {}),
            allowRerank: true,
          },
        );

        const hits = buildHits(result);
        const summary = buildSummary(hits);
        return {
          found: hits.length > 0,
          ...(summary !== undefined ? { summary } : {}),
          hits,
        };
      } catch {
        return { found: false, hits: [] };
      }
    }

    // Both empty → error
    return { found: false, hits: [] };
  }
}
