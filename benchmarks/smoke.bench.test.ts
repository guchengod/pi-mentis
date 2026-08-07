import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { EvidenceAuthority, contentHash } from "@pi-mentis/pi-mentis-core";
import {
  ConservativeUtf8TokenEstimator,
  createRerankBudget,
  planRerankBatches,
} from "@pi-mentis/pi-mentis-inference";
import { DEFAULT_PREDICATE_REGISTRY } from "@pi-mentis/pi-mentis-memory-core";
import {
  InMemoryPredicateSemanticIndex,
  adaptiveCutoff,
  inferRetrievalMode,
  reciprocalRankFusion,
} from "@pi-mentis/pi-mentis-retrieval";

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

describe("performance smoke", () => {
  it("measures 10k local fusion, dimension memory, budget planning, and event-loop lag", async () => {
    const hits = Array.from({ length: 10_000 }, (_, index) => ({
      id: `chunk-${index}`,
      kind: "knowledge" as const,
      text: `chunk ${index}`,
      score: 1 / (index + 1),
      tokenCount: 4,
      authority: EvidenceAuthority.UserKnowledge,
      namespace: "benchmark",
      contentHash: contentHash(String(index)),
    }));
    const lag = monitorEventLoopDelay({ resolution: 10 });
    lag.enable();
    const fusionStarted = performance.now();
    const fused = reciprocalRankFusion([
      { weight: 1, hits },
      { weight: 0.9, hits: [...hits].reverse() },
    ]);
    const fusionMs = performance.now() - fusionStarted;
    const estimator = new ConservativeUtf8TokenEstimator();
    const budgets = [8192, 16384, 32768].map((modelContextTokens) => {
      const started = performance.now();
      const budget = createRerankBudget("query", "rank evidence", estimator, {
        modelContextTokens,
      });
      const batches = planRerankBatches(
        hits.slice(0, 100).map((hit) => ({ id: hit.id, text: hit.text.repeat(40) })),
        budget,
        estimator,
      );
      return {
        modelContextTokens,
        batches: batches.length,
        durationMs: performance.now() - started,
      };
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    lag.disable();
    const dimensions = [768, 1024, 1536, 2048, 4096].map((value) => ({
      dimensions: value,
      bytesPerVector: value * Float32Array.BYTES_PER_ELEMENT,
      bytesFor100kVectors: value * Float32Array.BYTES_PER_ELEMENT * 100_000,
    }));
    const predicateDimensions = 1024;
    const predicateIndex = new InMemoryPredicateSemanticIndex(
      DEFAULT_PREDICATE_REGISTRY.list().map((definition, predicateIndex) => ({
        predicate: definition.id,
        vector: Float32Array.from({ length: predicateDimensions }, (_, dimension) =>
          Math.sin((predicateIndex + 1) * (dimension + 1)),
        ),
      })),
    );
    const predicateQuery = Float32Array.from({ length: predicateDimensions }, (_, dimension) =>
      Math.cos(dimension + 1),
    );
    const predicateRoutingSamples: number[] = [];
    const cutoffSamples: number[] = [];
    const cutoffHits = Array.from({ length: 40 }, (_, index) => ({
      id: `predicate-hit-${index}`,
      kind: "memory" as const,
      text: `predicate hit ${index}`,
      score: Math.max(0.01, 0.95 - index * 0.025),
      tokenCount: 4,
      authority: EvidenceAuthority.UserKnowledge,
      namespace: "benchmark",
      contentHash: contentHash(`predicate-hit-${index}`),
    }));
    for (let iteration = 0; iteration < 300; iteration++) {
      const routingStarted = performance.now();
      inferRetrievalMode(predicateIndex.rank(predicateQuery));
      predicateRoutingSamples.push(performance.now() - routingStarted);
      const cutoffStarted = performance.now();
      adaptiveCutoff({ hits: cutoffHits, mode: iteration % 2 === 0 ? "focused" : "broad" });
      cutoffSamples.push(performance.now() - cutoffStarted);
    }
    const report = {
      generatedAt: new Date().toISOString(),
      local: {
        chunkCount: hits.length,
        rrfFusionMs: fusionMs,
        fusedCount: fused.length,
        eventLoopP95LagMs: lag.percentile(95) / 1e6,
      },
      zvec: { measured: false, reason: "Smoke profile isolates local algorithms" },
      siliconflow: { measured: false, reason: "Network benchmarks are opt-in and credentialed" },
      network: { measured: false, reason: "No network in smoke profile" },
      dimensions,
      rerankBudgetPlanner: budgets,
      semanticQueryPlanner: {
        predicateCount: DEFAULT_PREDICATE_REGISTRY.list().length,
        dimensions: predicateDimensions,
        iterations: predicateRoutingSamples.length,
        predicateRoutingP50Ms: percentile(predicateRoutingSamples, 0.5),
        predicateRoutingP95Ms: percentile(predicateRoutingSamples, 0.95),
        adaptiveCutoffP50Ms: percentile(cutoffSamples, 0.5),
        adaptiveCutoffP95Ms: percentile(cutoffSamples, 0.95),
        additionalEmbeddingRequestsPerRecall: 0,
        additionalRerankRequestsPerRecall: 0,
      },
    };
    await mkdir(path.resolve("benchmark-results"), { recursive: true });
    await writeFile(
      path.resolve("benchmark-results/smoke.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    expect(fused).toHaveLength(10_000);
    expect(fusionMs).toBeLessThan(2_000);
  });
});
