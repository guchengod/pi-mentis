/* Live E2E: commit + recall through the fully refactored write path with real bge-m3. */
import { describe, it, expect } from "vitest";
import { loadConfig } from "@pi-mentis/pi-mentis-core";
import { SiliconFlowEmbeddingProvider } from "@pi-mentis/pi-mentis-siliconflow";
import { ZvecStore } from "@pi-mentis/pi-mentis-zvec";
import {
  createMemoryService,
  createPiEvidenceStore,
  DefaultRememberCoordinator,
  ScopeSemanticPlanner,
  FileScopePrototypeCache,
  CommitSemanticPlanner,
  FileCommitSemanticCache,
  type PiScopeContext,
  type PiEpisode,
  type PiEvent,
} from "@pi-mentis/pi-mentis-memory-core";
import path from "node:path";
import type { EvidenceRef } from "@pi-mentis/pi-mentis-core";

describe("live write-path E2E (refactored)", () => {
  it("commits a new durable fact and recalls it in a fresh context", async () => {
    const config = await loadConfig(process.cwd());
    const store = new ZvecStore({
      rootDir: config.storage.rootDir,
      readOnly: false,
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
    const scopePlanner = new ScopeSemanticPlanner({
      embedding,
      dimensions: config.inference.siliconflow.embedding.dimensions,
      cache: new FileScopePrototypeCache(path.join(config.storage.rootDir, "scope-semantic-index.json")),
    });
    const commitPlanner = new CommitSemanticPlanner({
      embedding,
      dimensions: config.inference.siliconflow.embedding.dimensions,
      cache: new FileCommitSemanticCache(path.join(config.storage.rootDir, "commit-semantic-index.json")),
    });
    const memory = createMemoryService({
      store,
      embedding,
      embeddingSpace: space,
      dimensions: config.inference.siliconflow.embedding.dimensions,
      scopePlanner,
      commitPlanner,
    });
    const coordinator = new DefaultRememberCoordinator(memory, scopePlanner, commitPlanner);

    const sessionId = `live-e2e-${Date.now()}`;
    const ctx: PiScopeContext = {
      tenantId: "local",
      userId: "local",
      appId: "pi",
      agentId: "pi-mentis",
      sessionId,
      repositoryId: "repo-live",
      projectId: "proj-live",
      taskId: "task-live",
      topicIds: ["topic-live"],
    };
    const evidence = createPiEvidenceStore(store);
    const boundary = "local:local:pi:pi-mentis";
    const episode: PiEpisode = {
      id: `ep-${sessionId}`,
      sessionId,
      securityNamespace: boundary,
      branchId: "root",
      topicIds: ["topic-live"],
      goal: "test",
      startedAt: Date.now(),
      status: "running",
      firstSequence: 1,
      lastSequence: 1,
    };
    await evidence.createEpisode(episode);
    const event: PiEvent = {
      id: `ev-${sessionId}`,
      episodeId: episode.id,
      securityNamespace: boundary,
      sequence: 1,
      kind: "goal",
      timestamp: Date.now(),
      payload: {},
    };
    await evidence.appendEvent(event);
    const evidenceRef: EvidenceRef = { kind: "event", id: event.id, observedAt: Date.now() };

    // Fresh fact never stored before
    const content = "我把自己的本地实验区取名为'玄青'，专用于性能基准测试。";
    const commit = await coordinator.remember(
      { content },
      { scopeContext: ctx, evidenceRef },
    );
    console.log("\ncommit outcome:", commit.outcome, "predicate:", commit.predicate, "cardinality:", commit.cardinality);
    expect(commit.outcome).toBe("remembered");

    const record = await memory.get(commit.id as string, { scopeContext: ctx });
    console.log("stored scope:", JSON.stringify(record?.scope), "type:", record?.type, "factKey:", record?.factKey, "polarity:", record?.polarity);
    expect(record?.scope.kind).toBe("user");

    // /new-like fresh context: no task/topic/repo, only user boundary
    const fresh = { tenantId: "local", userId: "local", appId: "pi", agentId: "pi-mentis" };
    const search = await memory.search(
      { text: "我本地做性能基准测试的实验区叫什么名字？", limit: 10, scopeContext: fresh, scopes: [{ kind: "user", id: "local" }] },
      { timeoutMs: 15_000 },
    );
    const hit = search.hits.find((h) => h.id === commit.id);
    console.log("recalled:", hit !== undefined, "degraded:", JSON.stringify(search.diagnostics?.degraded));
    expect(hit).toBeDefined();

    await store.close();
  }, 120_000);
});
