/**
 * RecallCoordinator — orchestrates the full recall pipeline with strict ID routing.
 *
 * Routing:
 *   ID only → Resolve type → Route to Memory / Artifact / Evidence
 *   ID + Query → Resolve type → Anchored query (NEVER fall back to global)
 *   Query only → Intent-based lane routing
 *
 * Fail-closed: if ID is present and cannot be resolved, return error.
 * NEVER fall back to full-library search when ID exists.
 *
 * All results pass through secret detection before return.
 */

import type { SearchHit, SearchResult, MentisContextSnapshot } from "@pi-mentis/pi-mentis-core";
import type {
  MemoryService,
  PiScopeContext,
  PiEvidenceStore,
  ArtifactRecord,
} from "@pi-mentis/pi-mentis-memory-core";
import { detectSecrets, safeSummary } from "@pi-mentis/pi-mentis-memory-core";
import type { RetrievalService } from "./service.js";
import { classifyIntent } from "./recall-intent.js";
import {
  DefaultMentisResourceReferenceResolver,
  type MentisResourceReferenceResolver,
  type ResolvedMentisReference,
  type MentisResourceType,
} from "./resource-reference-resolver.js";
import { DefaultArtifactQueryService, type ArtifactQueryService } from "./artifact-query.js";

// ─── Public Types ─────────────────────────────────────────────────

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
    | "knowledge"
    | "artifact";
  readonly status: "current" | "historical" | "conflicted";
  readonly match: "exact" | "profile" | "view" | "lexical" | "semantic" | "anchored";
  readonly resourceType: MentisResourceType;
  readonly sanitized: boolean;
}

export interface PublicRecallResult {
  readonly found: boolean;
  readonly resourceType: MentisResourceType;
  readonly anchored: boolean;
  readonly reason?:
    "not_found" | "scope_denied" | "not_ready" | "expired" | "failed" | "ambiguous" | "unavailable";
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

// ─── Secret Sanitization ──────────────────────────────────────────

function sanitize(text: string): { text: string; sanitized: boolean } {
  const detection = detectSecrets(text);
  if (!detection.sensitive) return { text, sanitized: false };
  return { text: safeSummary(text, text.length), sanitized: true };
}

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
  return result.hits.slice(0, MAX_HITS).map((hit) => {
    const { text, sanitized: wasSanitized } = sanitize(hit.text);
    return {
      id: hit.id,
      content: trimContent(text),
      kind: mapKind(hit.kind, hit.namespace),
      status: "current",
      match: "semantic",
      resourceType: "memory" as const,
      sanitized: wasSanitized,
    };
  });
}

function buildSummary(hits: readonly PublicRecallHit[]): string | undefined {
  if (hits.length === 0 || hits[0] === undefined) return undefined;
  const first = hits[0].content;
  return first.length > 150 ? first.slice(0, 150) + "..." : first;
}

// ─── Reference Failure Response ──────────────────────────────────

type NonResolvedReason = Exclude<ResolvedMentisReference["reason"], "resolved">;

function referenceFailure(reason: NonResolvedReason, type: MentisResourceType): PublicRecallResult {
  return {
    found: false,
    resourceType: type,
    anchored: true,
    reason,
    hits: [],
  };
}

function resolverContext(
  scopeContext: PiScopeContext,
  signal?: AbortSignal,
): { readonly scopeContext: PiScopeContext; readonly signal?: AbortSignal } {
  if (signal === undefined) return { scopeContext };
  return { scopeContext, signal };
}

// ─── Exact Memory Read ────────────────────────────────────────────

async function exactMemoryRead(
  memory: MemoryService,
  recordId: string,
): Promise<PublicRecallResult> {
  try {
    const record = await memory.get(recordId);
    if (record === undefined) {
      return {
        found: false,
        resourceType: "unknown",
        anchored: true,
        reason: "not_found",
        hits: [],
      };
    }

    const { text: sanitizedContent, sanitized: wasSanitized } = sanitize(record.content);
    const hit: PublicRecallHit = {
      id: record.id,
      content: trimContent(sanitizedContent),
      kind: "topic",
      status:
        record.temporalState === "historical"
          ? "historical"
          : record.temporalState === "conflicted"
            ? "conflicted"
            : "current",
      match: "exact",
      resourceType: "memory",
      sanitized: wasSanitized,
    };

    return {
      found: true,
      resourceType: "memory",
      anchored: false,
      summary: record.content.length > 150 ? record.content.slice(0, 150) + "..." : record.content,
      hits: [hit],
    };
  } catch {
    return { found: false, resourceType: "unknown", anchored: true, reason: "failed", hits: [] };
  }
}

// ─── Memory Evolution Chain (ID + Query) ─────────────────────────

async function memoryEvolutionChain(
  memory: MemoryService,
  evidence: PiEvidenceStore,
  recordId: string,
  query: string,
  scopeContext: PiScopeContext,
  signal?: AbortSignal,
): Promise<PublicRecallResult> {
  try {
    const record = await memory.get(recordId);
    if (record === undefined) {
      return {
        found: false,
        resourceType: "unknown",
        anchored: true,
        reason: "not_found",
        hits: [],
      };
    }

    const hits: PublicRecallHit[] = [];

    // Current record
    const { text: currentSanitized, sanitized: currentWasSanitized } = sanitize(record.content);
    hits.push({
      id: record.id,
      content: trimContent(currentSanitized),
      kind: "topic",
      status:
        record.temporalState === "historical"
          ? "historical"
          : record.temporalState === "conflicted"
            ? "conflicted"
            : "current",
      match: "exact",
      resourceType: "memory",
      sanitized: currentWasSanitized,
    });

    // Superseded by
    if (record.supersededById !== undefined) {
      const newer = await memory.get(record.supersededById).catch(() => undefined);
      if (newer !== undefined) {
        const { text: s, sanitized: sanitized } = sanitize(newer.content);
        hits.push({
          id: newer.id,
          content: trimContent(s),
          kind: "topic",
          status: "current",
          match: "anchored",
          resourceType: "memory",
          sanitized,
        });
      }
    }

    // Superseded records
    for (const supersededId of record.supersedesIds.slice(0, 3)) {
      if (hits.length >= MAX_HITS) break;
      const old = await memory.get(supersededId).catch(() => undefined);
      if (old !== undefined) {
        const { text: s, sanitized: sanitized } = sanitize(old.content);
        hits.push({
          id: old.id,
          content: trimContent(s),
          kind: "topic",
          status: "historical",
          match: "anchored",
          resourceType: "memory",
          sanitized,
        });
      }
    }

    // Conflicts
    for (const conflictId of record.conflictsWithIds.slice(0, 3)) {
      if (hits.length >= MAX_HITS) break;
      const conflict = await memory.get(conflictId).catch(() => undefined);
      if (conflict !== undefined) {
        const { text: s, sanitized: sanitized } = sanitize(conflict.content);
        hits.push({
          id: conflict.id,
          content: trimContent(s),
          kind: "topic",
          status: "conflicted",
          match: "anchored",
          resourceType: "memory",
          sanitized,
        });
      }
    }

    // Evidence references
    for (const evRef of record.evidenceRefs.slice(0, 3)) {
      if (hits.length >= MAX_HITS) break;
      if (evRef.kind === "artifact") {
        try {
          const artifact = await evidence.getArtifact(evRef.id, {
            scopeContext,
            ...(signal !== undefined ? { signal } : {}),
          });
          if (artifact !== undefined && artifact.state === "ready") {
            hits.push({
              id: artifact.id,
              content: `[Artifact] ${artifact.mediaType} ${artifact.byteLength}B`,
              kind: "artifact",
              status: "current",
              match: "anchored",
              resourceType: "artifact",
              sanitized: false,
            });
          }
        } catch {
          // evidence ref unavailable, skip
        }
      }
      if (evRef.kind === "event") {
        try {
          const event = await evidence.getEvent(evRef.id, {
            scopeContext,
            ...(signal !== undefined ? { signal } : {}),
          });
          if (event !== undefined) {
            hits.push({
              id: event.id,
              content: `[Event] ${event.kind} seq=${event.sequence}`,
              kind: "event",
              status: "current",
              match: "anchored",
              resourceType: "evidence",
              sanitized: false,
            });
          }
        } catch {
          // evidence ref unavailable, skip
        }
      }
    }

    return {
      found: true,
      resourceType: "memory",
      anchored: true,
      summary: `Memory evolution chain: ${hits.length} related records`,
      hits: hits.slice(0, MAX_HITS),
    };
  } catch {
    return { found: false, resourceType: "unknown", anchored: true, reason: "failed", hits: [] };
  }
}

// ─── Artifact Metadata Response ──────────────────────────────────

function artifactSummary(artifact: ArtifactRecord): PublicRecallResult {
  const readable =
    artifact.state === "ready" &&
    (artifact.expiresAt === undefined || artifact.expiresAt > Date.now());

  return {
    found: true,
    resourceType: "artifact",
    anchored: true,
    summary: JSON.stringify({
      id: artifact.id,
      resourceType: "artifact",
      status: artifact.state,
      byteLength: artifact.byteLength,
      contentHash: artifact.contentHash,
      mediaType: artifact.mediaType,
      queryable: readable,
      chunkCount: artifact.chunks.length,
    }),
    hits: [],
  };
}

// ─── Artifact Anchored Query ─────────────────────────────────────

async function anchoredArtifactQuery(
  service: ArtifactQueryService,
  artifactId: string,
  query: string,
  scopeContext: PiScopeContext,
  signal?: AbortSignal,
): Promise<PublicRecallResult> {
  try {
    const result = await service.query(artifactId, query, {
      scopeContext,
      ...(signal !== undefined ? { signal } : {}),
    });

    if (!result.found) {
      return {
        found: false,
        resourceType: "artifact",
        anchored: true,
        summary: result.summary ?? "No matches found in artifact",
        hits: [],
      };
    }

    const hits: PublicRecallHit[] = result.hits.slice(0, MAX_HITS).map((h) => ({
      id: h.artifactId,
      content: trimContent(h.content),
      kind: "artifact" as const,
      status: "current" as const,
      match: h.match === "exact" ? "anchored" : "lexical",
      resourceType: "artifact" as const,
      sanitized: h.sanitized,
    }));

    return {
      found: true,
      resourceType: "artifact",
      anchored: true,
      summary: `Found ${result.hits.length} match(es) in artifact`,
      hits,
    };
  } catch {
    return { found: false, resourceType: "artifact", anchored: true, reason: "failed", hits: [] };
  }
}

// ─── Evidence Summary ────────────────────────────────────────────

async function evidenceSummary(
  evidence: PiEvidenceStore,
  eventId: string,
  scopeContext: PiScopeContext,
  signal?: AbortSignal,
): Promise<PublicRecallResult> {
  try {
    const event = await evidence.getEvent(eventId, {
      scopeContext,
      ...(signal !== undefined ? { signal } : {}),
    });
    if (event === undefined) {
      return {
        found: false,
        resourceType: "unknown",
        anchored: true,
        reason: "not_found",
        hits: [],
      };
    }
    return {
      found: true,
      resourceType: "evidence",
      anchored: true,
      summary: JSON.stringify({
        id: event.id,
        resourceType: "evidence",
        kind: event.kind,
        episodeId: event.episodeId,
        sequence: event.sequence,
        timestamp: event.timestamp,
        hasArtifactRef: event.artifactRef !== undefined,
      }),
      hits: [],
    };
  } catch {
    return { found: false, resourceType: "unknown", anchored: true, reason: "failed", hits: [] };
  }
}

// ─── Implementation ───────────────────────────────────────────────

export interface MentisServiceAccess {
  getMemory(): MemoryService | undefined;
  getRetrieval(): RetrievalService | undefined;
  getEvidence(): PiEvidenceStore | undefined;
}

export class DefaultRecallCoordinator implements RecallCoordinator {
  readonly #services: MentisServiceAccess;
  readonly #resolver: MentisResourceReferenceResolver;
  readonly #artifactQuery: ArtifactQueryService;

  constructor(services: MentisServiceAccess) {
    this.#services = services;
    this.#resolver = new DefaultMentisResourceReferenceResolver(services);
    this.#artifactQuery = new DefaultArtifactQueryService(services);
  }

  async recall(
    request: RecallRequest,
    context: RecallExecutionContext,
  ): Promise<PublicRecallResult> {
    const { query, id } = request;
    const { scopeContext, contextSnapshot, signal } = context;

    const evidence = this.#services.getEvidence();
    const memory = this.#services.getMemory();
    const retrieval = this.#services.getRetrieval();

    // ── MODE 1: ID only → resolve type → route ──
    if (id !== undefined && query === undefined) {
      const ref = await this.#resolver.resolve(id, resolverContext(scopeContext, signal));
      if (ref.reason !== "resolved") {
        return referenceFailure(ref.reason as NonResolvedReason, ref.type);
      }

      if (ref.type === "memory") {
        if (memory === undefined) {
          return {
            found: false,
            resourceType: "unknown",
            anchored: true,
            reason: "unavailable" as NonResolvedReason,
            hits: [],
          };
        }
        return exactMemoryRead(memory, id);
      }

      if (ref.type === "artifact") {
        if (evidence === undefined) {
          return {
            found: false,
            resourceType: "unknown",
            anchored: true,
            reason: "unavailable" as NonResolvedReason,
            hits: [],
          };
        }
        const artifact = await evidence.getArtifact(id, {
          scopeContext,
          ...(signal !== undefined ? { signal } : {}),
        });
        if (artifact === undefined) {
          return {
            found: false,
            resourceType: "unknown",
            anchored: true,
            reason: "not_found",
            hits: [],
          };
        }
        return artifactSummary(artifact);
      }

      if (ref.type === "evidence") {
        if (evidence === undefined) {
          return {
            found: false,
            resourceType: "unknown",
            anchored: true,
            reason: "unavailable" as NonResolvedReason,
            hits: [],
          };
        }
        return evidenceSummary(evidence, id, scopeContext, signal);
      }

      return {
        found: false,
        resourceType: "unknown",
        anchored: true,
        reason: "not_found",
        hits: [],
      };
    }

    // ── MODE 2: ID + Query → anchored search, NEVER fall back ──
    if (id !== undefined && query !== undefined) {
      const ref = await this.#resolver.resolve(id, resolverContext(scopeContext, signal));
      if (ref.reason !== "resolved") {
        return referenceFailure(ref.reason as NonResolvedReason, ref.type);
      }

      if (ref.type === "artifact") {
        return anchoredArtifactQuery(this.#artifactQuery, id, query, scopeContext, signal);
      }

      if (ref.type === "memory") {
        if (memory === undefined || evidence === undefined) {
          return {
            found: false,
            resourceType: "unknown",
            anchored: true,
            reason: "unavailable" as NonResolvedReason,
            hits: [],
          };
        }
        return memoryEvolutionChain(memory, evidence, id, query, scopeContext, signal);
      }

      if (ref.type === "evidence") {
        return {
          found: false,
          resourceType: "evidence",
          anchored: true,
          reason: "not_ready",
          summary: "Evidence records do not support anchored queries",
          hits: [],
        };
      }

      return {
        found: false,
        resourceType: "unknown",
        anchored: true,
        reason: "not_found",
        hits: [],
      };
    }

    // ── MODE 3: Query only → intent-based lane routing ──
    if (query !== undefined) {
      const intent = classifyIntent(query);

      if (intent.primary === "no_recall") {
        return {
          found: false,
          resourceType: "search",
          anchored: false,
          hits: [],
        };
      }

      const needsKnowledge =
        intent.primary === "knowledge_lookup" || intent.primary === "cross_project_compare";

      const isMemoryOnly =
        intent.primary === "agent_profile" ||
        intent.primary === "user_profile" ||
        intent.primary === "explicit_memory_lookup" ||
        intent.primary === "current_project_fact";

      try {
        if (isMemoryOnly && memory !== undefined) {
          // Profile/Project queries: first check views for exact fact matches
          if (intent.primary === "agent_profile" || intent.primary === "user_profile") {
            const view = await memory.getView?.("user", scopeContext.userId, scopeContext);
            if (view !== undefined && view.facts !== undefined) {
              const profileHits: PublicRecallHit[] = [];
              const profileFactKeys =
                intent.primary === "agent_profile"
                  ? ["assistant_alias", "response_style", "language_preference"]
                  : ["user_name", "response_style", "language_preference"];
              for (const factKey of profileFactKeys) {
                const allKey = Object.keys(view.facts).find((k) => k.includes(factKey));
                if (allKey !== undefined) {
                  const fact = view.facts[allKey];
                  if (fact !== undefined && fact.currentMemoryIds.length > 0) {
                    for (const memId of fact.currentMemoryIds.slice(0, 2)) {
                      const record = await memory.get(memId).catch(() => undefined);
                      if (record !== undefined) {
                        const { text: s, sanitized: sanitized } = sanitize(record.content);
                        profileHits.push({
                          id: record.id,
                          content: trimContent(s),
                          kind: intent.primary === "agent_profile" ? "agent" : "user",
                          status: "current",
                          match: "exact",
                          resourceType: "memory",
                          sanitized,
                        });
                      }
                    }
                  }
                }
              }
              if (profileHits.length > 0) {
                const summary = buildSummary(profileHits);
                const result: PublicRecallResult = {
                  found: true,
                  resourceType: "search",
                  anchored: false,
                  hits: profileHits.slice(0, MAX_HITS),
                };
                if (summary !== undefined) {
                  (result as { summary?: string }).summary = summary;
                }
                return result;
              }
            }
          }

          if (intent.primary === "current_project_fact") {
            const view =
              scopeContext.repositoryId !== undefined
                ? await memory.getView?.("project", scopeContext.repositoryId, scopeContext)
                : scopeContext.projectId !== undefined
                  ? await memory.getView?.("project", scopeContext.projectId, scopeContext)
                  : undefined;
            if (view !== undefined && view.facts !== undefined) {
              const projectHits: PublicRecallHit[] = [];
              const projectFactKeys = [
                "build_command",
                "package_manager",
                "test_command",
                "database",
                "deployment_target",
              ];
              for (const factKey of projectFactKeys) {
                const allKey = Object.keys(view.facts).find((k) => k.includes(factKey));
                if (allKey !== undefined) {
                  const fact = view.facts[allKey];
                  if (fact !== undefined && fact.currentMemoryIds.length > 0) {
                    for (const memId of fact.currentMemoryIds.slice(0, 2)) {
                      const record = await memory.get(memId).catch(() => undefined);
                      if (record !== undefined) {
                        const { text: s, sanitized: sanitized } = sanitize(record.content);
                        projectHits.push({
                          id: record.id,
                          content: trimContent(s),
                          kind: "project",
                          status: "current",
                          match: "exact",
                          resourceType: "memory",
                          sanitized,
                        });
                      }
                    }
                  }
                }
              }
              if (projectHits.length > 0) {
                const summary = buildSummary(projectHits);
                const result: PublicRecallResult = {
                  found: true,
                  resourceType: "search",
                  anchored: false,
                  hits: projectHits.slice(0, MAX_HITS),
                };
                if (summary !== undefined) {
                  (result as { summary?: string }).summary = summary;
                }
                return result;
              }
            }
          }

          const memResult = await memory.search(
            { text: query, limit: MAX_HITS, scopeContext },
            { ...(signal !== undefined ? { signal } : {}) },
          );
          const hits = buildHits(memResult);
          const summary = buildSummary(hits);
          const memRecallResult: PublicRecallResult = {
            found: hits.length > 0,
            resourceType: "search",
            anchored: false,
            hits,
          };
          if (summary !== undefined) {
            (memRecallResult as { summary?: string }).summary = summary;
          }
          return memRecallResult;
        }

        if (isMemoryOnly && memory === undefined) {
          return {
            found: false,
            resourceType: "search",
            anchored: false,
            reason: "unavailable" as NonResolvedReason,
            hits: [],
          };
        }

        if (retrieval === undefined) {
          return { found: false, resourceType: "search", anchored: false, hits: [] };
        }

        const result = await retrieval.search(
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
        const retrievalResult: PublicRecallResult = {
          found: hits.length > 0,
          resourceType: "search",
          anchored: false,
          hits,
        };
        if (summary !== undefined) {
          (retrievalResult as { summary?: string }).summary = summary;
        }
        return retrievalResult;
      } catch {
        return { found: false, resourceType: "search", anchored: false, hits: [] };
      }
    }

    // Both empty → error
    return { found: false, resourceType: "unknown", anchored: false, hits: [] };
  }
}
