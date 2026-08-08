import {
  EvidenceAuthority,
  SearchTimeoutError,
  contentHash,
  systemClock,
  type Clock,
  type SearchHit,
  type SearchResult,
  type MentisContextSnapshot,
} from "@pi-mentis/pi-mentis-core";
import {
  BoundedTtlCache,
  ConservativeUtf8TokenEstimator,
  createRerankBudget,
  normalizeBatchScores,
  planRerankBatches,
  rerankCacheKey,
  type RerankCacheValue,
  type RerankDocument,
  type RerankProvider,
  type EmbeddingProvider,
} from "@pi-mentis/pi-mentis-inference";
import type { KnowledgeService } from "@pi-mentis/pi-mentis-knowledge-core";
import type {
  MemoryQuery,
  MemoryService,
  PredicateRegistry,
} from "@pi-mentis/pi-mentis-memory-core";
import { InMemoryTelemetry } from "@pi-mentis/pi-mentis-observability";

import {
  authorityAndFreshness,
  maximalMarginalRelevance,
  maximalMarginalRelevanceWithTrace,
  reciprocalRankFusion,
  selectContext,
  structuralDedupe,
  type DiversityTraceEntry,
} from "./algorithms.js";
import { gateSearchHit, type GateRuntimeContext } from "./gates.js";
import { EffectivenessService, type TaskOutcomeObservation } from "./effectiveness.js";
import { AdaptivePolicyService } from "./policy.js";
import { adaptiveCutoff } from "./adaptive-cutoff.js";
import {
  FilePredicateVectorCache,
  SemanticQueryPlanner,
  type MemoryQueryPlan,
  type PredicateVectorCache,
} from "./semantic-query-planner.js";

export interface RetrievalQuery {
  readonly text: string;
  readonly namespace?: string;
  readonly memoryScopes?: MemoryQuery["scopes"];
  readonly memoryScopeContext?: MemoryQuery["scopeContext"];
  readonly limit?: number;
  readonly contextTokens?: number;
  readonly temporalMode?: "current" | "historical" | "all";
  readonly contextSnapshot?: MentisContextSnapshot;
  readonly gateContext?: Omit<GateRuntimeContext, "scope" | "snapshot" | "historical">;
  readonly sources?: readonly ("knowledge" | "memory")[];
}

export interface RetrievalOptions {
  readonly signal?: AbortSignal;
  readonly traceId?: string;
  readonly timeoutMs?: number;
  readonly allowRerank?: boolean;
  readonly rerankRequired?: boolean;
  readonly softTimeoutMs?: number;
  readonly onTrace?: (traceId: string) => void;
}

export interface RetrievalService {
  search(query: RetrievalQuery, options?: RetrievalOptions): Promise<SearchResult>;
  recordOutcome?(namespace: string, outcome: TaskOutcomeObservation): Promise<void>;
  flush?(): Promise<void>;
  /**
   * Background warmup of semantic indices (predicate vectors). Non-blocking.
   * Call during session startup so the first search does not stall on a
   * cache-miss remote embedding.
   */
  warmup?(): void;
}

export interface CreateRetrievalServiceOptions {
  readonly knowledge?: KnowledgeService;
  readonly memory?: MemoryService;
  readonly reranker?: RerankProvider;
  readonly rerankModel: string;
  readonly rerankContextTokens: number;
  readonly rerankCandidateLimit?: number;
  readonly rerankCacheEntries?: number;
  readonly rerankCacheTtlMs?: number;
  readonly telemetry?: InMemoryTelemetry;
  readonly effectiveness?: EffectivenessService;
  readonly policy?: AdaptivePolicyService;
  readonly clock?: Clock;
  readonly embedding?: EmbeddingProvider;
  readonly embeddingModel?: string;
  readonly embeddingDimensions?: number;
  readonly predicateRegistry?: PredicateRegistry;
  readonly predicateVectorCache?: PredicateVectorCache;
  readonly predicateCacheFile?: string;
  readonly semanticPlanner?: SemanticQueryPlanner;
}

function fallbackPlan(): MemoryQueryPlan {
  return {
    predicateCandidates: [],
    subjectCandidates: [],
    temporalIntent: "any",
    retrievalMode: "broad",
    confidence: 0,
    memoryNeed: { required: true, confidence: 0 },
    diagnostics: { plannerDegraded: true },
  };
}

function predicatePrior(hit: SearchHit, plan: MemoryQueryPlan): number {
  if (hit.kind !== "memory") return 0;
  const factKey = hit.metadata?.["factKey"];
  if (typeof factKey !== "string") return 0;
  // Group keys are `domain:subject/predicate`; member keys add a member
  // segment (`domain:subject/predicate/member`). The predicate is always
  // the segment right after the subject.
  const segments = factKey.split("/");
  const predicate = segments.length >= 2 ? segments[1] : undefined;
  if (predicate === undefined) return 0;
  return (
    plan.predicateCandidates.find((candidate) => candidate.predicate === predicate)?.confidence ?? 0
  );
}

export function applyPredicateSoftPrior(
  hit: SearchHit,
  plan: MemoryQueryPlan,
  now: number,
  freshness: number,
): SearchHit {
  const base = authorityAndFreshness(hit, now, freshness);
  const prior = predicatePrior(hit, plan);
  return {
    ...hit,
    score: base * 0.84 + prior * 0.16,
    metadata: {
      ...(hit.metadata ?? {}),
      recallScoreComponents: {
        fused: hit.score,
        authorityFreshness: base,
        predicatePrior: prior,
      },
    },
  };
}

function extractGuidance(hits: readonly SearchHit[]): string {
  const terms = new Set<string>();
  for (const hit of hits.slice(0, 8)) {
    for (const match of hit.text.matchAll(
      /(?:@[a-z0-9_-]+\/[a-z0-9_-]+|\/?[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+|[A-Za-z_$][\w$]*\([^)]*\))/g,
    )) {
      if (match[0].length <= 120) terms.add(match[0]);
    }
  }
  return [...terms].slice(0, 12).join(" ");
}

function semanticVersions(text: string): ReadonlySet<string> {
  return new Set([...text.matchAll(/\bv?(\d+\.\d+\.\d+)\b/gi)].map((match) => match[1] ?? ""));
}

function versionsConflict(knowledge: SearchHit, memory: SearchHit): boolean {
  const current = semanticVersions(knowledge.text);
  const historical = semanticVersions(memory.text);
  return (
    current.size > 0 &&
    historical.size > 0 &&
    [...current].every((version) => !historical.has(version))
  );
}

export class DefaultRetrievalService implements RetrievalService {
  readonly #knowledge: KnowledgeService | undefined;
  readonly #memory: MemoryService | undefined;
  readonly #reranker: RerankProvider | undefined;
  readonly #rerankModel: string;
  readonly #rerankContextTokens: number;
  readonly #candidateLimit: number;
  readonly #rerankCache: BoundedTtlCache<RerankCacheValue>;
  readonly #telemetry: InMemoryTelemetry;
  readonly #estimator = new ConservativeUtf8TokenEstimator();
  readonly #effectiveness: EffectivenessService | undefined;
  readonly #policy: AdaptivePolicyService | undefined;
  readonly #clock: Clock;
  readonly #semanticPlanner: SemanticQueryPlanner | undefined;

  constructor(options: CreateRetrievalServiceOptions) {
    this.#knowledge = options.knowledge;
    this.#memory = options.memory;
    this.#reranker = options.reranker;
    this.#rerankModel = options.rerankModel;
    this.#rerankContextTokens = options.rerankContextTokens;
    this.#candidateLimit = options.rerankCandidateLimit ?? 40;
    this.#rerankCache = new BoundedTtlCache(
      options.rerankCacheEntries ?? 256,
      options.rerankCacheTtlMs ?? 60_000,
    );
    this.#telemetry = options.telemetry ?? new InMemoryTelemetry();
    this.#effectiveness = options.effectiveness;
    this.#policy = options.policy;
    this.#clock = options.clock ?? systemClock;
    const vectorCache =
      options.predicateVectorCache ??
      (options.predicateCacheFile === undefined
        ? undefined
        : new FilePredicateVectorCache(options.predicateCacheFile));
    this.#semanticPlanner =
      options.semanticPlanner ??
      (options.embedding === undefined ||
      options.embeddingModel === undefined ||
      options.embeddingDimensions === undefined
        ? undefined
        : new SemanticQueryPlanner({
            embedding: options.embedding,
            modelId: options.embeddingModel,
            dimensions: options.embeddingDimensions,
            ...(options.predicateRegistry === undefined
              ? {}
              : { registry: options.predicateRegistry }),
            ...(vectorCache === undefined ? {} : { cache: vectorCache }),
          }));
  }

  warmup(): void {
    this.#semanticPlanner?.warmup();
  }

  async search(query: RetrievalQuery, options: RetrievalOptions = {}): Promise<SearchResult> {
    const started = performance.now();
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? 3_000;
    const timer = setTimeout(
      () => controller.abort(new SearchTimeoutError(`Retrieval exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
    const signal =
      options.signal === undefined
        ? controller.signal
        : AbortSignal.any([options.signal, controller.signal]);
    const degraded: string[] = [];
    const stages: Record<string, number> = {};
    const plannerStarted = performance.now();
    const prepared =
      this.#semanticPlanner === undefined
        ? { plan: fallbackPlan() }
        : await this.#semanticPlanner.prepare(query.text, { signal });
    const queryPlan = prepared.plan;
    const queryEmbedding = prepared.queryEmbedding;
    stages["semanticPlanner"] = performance.now() - plannerStarted;
    if (queryPlan.diagnostics?.plannerDegraded === true) degraded.push("planner:degraded");
    const sourceSet = new Set(query.sources ?? ["knowledge", "memory"]);
    const activePolicy = this.#policy?.forRequest(
      `${query.text}:${query.memoryScopeContext?.sessionId ?? "session"}`,
    );
    const policyCandidateLimit =
      activePolicy?.parameters.rerankCandidateLimit ?? this.#candidateLimit;
    const candidateLimit = Math.min(this.#candidateLimit, policyCandidateLimit);
    try {
      const knowledgeStarted = performance.now();
      const knowledgePromise =
        this.#knowledge === undefined || !sourceSet.has("knowledge")
          ? Promise.resolve(undefined)
          : this.#knowledge.search(
              {
                text: query.text,
                ...(queryEmbedding === undefined ? {} : { queryEmbedding }),
                ...(query.namespace === undefined ? {} : { namespace: query.namespace }),
                ...(query.memoryScopeContext === undefined
                  ? {}
                  : { scopeContext: query.memoryScopeContext }),
                limit: candidateLimit,
              },
              { signal, timeoutMs },
            );
      const knowledgeResult = await knowledgePromise.catch((error: unknown) => {
        degraded.push(`knowledge:${error instanceof Error ? error.name : "error"}`);
        return undefined;
      });
      stages["knowledge"] = performance.now() - knowledgeStarted;
      const viewStarted = performance.now();
      const viewHits: SearchHit[] = [];
      if (
        this.#memory?.getView !== undefined &&
        sourceSet.has("memory") &&
        queryPlan.memoryNeed.required &&
        query.memoryScopes !== undefined
      ) {
        const supported = new Set(["project", "user", "topic", "task", "capability"]);
        const views = await Promise.all(
          query.memoryScopes
            .filter((scope) => supported.has(scope.kind))
            .map((scope) =>
              this.#memory
                ?.getView?.(
                  scope.kind as "project" | "user" | "topic" | "task" | "capability",
                  scope.id,
                  query.memoryScopeContext,
                )
                .catch(() => undefined),
            ),
        );
        for (const view of views) {
          if (view === undefined || view.memberMemoryIds.length === 0) continue;
          const text = Object.values(view.facts)
            .filter((fact) => fact.currentMemoryIds.length > 0)
            .map((fact) => {
              const values = fact.currentMemoryIds.map(
                (memoryId) => fact.values?.[memoryId] ?? fact.value,
              );
              return `${fact.factKey}: ${
                values.length > 1 ? `CONFLICT [${values.join(" | ")}]` : values[0]
              }`;
            })
            .join("\n");
          if (text === "") continue;
          viewHits.push({
            id: view.id,
            kind: "memory",
            text,
            score: 1,
            tokenCount: Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4)),
            authority: Math.max(
              EvidenceAuthority.HistoricalSummary,
              ...Object.values(view.facts).map((fact) => fact.authority),
            ) as SearchHit["authority"],
            namespace: view.namespace,
            contentHash: contentHash(text),
            metadata: {
              derivedView: true,
              viewKind: view.kind,
              viewRevision: view.revision,
              memberMemoryIds: view.memberMemoryIds,
              state: view.state,
              updatedAt: view.updatedAt,
            },
          });
        }
      }
      stages["views"] = performance.now() - viewStarted;
      const guidance = knowledgeResult === undefined ? "" : extractGuidance(knowledgeResult.hits);
      const memoryStarted = performance.now();
      let memoryResult =
        this.#memory === undefined || !sourceSet.has("memory") || !queryPlan.memoryNeed.required
          ? undefined
          : await this.#memory
              .search(
                {
                  text: guidance === "" ? query.text : `${query.text}\n${guidance}`,
                  ...(queryEmbedding === undefined ? {} : { queryEmbedding }),
                  ...(query.memoryScopes === undefined ? {} : { scopes: query.memoryScopes }),
                  ...(query.memoryScopeContext === undefined
                    ? {}
                    : { scopeContext: query.memoryScopeContext }),
                  ...(query.temporalMode !== undefined
                    ? { temporalMode: query.temporalMode }
                    : queryPlan.temporalIntent === "current"
                      ? { temporalMode: "current" as const }
                      : queryPlan.temporalIntent === "historical"
                        ? { temporalMode: "historical" as const }
                        : queryPlan.temporalIntent === "evolution"
                          ? { temporalMode: "all" as const }
                          : {}),
                  limit: candidateLimit,
                },
                { signal, timeoutMs },
              )
              .catch((error: unknown) => {
                degraded.push(`memory:${error instanceof Error ? error.name : "error"}`);
                return undefined;
              });
      stages["memory"] = performance.now() - memoryStarted;
      if (
        knowledgeResult !== undefined &&
        memoryResult !== undefined &&
        this.#memory?.markConflicted !== undefined
      ) {
        const verificationStarted = performance.now();
        const verifiedHits = await Promise.all(
          memoryResult.hits.map(async (memoryHit) => {
            const conflictingKnowledge = knowledgeResult.hits.find((knowledgeHit) =>
              versionsConflict(knowledgeHit, memoryHit),
            );
            if (conflictingKnowledge === undefined) return memoryHit;
            const record = await this.#memory?.markConflicted?.(
              memoryHit.id,
              {
                kind: "knowledge",
                id: conflictingKnowledge.id,
                observedAt: this.#clock.now(),
              },
              {
                signal,
                scopeContext: query.memoryScopeContext ?? {
                  tenantId: "local",
                  userId: "local",
                  appId: "pi",
                  agentId: "pi-mentis",
                },
              },
            );
            return record === undefined
              ? memoryHit
              : {
                  ...memoryHit,
                  metadata: record,
                };
          }),
        );
        memoryResult = { ...memoryResult, hits: verifiedHits };
        stages["knowledgeVerification"] = performance.now() - verificationStarted;
      }
      const fusedBeforeGate = reciprocalRankFusion([
        ...(viewHits.length === 0 ? [] : [{ weight: 1.2, hits: viewHits }]),
        ...(knowledgeResult === undefined ? [] : [{ weight: 1.1, hits: knowledgeResult.hits }]),
        ...(memoryResult === undefined ? [] : [{ weight: 1, hits: memoryResult.hits }]),
      ]);
      const scope = query.memoryScopeContext ?? {
        tenantId: "local",
        userId: "local",
        appId: "pi",
        agentId: "pi-mentis",
      };
      const gateRuntime: GateRuntimeContext = {
        scope,
        ...(query.contextSnapshot === undefined ? {} : { snapshot: query.contextSnapshot }),
        ...(query.gateContext ?? {}),
        historical: query.temporalMode === "historical" || query.temporalMode === "all",
      };
      const rejectedIds: string[] = [];
      const rejectionReasons: Record<string, readonly string[]> = {};
      const fused = fusedBeforeGate
        .flatMap((hit) => {
          const decision = gateSearchHit(hit, gateRuntime);
          if (
            !decision.allowed ||
            hit.authority < (activePolicy?.parameters.minimumAuthority ?? 0)
          ) {
            rejectedIds.push(hit.id);
            rejectionReasons[hit.id] = decision.allowed
              ? ["policy:minimum-authority"]
              : decision.reasons;
            return [];
          }
          return [
            {
              ...hit,
              score:
                hit.score *
                Math.max(
                  0,
                  1 +
                    (decision.scoreMultiplier - 1) * (activePolicy?.parameters.affinityWeight ?? 1),
                ),
              metadata: {
                ...(hit.metadata ?? {}),
                gate: {
                  reasons: decision.reasons,
                  uncheckedPremises: decision.uncheckedPremises,
                  instructionSafe: decision.instructionSafe,
                },
              },
            },
          ];
        })
        .map((hit) =>
          applyPredicateSoftPrior(
            hit,
            queryPlan,
            this.#clock.now(),
            activePolicy?.parameters.freshnessWeight ?? 0.1,
          ),
        )
        .sort((left, right) => right.score - left.score)
        .slice(0, candidateLimit);
      const rrfRanking = fused.map((hit) => hit.id);
      let ranked: readonly SearchHit[] = fused;
      if (this.#reranker === undefined && options.allowRerank !== false && fused.length > 1) {
        degraded.push("rerank:unavailable");
      }
      if (
        this.#reranker !== undefined &&
        options.allowRerank !== false &&
        performance.now() - started < (options.softTimeoutMs ?? Number.POSITIVE_INFINITY) &&
        fused.length > 1
      ) {
        const rerankStarted = performance.now();
        try {
          ranked = await this.#rerank(query.text, fused, signal);
        } catch (error: unknown) {
          degraded.push(`rerank:${error instanceof Error ? error.name : "error"}`);
          this.#telemetry.record("rerank_fallback_count", 1);
          if (options.rerankRequired === true) throw error;
        }
        stages["rerank"] = performance.now() - rerankStarted;
      }
      // Structural fact identity is decided BEFORE diversity: collapse
      // duplicate/version candidates per member identity, then run the
      // set-aware diversity selection. Set siblings (same predicate group,
      // different setMemberKey) are distinct facts and are never suppressed
      // for content similarity — MMR only optimizes representational
      // diversity among otherwise-unrelated candidates.
      const deduped = structuralDedupe(ranked);
      const cutoff = adaptiveCutoff({ hits: deduped, mode: queryPlan.retrievalMode });
      const diversityTrace: DiversityTraceEntry[] = [];
      const diversified = maximalMarginalRelevanceWithTrace(
        cutoff,
        Math.min(
          query.limit ?? activePolicy?.parameters.topK ?? 20,
          activePolicy?.parameters.topK ?? query.limit ?? 20,
        ),
        activePolicy?.parameters.diversityLambda ?? 0.75,
        { onTrace: (entry) => diversityTrace.push(entry) },
      );
      const rerankRanking = ranked.map((hit) => hit.id);
      const mmrRanking = diversified.map((hit) => hit.id);
      const policyContextTokens = activePolicy?.parameters.contextTokens ?? 1_600;
      const contextTokenLimit = Math.min(
        query.contextTokens ?? policyContextTokens,
        policyContextTokens,
      );
      const selectedContext = selectContext(
        diversified,
        contextTokenLimit,
        Math.min(1_100, contextTokenLimit),
        Math.min(500, contextTokenLimit),
      );
      const selectedIds = new Set(selectedContext.map((hit) => hit.id));
      const context = diversified.filter((hit) => selectedIds.has(hit.id));
      const traceId = options.traceId ?? `trace:${contentHash(`${query.text}:${started}`)}`;
      options.onTrace?.(traceId);
      const namespace = [scope.tenantId, scope.userId, scope.appId, scope.agentId]
        .map(encodeURIComponent)
        .join(":");
      this.#effectiveness?.recordRetrieval({
        namespace,
        traceId,
        query: query.text,
        ...(query.contextSnapshot?.id === undefined
          ? {}
          : { contextSnapshotId: query.contextSnapshot.id }),
        hits: context,
        candidateHits: ranked,
        rejectedIds,
        rejectionReasons,
        durationMs: performance.now() - started,
        stages,
        policyId: activePolicy?.id ?? "policy:default",
      });
      const shadow = this.#policy?.shadow();
      if (shadow !== undefined) {
        const shadowHits = fusedBeforeGate
          .flatMap((hit) => {
            const decision = gateSearchHit(hit, gateRuntime);
            if (!decision.allowed || hit.authority < shadow.parameters.minimumAuthority) return [];
            const adjusted = {
              ...hit,
              score:
                hit.score *
                Math.max(0, 1 + (decision.scoreMultiplier - 1) * shadow.parameters.affinityWeight),
            };
            return [
              {
                ...adjusted,
                score: authorityAndFreshness(
                  adjusted,
                  this.#clock.now(),
                  shadow.parameters.freshnessWeight,
                ),
              },
            ];
          })
          .sort((left, right) => right.score - left.score);
        const shadowSelected = maximalMarginalRelevance(
          shadowHits,
          shadow.parameters.topK,
          shadow.parameters.diversityLambda,
        );
        this.#effectiveness?.recordRetrieval({
          namespace,
          traceId: `${traceId}:shadow:${shadow.id}`,
          query: query.text,
          ...(query.contextSnapshot?.id === undefined
            ? {}
            : { contextSnapshotId: query.contextSnapshot.id }),
          hits: shadowSelected,
          candidateHits: shadowHits,
          rejectedIds: fusedBeforeGate
            .filter((hit) => !shadowSelected.some((selected) => selected.id === hit.id))
            .map((hit) => hit.id),
          durationMs: performance.now() - started,
          stages,
          policyId: shadow.id,
        });
      }
      return {
        hits: context,
        diagnostics: {
          durationMs: performance.now() - started,
          timedOut: controller.signal.aborted,
          degraded,
          stages,
          traceOrder: [
            ...(this.#knowledge === undefined ? [] : ["knowledge"]),
            ...(viewHits.length === 0 ? [] : ["state-views"]),
            ...(this.#memory === undefined ? [] : ["knowledge-guided-memory"]),
            ...(stages["knowledgeVerification"] === undefined ? [] : ["knowledge-verification"]),
            "rrf",
            "applicability-gates",
            "authority-freshness",
            "predicate-soft-prior",
            ...(stages["rerank"] === undefined ? [] : ["rerank"]),
            "structural-dedup",
            "adaptive-cutoff",
            "set-aware-mmr",
            "context-budget",
          ],
          rankings: {
            rrf: rrfRanking,
            rerank: rerankRanking,
            mmr: mmrRanking,
          },
          diversity: diversityTrace,
          traceId,
          semanticQueryPlan: queryPlan,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async recordOutcome(namespace: string, outcome: TaskOutcomeObservation): Promise<void> {
    await this.#effectiveness?.recordOutcome(namespace, outcome);
  }

  async flush(): Promise<void> {
    await this.#effectiveness?.flush();
  }

  async #rerank(
    query: string,
    hits: readonly SearchHit[],
    signal: AbortSignal,
  ): Promise<readonly SearchHit[]> {
    if (this.#reranker === undefined) return hits;
    const documents: RerankDocument[] = hits.map((hit) => ({
      id: hit.id,
      text: hit.text,
      tokenCount: hit.tokenCount,
      metadata: { kind: hit.kind, authority: hit.authority },
    }));
    const capabilities = await this.#reranker.capabilities();
    const supportsInstruction =
      capabilities.models.find((model) => model.model.modelId === this.#rerankModel)
        ?.supportsInstruction ?? false;
    const instruction = supportsInstruction
      ? "Rank evidence for accurately answering the query."
      : undefined;
    const cacheKey = rerankCacheKey({
      providerId: this.#reranker.id,
      modelId: this.#rerankModel,
      queryHash: contentHash(query),
      orderedDocumentContentHashes: hits.map((hit) => hit.contentHash),
      instructionHash: contentHash(instruction ?? ""),
      topN: hits.length,
      modelCapabilityVersion: "1",
    });
    const cached = this.#rerankCache.get(cacheKey);
    if (cached !== undefined) return this.#applyRerank(hits, cached);
    const budget = createRerankBudget(query, instruction, this.#estimator, {
      modelContextTokens: this.#rerankContextTokens,
    });
    const batches = planRerankBatches(documents, budget, this.#estimator);
    const firstRound = await Promise.all(
      batches.map(async (batch) => {
        const response = await this.#reranker?.rerank(
          {
            query,
            documents: batch.documents,
            topN: Math.min(10, batch.documents.length),
            ...(instruction === undefined ? {} : { instruction }),
            maxInputTokens: this.#rerankContextTokens,
          },
          { signal, priority: "interactive" },
        );
        return response?.items ?? [];
      }),
    );
    let items = firstRound.flat();
    if (batches.length > 1) {
      const winnersById = new Map(hits.map((hit) => [hit.id, hit]));
      const winnerDocuments = items.flatMap((item) => {
        const hit = winnersById.get(item.documentId);
        return hit === undefined
          ? []
          : [{ id: hit.id, text: hit.text, tokenCount: hit.tokenCount }];
      });
      const finalBatches = planRerankBatches(winnerDocuments, budget, this.#estimator);
      if (finalBatches.length === 1 && finalBatches[0] !== undefined) {
        const final = await this.#reranker.rerank(
          {
            query,
            documents: finalBatches[0].documents,
            topN: finalBatches[0].documents.length,
            ...(instruction === undefined ? {} : { instruction }),
            maxInputTokens: this.#rerankContextTokens,
          },
          { signal, priority: "interactive" },
        );
        items = [...final.items];
      } else {
        const normalized = normalizeBatchScores(firstRound);
        items = [...normalized.entries()].map(([documentId, relevanceScore]) => ({
          documentId,
          originalIndex: hits.findIndex((hit) => hit.id === documentId),
          relevanceScore,
        }));
      }
    }
    this.#rerankCache.set(cacheKey, items);
    return this.#applyRerank(hits, items);
  }

  #applyRerank(hits: readonly SearchHit[], items: RerankCacheValue): readonly SearchHit[] {
    const scores = new Map(items.map((item) => [item.documentId, item.relevanceScore]));
    return [...hits]
      .map((hit) => ({
        ...hit,
        score: (scores.get(hit.id) ?? 0) * 0.7 + hit.score * 0.3,
      }))
      .sort((left, right) => right.score - left.score);
  }
}

export function createRetrievalService(options: CreateRetrievalServiceOptions): RetrievalService {
  return new DefaultRetrievalService(options);
}
