import path from "node:path";
import { setInterval } from "node:timers";

import { repositoryRoot } from "./common.mjs";

const [rootDir, runId] = process.argv.slice(2);
if (rootDir === undefined || runId === undefined) throw new Error("rootDir and runId are required");

const { EvidenceAuthority, contentHash, createDefaultConfig } = await import(
  path.join(repositoryRoot, "packages", "core", "dist", "index.js")
);
const { TemporalTruthEngine } = await import(
  path.join(repositoryRoot, "packages", "memory", "dist", "index.js")
);
const { ZvecStateStore, ZvecStore } = await import(
  path.join(repositoryRoot, "packages", "zvec-storage", "dist", "index.js")
);

const dimensions = 64;
const space = {
  providerId: "acceptance",
  modelId: "crash-64",
  dimensions,
  normalization: "none",
  preprocessingVersion: "acceptance-v1",
  inputKindVersion: "acceptance-v1",
};
const store = new ZvecStore({
  ...createDefaultConfig(repositoryRoot).storage,
  rootDir,
  readOnly: false,
  lockTimeoutMs: 1_000,
});
await store.start({ knowledge: space, memory: space, capability: space });
const now = Date.now();
const namespace = `local:local:pi:pi-mentis::${runId}`;
const scope = { kind: "project", id: `${runId}:project` };
const scopeContext = {
  tenantId: "local",
  userId: "local",
  appId: "pi",
  agentId: "pi-mentis",
  repositoryId: `${runId}:repo`,
  projectId: `${runId}:project`,
  sessionId: `${runId}:crash-session`,
  branchId: "main",
};

const artifactId = `${runId}:artifact:pending`;
await store.upsertScalar("artifacts_v1", [
  {
    id: artifactId,
    kind: "artifact",
    namespace,
    status: "pending",
    payload: {
      id: artifactId,
      episodeId: `${runId}:episode`,
      securityNamespace: "local:local:pi:pi-mentis",
      mediaType: "text/plain",
      byteLength: 12,
      contentHash: contentHash("partial data"),
      relativePath: path.join("artifacts", "cr", artifactId, "manifest.json"),
      state: "pending",
      chunks: [],
      createdAt: now,
      updatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
  },
]);

function memoryRecord(id, factKey, content) {
  return {
    id,
    kind: "memory",
    namespace,
    status: "active",
    payload: {
      id,
      content,
      normalizedContent: content,
      contentHash: contentHash(content),
      type: "fact",
      domain: "project",
      scope,
      scopeContext,
      confidence: 0.9,
      importance: 0.8,
      authority: EvidenceAuthority.WorkspaceCurrent,
      evidenceRefs: [{ kind: "event", id: `${id}:event`, observedAt: now }],
      supersedesIds: [],
      conflictsWithIds: [],
      status: "active",
      embeddingSpaceId: "crash-64",
      createdAt: now,
      updatedAt: now,
      observedAt: now,
      lastAccessedAt: now,
      reinforceCount: 0,
      revision: 1,
      factKey,
      cardinality: "single",
      temporalState: "current",
      contentOrigin: "workspace",
    },
    searchableText: content,
    contentHash: contentHash(content),
    sourceId: runId,
    documentId: id,
    authority: EvidenceAuthority.WorkspaceCurrent,
    tokenCount: 8,
    revision: 1,
    embedding: new Float32Array(dimensions),
    createdAt: now,
    updatedAt: now,
  };
}

const k02Memory = memoryRecord(`${runId}:memory:k02`, `${runId}:k02`, "claim before head");
const k03Memory = memoryRecord(`${runId}:memory:k03`, `${runId}:k03`, "head before completion");
const k04Memory = memoryRecord(`${runId}:memory:k04`, `${runId}:k04`, "view delta survives");
await store.upsertVectors("memory", [k02Memory, k03Memory, k04Memory]);

const temporal = new TemporalTruthEngine(store);
const prepare = (memory) =>
  temporal.prepare({
    factKey: memory.payload.factKey,
    cardinality: "single",
    scope,
    scopeContext,
    memoryId: memory.id,
    contentHash: memory.contentHash,
    authority: EvidenceAuthority.WorkspaceCurrent,
    observedAt: now,
  });
const k02Plan = await prepare(k02Memory);
await temporal.claimWritten(k02Plan);
const k03Plan = await prepare(k03Memory);
await temporal.claimWritten(k03Plan);
const state = new ZvecStateStore(store);
await state.put({
  id: k03Plan.headId,
  kind: "temporal-head",
  namespace: k03Plan.namespace,
  value: k03Plan.nextHead,
});
const k03Saga = await state.get(k03Plan.sagaId);
await state.put(
  {
    id: k03Plan.sagaId,
    kind: "temporal-saga",
    namespace: k03Plan.namespace,
    value: { sagaId: k03Plan.sagaId, plan: k03Plan, stage: "head-written", attempts: 1 },
  },
  { status: "head-written", expectedRevision: k03Saga?.revision },
);

const viewJobId = `${runId}:view-job:k04`;
await store.upsertScalar("jobs_v1", [
  {
    id: viewJobId,
    kind: "view-delta",
    namespace,
    status: "running",
    payload: {
      jobId: viewJobId,
      status: "running",
      record: k04Memory.payload,
      createdAt: now,
      updatedAt: now,
      viewIds: [],
    },
    createdAt: now,
    updatedAt: now,
  },
]);

const knowledgeJobId = `${runId}:knowledge-job:k05`;
const commandJson = JSON.stringify({
  source: { kind: "text", text: `${runId} recovered lease content`, name: `${runId}.txt` },
  namespace,
});
await store.upsertScalar("jobs_v1", [
  {
    id: knowledgeJobId,
    kind: "knowledge-ingest",
    namespace,
    status: "running",
    payload: {
      jobId: knowledgeJobId,
      deduplicationKey: `${runId}:dedup:k05`,
      commandHash: contentHash(commandJson),
      commandJson,
      namespace,
      state: "running",
      attempts: 1,
      maxAttempts: 3,
      leaseOwner: `${runId}:killed-worker`,
      leaseExpiresAt: now - 1,
      createdAt: now,
      updatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
  },
]);

process.stdout.write(
  `${JSON.stringify({ type: "READY", artifactId, k02: k02Plan, k03: k03Plan, viewJobId, knowledgeJobId })}\n`,
);
setInterval(() => undefined, 60_000);
