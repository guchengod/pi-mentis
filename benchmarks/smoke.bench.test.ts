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
import { reciprocalRankFusion } from "@pi-mentis/pi-mentis-retrieval";

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
