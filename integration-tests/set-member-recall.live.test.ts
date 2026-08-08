import { describe, expect, it } from "vitest";
import { loadConfig } from "@pi-mentis/pi-mentis-core";
import { SiliconFlowEmbeddingProvider } from "@pi-mentis/pi-mentis-siliconflow";
import { ZvecStore } from "@pi-mentis/pi-mentis-zvec";
import { createMemoryService } from "@pi-mentis/pi-mentis-memory-core";
import { createRetrievalService, DefaultRecallCoordinator } from "@pi-mentis/pi-mentis-retrieval";

const LIVE_GATE = process.env["PI_MENTIS_LIVE_INTEGRATION"] === "1";

const TARGETS = [
  "05f25baba0b64ea0e84e1e679165528e2dfec75d338c93caeeaa0bb0365b0a08",
  "5eaab32585d41212fa017b79e6c33bbf95d7a69e058b5de72b4d010763238382",
  "07e9ade3d5fc1e43bf4274799aa65ae643aa6468f153f2235302ba054feb7245",
];

describe.skipIf(!LIVE_GATE)("live /new set-member recall (post-repair)", () => {
  it("recalls Kotlin/Elixir/Zig via the production pipeline with status=active only", async () => {
    const config = await loadConfig(process.cwd());
    const store = new ZvecStore({
      rootDir: config.storage.rootDir,
      readOnly: true,
      lockTimeoutMs: 500,
      generationRetentionMs: 60_000,
      writeBatch: { maxOperations: 256, maxBytes: 8 * 1024 * 1024, maxWaitMs: 5 },
    });
    const space = {
      providerId: "siliconflow",
      modelId: config.inference.siliconflow.embedding.model,
      dimensions: config.inference.siliconflow.embedding.dimensions,
      normalization: "none",
      preprocessingVersion: "pi-mentis-text-v1",
      inputKindVersion: "pi-mentis-input-kind-v1",
    };
    await store.start({ knowledge: space, memory: space, capability: space });
    const embedding = new SiliconFlowEmbeddingProvider(config.inference.siliconflow);
    const memory = createMemoryService({
      store,
      embedding,
      embeddingSpace: space,
      dimensions: config.inference.siliconflow.embedding.dimensions,
    });
    const retrieval = createRetrievalService({
      memory,
      embedding,
      embeddingModel: config.inference.siliconflow.embedding.model,
      embeddingDimensions: config.inference.siliconflow.embedding.dimensions,
      rerankModel: config.inference.siliconflow.rerank.model,
      rerankContextTokens: config.inference.siliconflow.rerank.maxInputTokens,
      rerankCandidateLimit: config.inference.rerank.candidateLimit,
    });
    const coordinator = new DefaultRecallCoordinator({
      getMemory: () => memory,
      getRetrieval: () => retrieval,
      getEvidence: () => undefined,
    });

    const scopeContext = {
      tenantId: "local",
      userId: "local",
      appId: "pi",
      agentId: "pi-mentis",
    };
    const result = await coordinator.recall(
      { query: "我最近补充到编程语言偏好里的三种语言是什么？" },
      { scopeContext },
    );
    const targetHits = result.hits.filter((h) => TARGETS.includes(h.id));
    console.log(
      `[/new] found=${result.found} plannerDegraded=${result.diagnostics?.plannerDegraded} ` +
        `targetHits=${targetHits.length}`,
    );
    for (const h of result.hits) {
      console.log(`  HIT ${h.id.slice(0, 12)}... ${h.content.slice(0, 60)}`);
    }
    // Set Recall Completeness: the coordinator's FINAL hits must contain all
    // three set members (default status=active, no temporalMode override).
    for (const target of TARGETS) {
      expect(result.hits.some((h) => h.id === target)).toBe(true);
    }
    await store.close();
  }, 120_000);
});

describe.skipIf(!LIVE_GATE)("live ranking diagnostics (read-only)", () => {
  it("shows where each language member drops in rerank/MMR", async () => {
    const config = await loadConfig(process.cwd());
    const store = new ZvecStore({
      rootDir: config.storage.rootDir,
      readOnly: true,
      lockTimeoutMs: 500,
      generationRetentionMs: 60_000,
      writeBatch: { maxOperations: 256, maxBytes: 8 * 1024 * 1024, maxWaitMs: 5 },
    });
    const space = {
      providerId: "siliconflow",
      modelId: config.inference.siliconflow.embedding.model,
      dimensions: config.inference.siliconflow.embedding.dimensions,
      normalization: "none",
      preprocessingVersion: "pi-mentis-text-v1",
      inputKindVersion: "pi-mentis-input-kind-v1",
    };
    await store.start({ knowledge: space, memory: space, capability: space });
    const embedding = new SiliconFlowEmbeddingProvider(config.inference.siliconflow);
    const memory = createMemoryService({
      store,
      embedding,
      embeddingSpace: space,
      dimensions: config.inference.siliconflow.embedding.dimensions,
    });
    const retrieval = createRetrievalService({
      memory,
      embedding,
      embeddingModel: config.inference.siliconflow.embedding.model,
      embeddingDimensions: config.inference.siliconflow.embedding.dimensions,
      rerankModel: config.inference.siliconflow.rerank.model,
      rerankContextTokens: config.inference.siliconflow.rerank.maxInputTokens,
      rerankCandidateLimit: config.inference.rerank.candidateLimit,
    });
    const ctx = { tenantId: "local", userId: "local", appId: "pi", agentId: "pi-mentis" };
    const q = "我最近补充到编程语言偏好里的三种语言是什么？";
    const scopes = [{ kind: "user", id: "local" }];
    const label = (id: string) =>
      id === "05f25baba0b64ea0e84e1e679165528e2dfec75d338c93caeeaa0bb0365b0a08"
        ? "KOTLIN"
        : id === "5eaab32585d41212fa017b79e6c33bbf95d7a69e058b5de72b4d010763238382"
          ? "ELIXIR"
          : id === "07e9ade3d5fc1e43bf4274799aa65ae643aa6468f153f2235302ba054feb7245"
            ? "ZIG"
            : id.slice(0, 8);

    for (const allowRerank of [false, true]) {
      const res = await retrieval.search(
        { text: q, limit: 10, sources: ["memory"], memoryScopes: scopes, memoryScopeContext: ctx },
        { allowRerank },
      );
      const targets = res.hits.filter((h) => TARGETS.includes(h.id));
      console.log(
        `[${allowRerank ? "with-rerank" : "no-rerank"}] final targetHits=${targets.length} ` +
          `-> ${targets.map((h) => label(h.id)).join("|")}`,
      );
      console.log(
        `  rrf:     ${(res.diagnostics.rankings?.rrf ?? []).slice(0, 8).map(label).join(", ")}`,
      );
      if (res.diagnostics.rankings?.rerank !== undefined) {
        console.log(
          `  rerank:  ${res.diagnostics.rankings.rerank.slice(0, 8).map(label).join(", ")}`,
        );
      }
      console.log(
        `  mmr:     ${(res.diagnostics.rankings?.mmr ?? []).slice(0, 8).map(label).join(", ")}`,
      );
      for (const entry of res.diagnostics.diversity ?? []) {
        const id = label(entry.candidateId);
        if (!["KOTLIN", "ELIXIR", "ZIG"].includes(id)) continue;
        console.log(
          `  diversity[${id}] sim=${entry.pairwiseSimilarity.toFixed(3)} ` +
            `relation=${entry.structuralRelation} penalty=${entry.mmrPenalty.toFixed(3)} ` +
            `preserved=${entry.preservedBySetCompleteness} selected=${entry.selected}`,
        );
      }
    }
    await store.close();
  }, 120_000);
});
