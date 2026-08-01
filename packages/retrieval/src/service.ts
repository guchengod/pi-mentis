import {
  SearchTimeoutError,
  contentHash,
  type SearchHit,
  type SearchResult,
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
} from "@pi-mentis/pi-mentis-inference";
import type { KnowledgeService } from "@pi-mentis/pi-mentis-knowledge-core";
import type { MemoryQuery, MemoryService } from "@pi-mentis/pi-mentis-memory-core";
import { InMemoryTelemetry } from "@pi-mentis/pi-mentis-observability";

import {
  authorityAndFreshness,
  maximalMarginalRelevance,
  reciprocalRankFusion,
  selectContext,
} from "./algorithms.js";

export interface RetrievalQuery {
  readonly text: string;
  readonly namespace?: string;
  readonly memoryScopes?: MemoryQuery["scopes"];
  readonly memoryScopeContext?: MemoryQuery["scopeContext"];
  readonly limit?: number;
  readonly contextTokens?: number;
}

export interface RetrievalOptions {
  readonly signal?: AbortSignal;
  readonly traceId?: string;
  readonly timeoutMs?: number;
  readonly allowRerank?: boolean;
  readonly rerankRequired?: boolean;
  readonly softTimeoutMs?: number;
}

export interface RetrievalService {
  search(query: RetrievalQuery, options?: RetrievalOptions): Promise<SearchResult>;
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
    try {
      const knowledgeStarted = performance.now();
      const knowledgePromise =
        this.#knowledge === undefined
          ? Promise.resolve(undefined)
          : this.#knowledge.search(
              {
                text: query.text,
                ...(query.namespace === undefined ? {} : { namespace: query.namespace }),
                limit: this.#candidateLimit,
              },
              { signal, timeoutMs },
            );
      const knowledgeResult = await knowledgePromise.catch((error: unknown) => {
        degraded.push(`knowledge:${error instanceof Error ? error.name : "error"}`);
        return undefined;
      });
      stages["knowledge"] = performance.now() - knowledgeStarted;
      const guidance = knowledgeResult === undefined ? "" : extractGuidance(knowledgeResult.hits);
      const memoryStarted = performance.now();
      let memoryResult =
        this.#memory === undefined
          ? undefined
          : await this.#memory
              .search(
                {
                  text: guidance === "" ? query.text : `${query.text}\n${guidance}`,
                  ...(query.memoryScopes === undefined ? {} : { scopes: query.memoryScopes }),
                  ...(query.memoryScopeContext === undefined
                    ? {}
                    : { scopeContext: query.memoryScopeContext }),
                  limit: this.#candidateLimit,
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
                observedAt: Date.now(),
              },
              { signal },
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
      const fused = reciprocalRankFusion([
        ...(knowledgeResult === undefined ? [] : [{ weight: 1.1, hits: knowledgeResult.hits }]),
        ...(memoryResult === undefined ? [] : [{ weight: 1, hits: memoryResult.hits }]),
      ])
        .map((hit) => ({ ...hit, score: authorityAndFreshness(hit) }))
        .sort((left, right) => right.score - left.score)
        .slice(0, this.#candidateLimit);
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
      const diversified = maximalMarginalRelevance(ranked, query.limit ?? 20);
      const rerankRanking = ranked.map((hit) => hit.id);
      const mmrRanking = diversified.map((hit) => hit.id);
      const context = selectContext(
        diversified,
        query.contextTokens ?? 1_600,
        Math.min(1_100, query.contextTokens ?? 1_600),
        Math.min(500, query.contextTokens ?? 1_600),
      );
      return {
        hits: context,
        diagnostics: {
          durationMs: performance.now() - started,
          timedOut: controller.signal.aborted,
          degraded,
          stages,
          traceOrder: [
            ...(this.#knowledge === undefined ? [] : ["knowledge"]),
            ...(this.#memory === undefined ? [] : ["knowledge-guided-memory"]),
            ...(stages["knowledgeVerification"] === undefined ? [] : ["knowledge-verification"]),
            "rrf-authority",
            ...(stages["rerank"] === undefined ? [] : ["rerank"]),
            "mmr",
            "context-budget",
          ],
          rankings: {
            rrf: rrfRanking,
            rerank: rerankRanking,
            mmr: mmrRanking,
          },
          ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
        },
      };
    } finally {
      clearTimeout(timer);
    }
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
