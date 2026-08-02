import { spawn } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";

import { repositoryRoot, writeJson } from "./common.mjs";

function scenario(id, name, status, started, evidence, error) {
  return {
    id,
    name,
    stage: "Recovery",
    status,
    durationMs: performance.now() - started,
    evidence,
    ...(error === undefined ? {} : { error }),
  };
}

class DeterministicEmbeddingProvider {
  id = "acceptance";
  async embed(request) {
    return {
      model: { providerId: this.id, modelId: "crash-64", capabilityVersion: "1" },
      vectors: request.inputs.map((text) => {
        const values = new Float32Array(request.dimensions);
        values[text.length % request.dimensions] = 1;
        return { values, dimensions: request.dimensions, normalized: true };
      }),
      usage: { inputTokens: request.inputs.reduce((sum, text) => sum + text.length, 0) },
    };
  }
  async capabilities() {
    return {
      models: [
        {
          model: { providerId: this.id, modelId: "crash-64", capabilityVersion: "1" },
          supportedDimensions: [64],
          defaultDimensions: 64,
          supportsDimensionSelection: false,
          maxInputTokens: 32_768,
          maxBatchItems: 32,
          maxBatchTokens: 20_000,
          supportsBase64Encoding: false,
          supportsTruncation: false,
          inputKinds: ["query", "document", "code", "capability", "memory"],
        },
      ],
    };
  }
  async health() {
    return { status: "healthy", checkedAt: Date.now() };
  }
}

async function crashWorker(rootDir, runId) {
  const child = spawn(
    process.execPath,
    [path.join(import.meta.dirname, "crash-worker.mjs"), rootDir, runId],
    {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const decoder = new StringDecoder("utf8");
  let output = "";
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Crash worker did not become ready")),
      60_000,
    );
    child.stdout.on("data", (chunk) => {
      output += decoder.write(chunk);
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(output.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      reject(new Error(`Crash worker exited early: ${code}/${signal}: ${errors}`)),
    );
  });
  child.kill("SIGKILL");
  const exited = await new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  return { ready, exited, stderr: errors };
}

export async function runCrashMatrix({ directories, runId }) {
  const started = performance.now();
  const rootDir = path.join(directories.state, "crash-zvec");
  const evidenceFile = path.join(directories.reports, "evidence", "crash-matrix.json");
  const crash = await crashWorker(rootDir, runId);
  if (crash.exited.signal !== "SIGKILL") throw new Error("Crash worker was not killed by SIGKILL");
  await delay(11_000);
  const { BackgroundScheduler, createDefaultConfig } = await import(
    path.join(repositoryRoot, "packages", "core", "dist", "index.js")
  );
  const { createKnowledgeService } = await import(
    path.join(repositoryRoot, "packages", "knowledge", "dist", "index.js")
  );
  const { HierarchicalViewService, TemporalTruthEngine, createPiEvidenceStore } = await import(
    path.join(repositoryRoot, "packages", "memory", "dist", "index.js")
  );
  const { ZvecStateStore, ZvecStore } = await import(
    path.join(repositoryRoot, "packages", "zvec-storage", "dist", "index.js")
  );
  const config = createDefaultConfig(repositoryRoot);
  const space = {
    providerId: "acceptance",
    modelId: "crash-64",
    dimensions: 64,
    normalization: "none",
    preprocessingVersion: "acceptance-v1",
    inputKindVersion: "acceptance-v1",
  };
  const store = new ZvecStore({
    ...config.storage,
    rootDir,
    readOnly: false,
    lockTimeoutMs: 2_000,
  });
  await store.start({ knowledge: space, memory: space, capability: space });
  const evidenceStore = createPiEvidenceStore(store);
  const artifactRecovery = await evidenceStore.recoverArtifacts();
  const artifact = await evidenceStore.getArtifact(crash.ready.artifactId);
  const temporal = new TemporalTruthEngine(store);
  const temporalRecovery = await temporal.repair(async (plan) =>
    (await store.fetchVectors("memory", [plan.claim.memoryId])).has(plan.claim.memoryId),
  );
  const crashScope = { kind: "project", id: `${runId}:project` };
  const crashScopeContext = {
    tenantId: "local",
    userId: "local",
    appId: "pi",
    agentId: "pi-mentis",
    repositoryId: `${runId}:repo`,
    projectId: `${runId}:project`,
    sessionId: `${runId}:crash-session`,
    branchId: "main",
  };
  const k02Head = await temporal.head(crash.ready.k02.factKey, crashScope, crashScopeContext);
  const state = new ZvecStateStore(store);
  const k03Saga = await state.get(crash.ready.k03.sagaId);
  const views = new HierarchicalViewService(store);
  const viewRecovery = await views.repair();
  const viewJob = (await store.fetchScalar("jobs_v1", [crash.ready.viewJobId])).get(
    crash.ready.viewJobId,
  );
  const scheduler = new BackgroundScheduler(config.performance.queue);
  const knowledge = createKnowledgeService({
    store,
    embedding: new DeterministicEmbeddingProvider(),
    embeddingSpace: space,
    dimensions: 64,
    limits: config.performance.resources,
    scheduler,
  });
  const knowledgeRecovery = await knowledge.recoverJobs();
  let knowledgeJob;
  const deadline = Date.now() + 30_000;
  do {
    knowledgeJob = (await store.fetchScalar("jobs_v1", [crash.ready.knowledgeJobId])).get(
      crash.ready.knowledgeJobId,
    );
    if (knowledgeJob?.state === "succeeded" || knowledgeJob?.state === "dead") break;
    await delay(50);
  } while (Date.now() < deadline);
  await scheduler.close();
  await views.flush();
  await store.close();
  const checks = {
    K01: artifactRecovery.failed === 1 && artifact?.state === "failed",
    K02:
      temporalRecovery.repaired >= 1 &&
      k02Head?.currentClaims?.some((claim) => claim.memoryId === crash.ready.k02.claim.memoryId) ===
        true,
    K03: k03Saga?.value?.stage === "completed",
    K04: viewRecovery.repaired >= 1 && viewJob?.status === "completed",
    K05: knowledgeRecovery.recovered >= 1 && knowledgeJob?.state === "succeeded",
  };
  await writeJson(evidenceFile, {
    runId,
    crash,
    artifactRecovery,
    artifact,
    temporalRecovery,
    k02Head,
    k03Saga,
    viewRecovery,
    viewJob,
    knowledgeRecovery,
    knowledgeJob,
    checks,
  });
  const names = {
    K01: "SIGKILL after artifact manifest state before chunks",
    K02: "SIGKILL after claim write before Temporal Head",
    K03: "SIGKILL after Temporal Head before saga completion",
    K04: "SIGKILL after View Delta job before materialization",
    K05: "SIGKILL worker lease takeover and durable job completion",
  };
  return Object.entries(checks).map(([id, passed]) =>
    scenario(
      id,
      names[id],
      passed ? "PASS" : "FAIL",
      started,
      evidenceFile,
      passed ? undefined : `${id} recovery invariant failed`,
    ),
  );
}
