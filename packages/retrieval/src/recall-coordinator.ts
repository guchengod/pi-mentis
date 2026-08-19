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

import {
  estimateModelTokens,
  type SearchHit,
  type SearchResult,
  type MentisContextSnapshot,
} from "@pi-mentis/pi-mentis-core";
import {
  projectMemoryRecallHit,
  type MemoryRecord,
  type MemoryService,
  type PiScopeContext,
  type PiEvidenceStore,
  type ArtifactRecord,
} from "@pi-mentis/pi-mentis-memory-core";
import { detectSecrets, safeSummary } from "@pi-mentis/pi-mentis-memory-core";
import type { RetrievalService } from "./service.js";
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
  readonly resourceType: MentisResourceType | "knowledge";
  readonly sanitized: boolean;
  readonly artifactChunkIndex?: number;
  readonly byteStart?: number;
  readonly byteEnd?: number;
}

export interface PublicRecallResult {
  readonly found: boolean;
  readonly entityFound?: boolean;
  readonly contentFound?: boolean;
  readonly lookupMode?: "exact_id" | "anchored_query" | "global_query";
  readonly artifactId?: string;
  readonly resourceType: MentisResourceType;
  readonly anchored: boolean;
  readonly reason?:
    "not_found" | "scope_denied" | "not_ready" | "expired" | "failed" | "ambiguous" | "unavailable";
  readonly summary?: string;
  readonly hits: readonly PublicRecallHit[];
  readonly traceId?: string;
  readonly diagnostics?: Readonly<{
    readonly plannerDegraded: boolean;
    readonly retrievalMode?: "focused" | "broad";
    readonly memoryNeed?: Readonly<{ readonly required: boolean; readonly confidence: number }>;
    readonly durationMs?: number;
    readonly stages?: Readonly<Record<string, number>>;
    readonly candidateCount?: number;
    readonly selectedHitCount?: number;
    readonly returnedBytes?: number;
    readonly estimatedReturnedTokens?: number;
    readonly artifact?: Readonly<{
      readonly artifactBytes: number;
      readonly chunksScanned: number;
      readonly bytesRead: number;
      readonly returnedBytes: number;
      readonly estimatedReturnedTokens: number;
    }>;
  }>;
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
const MAX_ARTIFACT_CONTENT_LENGTH = 1_200;

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

function trimContent(text: string, maxLength = MAX_CONTENT_LENGTH): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "...";
}

function buildHits(result: SearchResult): readonly PublicRecallHit[] {
  return result.hits.slice(0, MAX_HITS).flatMap((hit): readonly PublicRecallHit[] => {
    if (hit.kind === "memory") {
      const metadata = (hit.metadata ?? {}) as Partial<MemoryRecord>;
      const projected = projectMemoryRecallHit(
        {
          id: hit.id,
          content: hit.text,
          scope: metadata.scope ?? { kind: "user", id: "local" },
          ...(metadata.status === undefined ? {} : { status: metadata.status }),
          ...(metadata.scopeContext === undefined ? {} : { scopeContext: metadata.scopeContext }),
          ...(metadata.role === undefined ? {} : { role: metadata.role }),
        },
        { match: "semantic" },
      );
      return projected === undefined ? [] : [projected.hit];
    }
    const { text, sanitized: wasSanitized } = sanitize(hit.text);
    return [
      {
        id: hit.id,
        content: trimContent(text),
        kind: mapKind(hit.kind, hit.namespace),
        status: "current" as const,
        match: "semantic" as const,
        resourceType: "knowledge" as const,
        sanitized: wasSanitized,
      },
    ];
  });
}

function buildSummary(hits: readonly PublicRecallHit[]): string | undefined {
  if (hits.length === 0) return undefined;
  if (hits.length === 1) {
    const firstHit = hits[0];
    if (firstHit === undefined) return undefined;
    const first = firstHit.content;
    return first.length > 150 ? first.slice(0, 150) + "..." : first;
  }
  return hits
    .slice(0, MAX_HITS)
    .map((hit) => (hit.content.length > 150 ? hit.content.slice(0, 150) + "..." : hit.content))
    .join("\n");
}

// ─── Reference Failure Response ──────────────────────────────────

type NonResolvedReason = Exclude<ResolvedMentisReference["reason"], "resolved">;

function referenceFailure(
  reason: NonResolvedReason,
  type: MentisResourceType,
  lookupMode: "exact_id" | "anchored_query",
): PublicRecallResult {
  return {
    found: false,
    entityFound: false,
    contentFound: false,
    lookupMode,
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
  scopeContext: PiScopeContext,
): Promise<PublicRecallResult> {
  try {
    const record = await memory.get(recordId, { scopeContext });
    if (record === undefined) {
      return {
        found: false,
        entityFound: false,
        contentFound: false,
        lookupMode: "exact_id",
        resourceType: "unknown",
        anchored: true,
        reason: "not_found",
        hits: [],
      };
    }

    const hit = projectMemoryRecallHit(record, { scopeContext, match: "exact" })?.hit;
    if (hit === undefined) {
      return {
        found: false,
        entityFound: false,
        contentFound: false,
        lookupMode: "exact_id",
        resourceType: "unknown",
        anchored: true,
        reason: "not_found",
        hits: [],
      };
    }

    return {
      found: true,
      entityFound: true,
      contentFound: true,
      lookupMode: "exact_id",
      resourceType: "memory",
      anchored: true,
      summary: hit.content.length > 150 ? hit.content.slice(0, 150) + "..." : hit.content,
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
    const record = await memory.get(recordId, { scopeContext });
    if (record === undefined) {
      return {
        found: false,
        entityFound: false,
        contentFound: false,
        lookupMode: "anchored_query",
        resourceType: "unknown",
        anchored: true,
        reason: "not_found",
        hits: [],
      };
    }

    const hits: PublicRecallHit[] = [];

    // Current record
    const current = projectMemoryRecallHit(record, { scopeContext, match: "exact" })?.hit;
    if (current === undefined) {
      return {
        found: false,
        resourceType: "unknown",
        anchored: true,
        reason: "not_found",
        hits: [],
      };
    }
    hits.push(current);

    // Superseded by
    if (record.supersededById !== undefined) {
      const newer = await memory
        .get(record.supersededById, { scopeContext })
        .catch(() => undefined);
      if (newer !== undefined) {
        const projected = projectMemoryRecallHit(newer, {
          scopeContext,
          match: "anchored",
          status: "current",
        })?.hit;
        if (projected !== undefined) hits.push(projected);
      }
    }

    // Superseded records
    for (const supersededId of record.relationships.supersedesIds.slice(0, 3)) {
      if (hits.length >= MAX_HITS) break;
      const old = await memory.get(supersededId, { scopeContext }).catch(() => undefined);
      if (old !== undefined) {
        const projected = projectMemoryRecallHit(old, {
          scopeContext,
          match: "anchored",
          status: "historical",
        })?.hit;
        if (projected !== undefined) hits.push(projected);
      }
    }

    // Conflicts
    for (const conflictId of record.relationships.conflictsWithIds.slice(0, 3)) {
      if (hits.length >= MAX_HITS) break;
      const conflict = await memory.get(conflictId, { scopeContext }).catch(() => undefined);
      if (conflict !== undefined) {
        const projected = projectMemoryRecallHit(conflict, {
          scopeContext,
          match: "anchored",
          status: "conflicted",
        })?.hit;
        if (projected !== undefined) hits.push(projected);
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
      entityFound: true,
      contentFound: true,
      lookupMode: "anchored_query",
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
    entityFound: true,
    contentFound: false,
    lookupMode: "exact_id",
    artifactId: artifact.id,
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
    diagnostics: {
      plannerDegraded: false,
      selectedHitCount: 0,
      returnedBytes: 0,
      estimatedReturnedTokens: 0,
      artifact: {
        artifactBytes: artifact.byteLength,
        chunksScanned: 0,
        bytesRead: 0,
        returnedBytes: 0,
        estimatedReturnedTokens: 0,
      },
    },
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
        entityFound: result.entityFound,
        contentFound: false,
        lookupMode: "anchored_query",
        ...(result.entityFound ? { artifactId } : {}),
        resourceType: "artifact",
        anchored: true,
        summary: result.summary ?? "No matches found in artifact",
        hits: [],
        diagnostics: {
          plannerDegraded: false,
          durationMs: result.diagnostics.durationMs,
          selectedHitCount: 0,
          returnedBytes: 0,
          estimatedReturnedTokens: 0,
          artifact: result.diagnostics,
        },
      };
    }

    const hits: PublicRecallHit[] = result.hits.slice(0, MAX_HITS).map((h) => ({
      id: h.artifactId,
      content: trimContent(h.content, MAX_ARTIFACT_CONTENT_LENGTH),
      kind: "artifact" as const,
      status: "current" as const,
      match: h.match === "exact" ? "anchored" : "lexical",
      resourceType: "artifact" as const,
      sanitized: h.sanitized,
      artifactChunkIndex: h.chunkIndex,
      byteStart: h.byteStart,
      byteEnd: h.byteEnd,
    }));

    return {
      found: true,
      entityFound: true,
      contentFound: true,
      lookupMode: "anchored_query",
      artifactId,
      resourceType: "artifact",
      anchored: true,
      summary: `Found ${result.hits.length} match(es) in artifact`,
      hits,
      diagnostics: {
        plannerDegraded: false,
        durationMs: result.diagnostics.durationMs,
        selectedHitCount: hits.length,
        returnedBytes: result.diagnostics.returnedBytes,
        estimatedReturnedTokens: result.diagnostics.estimatedReturnedTokens,
        artifact: result.diagnostics,
      },
    };
  } catch {
    return {
      found: false,
      entityFound: true,
      contentFound: false,
      lookupMode: "anchored_query",
      resourceType: "artifact",
      anchored: true,
      reason: "failed",
      hits: [],
    };
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
      entityFound: true,
      contentFound: false,
      lookupMode: "exact_id",
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

function addSummary(result: PublicRecallResult, summary: string | undefined): PublicRecallResult {
  if (summary === undefined) return result;
  return { ...result, summary };
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
        return referenceFailure(ref.reason as NonResolvedReason, ref.type, "exact_id");
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
        return exactMemoryRead(memory, id, scopeContext);
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
        return referenceFailure(ref.reason as NonResolvedReason, ref.type, "anchored_query");
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
      try {
        if (retrieval === undefined && memory !== undefined) {
          const memResult = await memory.search(
            { text: query, limit: MAX_HITS, scopeContext },
            { ...(signal !== undefined ? { signal } : {}) },
          );
          const hits = buildHits(memResult);
          const summary = buildSummary(hits);
          const result = addSummary(
            {
              found: hits.length > 0,
              contentFound: hits.length > 0,
              lookupMode: "global_query",
              resourceType: "search",
              anchored: false,
              hits,
              diagnostics: {
                plannerDegraded: true,
                durationMs: memResult.diagnostics.durationMs,
                stages: memResult.diagnostics.stages,
                candidateCount: memResult.diagnostics.rankings?.rrf.length ?? memResult.hits.length,
                selectedHitCount: hits.length,
                returnedBytes: hits.reduce(
                  (total, hit) => total + Buffer.byteLength(hit.content, "utf8"),
                  0,
                ),
                estimatedReturnedTokens: hits.reduce(
                  (total, hit) => total + estimateModelTokens(hit.content),
                  0,
                ),
              },
            },
            summary,
          );
          return result;
        }

        if (retrieval === undefined) {
          return {
            found: false,
            contentFound: false,
            lookupMode: "global_query",
            resourceType: "search",
            anchored: false,
            hits: [],
          };
        }

        const retrievalQuery = {
          text: query,
          limit: 20,
          sources: ["knowledge", "memory"] as const,
          memoryScopes: [
            ...(scopeContext.repositoryId === undefined
              ? []
              : [{ kind: "repository" as const, id: scopeContext.repositoryId }]),
            ...(scopeContext.projectId === undefined
              ? []
              : [{ kind: "project" as const, id: scopeContext.projectId }]),
            ...(scopeContext.taskId === undefined
              ? []
              : [{ kind: "task" as const, id: scopeContext.taskId }]),
            { kind: "user" as const, id: scopeContext.userId },
            ...(scopeContext.topicIds ?? []).map((topicId) => ({
              kind: "topic" as const,
              id: topicId,
            })),
          ],
          memoryScopeContext: scopeContext,
          ...(contextSnapshot !== undefined ? { contextSnapshot } : {}),
        };
        const localResult = await retrieval.search(retrievalQuery, {
          ...(signal !== undefined ? { signal } : {}),
          allowRemoteEmbedding: false,
          allowRerank: false,
          timeoutMs: 750,
        });
        const hasLocalTextEvidence = localResult.hits.some((hit) => {
          const signals = hit.metadata?.["retrievalSignals"];
          return Array.isArray(signals) && signals.includes("fts");
        });
        const retrievalResult = hasLocalTextEvidence
          ? localResult
          : await retrieval.search(retrievalQuery, {
              ...(signal !== undefined ? { signal } : {}),
              allowRerank: true,
              timeoutMs: 3_000,
              softTimeoutMs: 1_800,
            });

        const hits = buildHits(retrievalResult);
        const summary = buildSummary(hits);
        const semanticPlan = retrievalResult.diagnostics.semanticQueryPlan;
        const result = addSummary(
          {
            found: hits.length > 0,
            contentFound: hits.length > 0,
            lookupMode: "global_query",
            resourceType: "search",
            anchored: false,
            hits,
            ...(retrievalResult.diagnostics.traceId === undefined
              ? {}
              : { traceId: retrievalResult.diagnostics.traceId }),
            diagnostics: {
              plannerDegraded: semanticPlan?.diagnostics?.plannerDegraded ?? true,
              durationMs: retrievalResult.diagnostics.durationMs,
              stages: retrievalResult.diagnostics.stages,
              candidateCount:
                retrievalResult.diagnostics.rankings?.rrf.length ?? retrievalResult.hits.length,
              selectedHitCount: hits.length,
              returnedBytes: hits.reduce(
                (total, hit) => total + Buffer.byteLength(hit.content, "utf8"),
                0,
              ),
              estimatedReturnedTokens: hits.reduce(
                (total, hit) => total + estimateModelTokens(hit.content),
                0,
              ),
              ...(semanticPlan === undefined
                ? {}
                : {
                    retrievalMode: semanticPlan.retrievalMode,
                    memoryNeed: semanticPlan.memoryNeed,
                  }),
            },
          },
          summary,
        );
        return result;
      } catch {
        return {
          found: false,
          contentFound: false,
          lookupMode: "global_query",
          resourceType: "search",
          anchored: false,
          hits: [],
        };
      }
    }

    // Both empty → error
    return { found: false, resourceType: "unknown", anchored: false, hits: [] };
  }
}
