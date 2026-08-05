import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  BackgroundScheduler,
  EvidenceAuthority,
  createDefaultConfig,
} from "@pi-mentis/pi-mentis-core";
import {
  createKnowledgeService,
  enqueueKnowledgeEmbeddingMigration,
  migrateKnowledgeEmbedding,
} from "@pi-mentis/pi-mentis-knowledge-core";
import {
  PiCaptureSession,
  createMemoryService,
  createPiEvidenceStore,
} from "@pi-mentis/pi-mentis-memory-core";
import { createRetrievalService } from "@pi-mentis/pi-mentis-retrieval";
import { ZvecStore, activeGenerationFor } from "@pi-mentis/pi-mentis-zvec";

import {
  DeterministicEmbeddingProvider,
  FailingReranker,
  embeddingSpace,
  testStorage,
} from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })),
  );
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-mentis-integration-"));
  roots.push(root);
  return root;
}

function scheduler(): BackgroundScheduler {
  return new BackgroundScheduler({
    maxQueuedTasks: 100,
    maxQueuedBytes: 16 * 1024 * 1024,
    maxActiveTasks: 2,
    maxPendingEmbeddingTokens: 100_000,
    maxPendingRerankTokens: 100_000,
  });
}

describe("real Zvec production loop", () => {
  it("persists Pi episodes and resolves byte-identical offloaded tool evidence after restart", async () => {
    const root = await createRoot();
    const space = embeddingSpace();
    const initial = { knowledge: space, memory: space, capability: space };
    const original = "src/index.ts:42 error Type mismatch\n".repeat(4_000);
    const store = new ZvecStore(testStorage(root));
    await store.start(initial);
    const evidence = createPiEvidenceStore(store);
    const capture = new PiCaptureSession(evidence, {
      inlineMaxBytes: 8 * 1024,
      truncateMaxBytes: 64 * 1024,
      previewBytes: 4 * 1024,
    });
    const episode = await capture.start({
      goal: "fix the build",
      scope: {
        tenantId: "tenant",
        userId: "user",
        appId: "pi",
        agentId: "agent",
        sessionId: "session",
        branchId: "branch",
        runId: "run",
        projectId: "project",
      },
    });
    await capture.toolStarted("tool-1", "bash", { command: "pnpm build" });
    const offloaded = await capture.toolResult({
      toolCallId: "tool-1",
      toolName: "bash",
      input: { command: "pnpm build" },
      text: original,
      details: { exitCode: 1 },
      isError: true,
      cwd: "/workspace",
      completedAt: Date.now(),
    });
    await capture.finish();
    expect(offloaded?.mode).toBe("artifact");
    const artifactId = offloaded?.artifact?.id;
    expect(artifactId).toBeDefined();
    await store.close();

    const reopened = new ZvecStore(testStorage(root));
    await reopened.start(initial);
    const restoredEvidence = createPiEvidenceStore(reopened);
    expect(await restoredEvidence.getEpisode(episode.id)).toMatchObject({ status: "failed" });
    const resolved = await restoredEvidence.readEvidence([
      { kind: "artifact", id: artifactId!, observedAt: 0 },
    ]);
    expect(resolved[0]).toMatchObject({ id: artifactId, content: original });
    await reopened.close();
  });

  it("persists across restart and supports dense plus FTS retrieval", async () => {
    const root = await createRoot();
    const space = embeddingSpace();
    const initial = { knowledge: space, memory: space, capability: space };
    const store = new ZvecStore(testStorage(root));
    await store.start(initial);
    const vector = new Float32Array(768);
    vector[0] = 1;
    await store.upsertVectors("knowledge", [
      {
        id: "chunk-1",
        kind: "knowledge",
        namespace: "test",
        status: "active",
        payload: { text: "restart persistence sentinel" },
        searchableText: "restart persistence sentinel",
        contentHash: "hash",
        sourceId: "source",
        documentId: "document",
        authority: EvidenceAuthority.UserKnowledge,
        tokenCount: 3,
        revision: 1,
        embedding: vector,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    await store.close();

    const reopened = new ZvecStore(testStorage(root));
    await reopened.start(initial);
    expect((await reopened.fetchVectors("knowledge", ["chunk-1"])).has("chunk-1")).toBe(true);
    expect((await reopened.vectorSearch({ kind: "knowledge", vector, topK: 3 }))[0]?.id).toBe(
      "chunk-1",
    );
    expect(
      (await reopened.ftsSearch({ kind: "knowledge", query: "sentinel", topK: 3 }))[0]?.id,
    ).toBe("chunk-1");
    await reopened.close();
  });

  it("indexes files incrementally, reuses unchanged document vectors, and migrates generations", async () => {
    const root = await createRoot();
    const documentPath = path.join(root, "guide.md");
    await writeFile(
      documentPath,
      "# Deployment\n\nUse the canary deployment procedure and verify health checks.\n",
    );
    const storageRoot = path.join(root, "zvec");
    const provider = new DeterministicEmbeddingProvider();
    const space = embeddingSpace();
    const store = new ZvecStore(testStorage(storageRoot));
    await store.start({ knowledge: space, memory: space, capability: space });
    const jobs = scheduler();
    const config = createDefaultConfig(root);
    const knowledge = createKnowledgeService({
      store,
      embedding: provider,
      embeddingSpace: space,
      dimensions: 768,
      limits: config.performance.resources,
      scheduler: jobs,
      defaultNamespace: "test",
    });
    const first = await knowledge.ingest({
      source: { kind: "file", path: documentPath },
      namespace: "test",
      authority: EvidenceAuthority.WorkspaceCurrent,
    });
    expect(first.chunkCount).toBeGreaterThan(0);
    const callsAfterFirst = provider.calls;
    const second = await knowledge.ingest({
      source: { kind: "file", path: documentPath },
      namespace: "test",
      authority: EvidenceAuthority.WorkspaceCurrent,
    });
    expect(second.unchanged).toBe(1);
    expect(provider.calls).toBe(callsAfterFirst);
    const search = await knowledge.search({ text: "canary deployment", namespace: "test" });
    expect(search.hits[0]?.text).toContain("canary deployment");

    const target = embeddingSpace(1024);
    const migration = await migrateKnowledgeEmbedding(
      store,
      new DeterministicEmbeddingProvider(1024),
      target,
    );
    expect(migration.activated).toBe(true);
    expect(activeGenerationFor(store.manifest, "knowledge")).toBe(migration.generationId);
    const oldGeneration = store.manifest.generations.find(
      (item) => item.kind === "knowledge" && item.state === "superseded",
    );
    expect(oldGeneration).toBeDefined();
    await store.rollbackGeneration("knowledge", oldGeneration!.generationId);
    expect(activeGenerationFor(store.manifest, "knowledge")).toBe(oldGeneration!.generationId);

    const receipt = await enqueueKnowledgeEmbeddingMigration(
      store,
      jobs,
      new DeterministicEmbeddingProvider(1024),
      target,
    );
    let migrationJob = (await store.fetchScalar("jobs_v1", [receipt.jobId])).get(receipt.jobId);
    expect(["queued", "leased", "running", "succeeded"]).toContain(migrationJob?.state);
    for (let attempts = 0; attempts < 100 && migrationJob?.state !== "succeeded"; attempts++) {
      await delay(10);
      migrationJob = (await store.fetchScalar("jobs_v1", [receipt.jobId])).get(receipt.jobId);
    }
    expect(migrationJob?.state).toBe("succeeded");
    expect(migrationJob?.result).toMatchObject({ activated: true, migrated: first.chunkCount });
    await jobs.close();
    await store.close();
  });

  it("runs knowledge-first memory retrieval and degrades on rerank failure", async () => {
    const root = await createRoot();
    const space = embeddingSpace();
    const store = new ZvecStore(testStorage(root));
    await store.start({ knowledge: space, memory: space, capability: space });
    const provider = new DeterministicEmbeddingProvider();
    const jobs = scheduler();
    const config = createDefaultConfig(root);
    const knowledge = createKnowledgeService({
      store,
      embedding: provider,
      embeddingSpace: space,
      dimensions: 768,
      limits: config.performance.resources,
      scheduler: jobs,
    });
    await knowledge.ingest({
      source: { kind: "text", text: "The release process uses a canary before production." },
      namespace: "user",
      authority: EvidenceAuthority.UserKnowledge,
      scopeContext: {
        tenantId: "tenant",
        userId: "user",
        appId: "pi",
        agentId: "agent",
      },
    });
    const memory = createMemoryService({
      store,
      embedding: provider,
      embeddingSpace: space,
      dimensions: 768,
    });
    const committed = await memory.commit({
      content: "Always verify canary health before promotion.",
      type: "procedural",
      scope: { kind: "user", id: "default" },
      scopeContext: {
        tenantId: "tenant",
        userId: "user",
        appId: "pi",
        agentId: "agent",
      },
      authority: EvidenceAuthority.VerifiedToolObservation,
    });
    expect(committed.record.domain).toBe("procedure");
    expect(
      await memory.get(committed.record.id, {
        scopeContext: {
          tenantId: "tenant",
          userId: "user",
          appId: "pi",
          agentId: "other-agent",
        },
      }),
    ).toBeUndefined();
    const retrieval = createRetrievalService({
      knowledge,
      memory,
      reranker: new FailingReranker(),
      rerankModel: "failure",
      rerankContextTokens: 8192,
    });
    const result = await retrieval.search({
      text: "How should I promote the canary release?",
      memoryScopes: [{ kind: "user", id: "default" }],
      memoryScopeContext: {
        tenantId: "tenant",
        userId: "user",
        appId: "pi",
        agentId: "agent",
      },
    });
    expect(result.hits.some((item) => item.kind === "knowledge")).toBe(true);
    expect(result.hits.some((item) => item.kind === "memory")).toBe(true);
    expect(result.diagnostics.degraded).toContain("rerank:Error");
    await jobs.close();
    await store.close();
  });
});
