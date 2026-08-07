/**
 * traceRecallTarget — Debug/test-only utility for end-to-end recall pipeline diagnosis.
 *
 * Traces a target memory ID through every stage of the retrieval pipeline,
 * reporting presence, rank, score, and the first stage where the target
 * disappears from results.
 *
 * This is NOT for production use. It may access internal service details.
 */

import { type SearchHit, type SearchResult } from "@pi-mentis/pi-mentis-core";
import type { MemoryService, PiScopeContext } from "@pi-mentis/pi-mentis-memory-core";
import type { RetrievalService } from "./service.js";

export interface RecallTargetStage {
  readonly stage: string;
  readonly present: boolean;
  readonly rank?: number;
  readonly rawScore?: number;
  readonly normalizedScore?: number;
  readonly reason?: string;
}

export interface RecallTargetTrace {
  readonly targetId: string;
  readonly query: string;
  readonly stages: readonly RecallTargetStage[];
}

export interface TraceRecallTargetOptions {
  readonly query: string;
  readonly targetId: string;
  readonly memory: MemoryService;
  readonly retrieval?: RetrievalService;
  readonly scopeContext?: PiScopeContext;
  readonly signal?: AbortSignal;
}

function findHit(
  hits: readonly SearchHit[],
  targetId: string,
): { readonly rank: number; readonly score: number } | undefined {
  for (let index = 0; index < hits.length; index++) {
    const hit = hits[index];
    if (hit === undefined) continue;
    if (hit.id === targetId) {
      return { rank: index + 1, score: hit.score };
    }
  }
  return undefined;
}

function findInResult(
  result: SearchResult,
  targetId: string,
): { readonly rank: number; readonly score: number } | undefined {
  return findHit(result.hits, targetId);
}

function stage(
  stageName: string,
  found: { readonly rank: number; readonly score: number } | undefined,
  reasonText?: string,
): RecallTargetStage {
  if (found === undefined) {
    return {
      stage: stageName,
      present: false,
      ...(reasonText === undefined ? {} : { reason: reasonText }),
    };
  }
  return {
    stage: stageName,
    present: true,
    rank: found.rank,
    rawScore: found.score,
    ...(reasonText === undefined ? {} : { reason: reasonText }),
  };
}

const DEFAULT_CONTEXT: PiScopeContext = {
  tenantId: "local",
  userId: "local",
  appId: "pi",
  agentId: "pi-mentis",
};

export async function traceRecallTarget(
  options: TraceRecallTargetOptions,
): Promise<RecallTargetTrace> {
  const { query, targetId, memory, retrieval, scopeContext, signal } = options;
  const stages: RecallTargetStage[] = [];
  const ctx = scopeContext ?? DEFAULT_CONTEXT;

  // ── Stage 1: Primary Store ──
  const record = await memory.get(targetId, {
    scopeContext: ctx,
    accessIntent: "explicit_id",
    ...(signal === undefined ? {} : { signal }),
  });
  stages.push({
    stage: "primary_store",
    present: record !== undefined,
    ...(record === undefined
      ? { reason: "Record not found in primary store — indexing failure or tombstone" }
      : { reason: `status=${record.status} kind=${record.scope.kind}` }),
  });
  if (record === undefined) {
    return { targetId, query, stages };
  }

  const searchOpts = signal === undefined ? { timeoutMs: 5_000 } : { signal, timeoutMs: 5_000 };

  // ── Stage 2: FTS / lexical candidate generation ──
  // Search without scope restriction to test raw FTS reachability.
  const ftsResult = await memory.search(
    {
      text: query,
      limit: 100,
      scopeContext: ctx,
    },
    searchOpts,
  );
  stages.push(stage("fts_candidates", findInResult(ftsResult, targetId),
    "Target not found in raw FTS/lexical search — check FTS index, tokenization, searchable_text field"));

  // ── Stage 3: Dense / vector candidate generation ──
  const recordKind = record.scope.kind;
  const recordScopeId = record.scope.id;
  const scopedResult = await memory.search(
    {
      text: query,
      limit: 100,
      scopeContext: ctx,
      scopes: [{ kind: recordKind, id: recordScopeId }],
    },
    searchOpts,
  );
  stages.push(stage("dense_candidates", findInResult(scopedResult, targetId),
    "Target not found in scope-targeted search — check embedding presence, dimension match, namespace"));

  // ── Stage 4: Memory-level hybrid fusion (scoped) ──
  const memoResult = await memory.search(
    {
      text: query,
      limit: 20,
      scopeContext: ctx,
      scopes: [{ kind: recordKind, id: recordScopeId }],
    },
    searchOpts,
  );
  stages.push(stage("memory_hybrid_fusion", findInResult(memoResult, targetId),
    "Target lost in memory-level RRF fusion — FTS and Dense both missing or scores too low"));

  // ── Stage 5: Full retrieval pipeline (if available) ──
  if (retrieval !== undefined) {
    const retrievalOpts = {
      ...(signal === undefined ? {} : { signal }),
      allowRerank: true as const,
      timeoutMs: 10_000,
    };
    const retrievalResult = await retrieval.search(
      {
        text: query,
        limit: 20,
        sources: ["memory"] as const,
        memoryScopeContext: ctx,
        memoryScopes: [{ kind: recordKind, id: recordScopeId }],
      },
      retrievalOpts,
    );

    const retrievalFound = findInResult(retrievalResult, targetId);
    stages.push(stage("retrieval_full", retrievalFound,
      "Target lost in full retrieval pipeline (gate, rerank, cutoff, MMR, context budget)"));

    const rankings = retrievalResult.diagnostics.rankings;
    if (rankings !== undefined) {
      const rrfRank = rankings.rrf === undefined ? -1 : rankings.rrf.indexOf(targetId);
      stages.push({
        stage: "rrf_ranking",
        present: rrfRank >= 0,
        ...(rrfRank >= 0 ? { rank: rrfRank + 1, reason: `RRF rank ${rrfRank + 1}` } : {}),
        ...(rrfRank < 0
          ? { reason: "Target not in RRF ranking — lost before fusion (memory/knowledge/views)" }
          : {}),
      });

      const rerankRank = rankings.rerank === undefined ? -1 : rankings.rerank.indexOf(targetId);
      stages.push({
        stage: "rerank_ranking",
        present: rerankRank >= 0,
        ...(rerankRank >= 0 ? { rank: rerankRank + 1, reason: `Rerank rank ${rerankRank + 1}` } : {}),
        ...(rerankRank < 0
          ? { reason: "Target not in reranker output — reranker downgraded target" }
          : {}),
      });

      const mmrRank = rankings.mmr === undefined ? -1 : rankings.mmr.indexOf(targetId);
      stages.push({
        stage: "mmr_ranking",
        present: mmrRank >= 0,
        ...(mmrRank >= 0 ? { rank: mmrRank + 1, reason: `MMR rank ${mmrRank + 1}` } : {}),
        ...(mmrRank < 0
          ? { reason: "Target not in MMR output — removed for diversity or already filtered" }
          : {}),
      });
    }

    stages.push({
      stage: "final_hits",
      present: retrievalFound !== undefined,
      ...(retrievalFound !== undefined
        ? { rank: retrievalFound.rank, reason: `Final rank ${retrievalFound.rank}` }
        : {
            reason:
              "Target absent from final hits — scope filtering, gate rejection, or cutoff eliminated target",
          }),
    });
  } else {
    stages.push({
      stage: "retrieval_full",
      present: false,
      reason: "Retrieval service not available for full pipeline trace",
    });
  }

  // ── Compute first disappearance stage ──
  const firstMissing = stages.find((s) => !s.present);
  if (firstMissing !== undefined) {
    stages.push({
      stage: "first_disappeared",
      present: false,
      reason: `Target ID ${targetId} first disappeared at stage: ${firstMissing.stage}`,
    });
  } else {
    stages.push({
      stage: "first_disappeared",
      present: true,
      reason: `Target ID ${targetId} survived all stages`,
    });
  }

  return { targetId, query, stages };
}
