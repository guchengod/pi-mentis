/**
 * RememberCoordinator E2E — the coordinator consumes CommitSemanticPlanner
 * (action/predicate/type/cardinality) and ScopeSemanticPlanner (ownership).
 * Deterministic vectors exercise the wiring; open-expression generalization
 * is covered by the live probes.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { EmbeddingProvider, EmbeddingRequest, EmbeddingResponse } from "@pi-mentis/pi-mentis-inference";
import { ZvecStore } from "@pi-mentis/pi-mentis-zvec";

import {
  createMemoryService,
  createPiEvidenceStore,
  DefaultRememberCoordinator,
  CommitSemanticPlanner,
  ScopeSemanticPlanner,
  type PiScopeContext,
  type PiEpisode,
  type PiEvent,
} from "@pi-mentis/pi-mentis-memory-core";
import type { EvidenceRef } from "@pi-mentis/pi-mentis-core";

const DIM = 16;
const AX = {
  create: 0, reinforce: 1, correct: 2, replace: 3, retract: 4,
  pos: 5, neg: 6,
  build: 7, test: 8, packageManager: 9, database: 10, deploy: 11,
  style: 12, language: 13, runtime: 14,
  user: 15,
} as const;
function axis(a: number): Float32Array {
  const v = new Float32Array(DIM);
  v[a] = 1;
  return v;
}
function contentVector(action: number, polarity: number, predicate: number, scopeUser: boolean): Float32Array {
  const v = new Float32Array(DIM);
  v[action] = 1;
  v[polarity] = 1;
  v[predicate] = 1;
  if (scopeUser) v[AX.user] = 1;
  return v;
}

class E2EProvider implements EmbeddingProvider {
  readonly id = "e2e";
  readonly #map = new Map<string, Float32Array>();
  register(text: string, v: Float32Array) {
    this.#map.set(text, v);
  }
  async capabilities() { return { models: [] }; }
  async health() { return { status: "healthy" as const, checkedAt: Date.now() }; }
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    return {
      model: { providerId: this.id, modelId: "e2e", capabilityVersion: "1" },
      vectors: request.inputs.map((input) => ({
        values: this.#map.get(input) ?? new Float32Array(DIM),
        dimensions: request.dimensions,
        normalized: true,
      })),
      usage: { inputTokens: 1 },
    };
  }
}

function prototypes(): Map<string, Float32Array[]> {
  const m = new Map<string, Float32Array[]>();
  m.set("create", [axis(AX.create)]);
  m.set("reinforce", [axis(AX.reinforce)]);
  m.set("correct", [axis(AX.correct)]);
  m.set("replace", [axis(AX.replace)]);
  m.set("retract", [axis(AX.retract)]);
  m.set("polarity:positive", [axis(AX.pos)]);
  m.set("polarity:negative", [axis(AX.neg)]);
  m.set("predicate:project_build_command", [axis(AX.build)]);
  m.set("predicate:project_test_command", [axis(AX.test)]);
  m.set("predicate:project_package_manager", [axis(AX.packageManager)]);
  m.set("predicate:project_database", [axis(AX.database)]);
  m.set("predicate:project_deployment_target", [axis(AX.deploy)]);
  m.set("predicate:response_style", [axis(AX.style)]);
  m.set("predicate:language", [axis(AX.language)]);
  m.set("predicate:runtime", [axis(AX.runtime)]);
  m.set("user", [axis(AX.user)]);
  m.set("durable", [axis(AX.user)]);
  m.set("temporary", [axis(AX.neg)]);
  m.set("subject:user", [axis(AX.user)]);
  return m;
}

let store: ZvecStore;
let rootDir: string;
const space = {
  providerId: "test",
  modelId: "e2e",
  dimensions: DIM,
  normalization: "none" as const,
  preprocessingVersion: "v1",
  inputKindVersion: "v1",
};

const ctx: PiScopeContext = {
  tenantId: "local",
  userId: "u1",
  appId: "pi",
  agentId: "pi-mentis",
  repositoryId: "repo-A",
  projectId: "proj-A",
  taskId: "task-A",
  topicIds: ["topic-A"],
};

async function evidenceRefFor(c: PiScopeContext): Promise<EvidenceRef> {
  const evidence = createPiEvidenceStore(store);
  const boundary = [c.tenantId, c.userId, c.appId, c.agentId].map(encodeURIComponent).join(":");
  const episodeId = `ep-${c.sessionId ?? "s"}`;
  const episode: PiEpisode = {
    id: episodeId,
    sessionId: c.sessionId ?? "session",
    securityNamespace: boundary,
    branchId: "root",
    topicIds: c.topicIds ?? [],
    goal: "test",
    startedAt: Date.now(),
    status: "running",
    firstSequence: 1,
    lastSequence: 1,
  };
  await evidence.createEpisode(episode);
  const event: PiEvent = {
    id: `ev-${c.sessionId ?? "s"}`,
    episodeId,
    securityNamespace: boundary,
    sequence: 1,
    kind: "goal",
    timestamp: Date.now(),
    payload: {},
  };
  await evidence.appendEvent(event);
  return { kind: "event", id: event.id, observedAt: Date.now() };
}

describe("DefaultRememberCoordinator with semantic planners", () => {
  let provider: E2EProvider;
  let memory: ReturnType<typeof createMemoryService>;
  let coordinator: DefaultRememberCoordinator;

  beforeAll(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "pi-mentis-remember-e2e-"));
    store = new ZvecStore({ rootDir, readOnly: false, lockTimeoutMs: 500, generationRetentionMs: 60_000, writeBatch: { maxOperations: 256, maxBytes: 8 * 1024 * 1024, maxWaitMs: 5 } });
    await store.start({ knowledge: space, memory: space, capability: space });
    provider = new E2EProvider();
    const scopePlanner = new ScopeSemanticPlanner({
      embedding: provider,
      dimensions: DIM,
      prototypeVectors: prototypes(),
    });
    const commitPlanner = new CommitSemanticPlanner({
      embedding: provider,
      dimensions: DIM,
      prototypeVectors: prototypes(),
    });
    memory = createMemoryService({
      store,
      embedding: provider,
      embeddingSpace: space,
      dimensions: DIM,
      viewsEnabled: false,
    });
    coordinator = new DefaultRememberCoordinator(memory, scopePlanner, commitPlanner);
  });

  afterAll(async () => {
    await store.close();
    await rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("builds a create/fact command with the semantic predicate and user scope", async () => {
    const text = "构建命令是 pnpm build";
    provider.register(text, contentVector(AX.create, AX.pos, AX.build, true));
    const result = await coordinator.remember(
      { content: text },
      { scopeContext: ctx, evidenceRef: await evidenceRefFor(ctx) },
    );
    expect(result.outcome).toBe("remembered");
    expect(result.predicate).toBe("project_build_command");

    const record = await memory.get(result.id as string, { scopeContext: ctx });
    expect(record?.scope.kind).toBe("user");
    expect(record?.type).toBe("fact");
    expect(record?.cardinality).toBe("single");
    expect(record?.factKey).toContain("/project_build_command");
    expect(record?.polarity).toBe("positive");
  }, 30_000);

  it("retract intent produces a tombstone (retractsFact)", async () => {
    const text = "忘掉之前保存的那条配置";
    provider.register(text, contentVector(AX.retract, AX.neg, AX.database, true));
    const result = await coordinator.remember(
      { content: text },
      { scopeContext: ctx, evidenceRef: await evidenceRefFor(ctx) },
    );
    // A retract with no matching head is still acknowledged (nothing to delete)
    expect(result.outcome).toBe("remembered");
    const record = await memory.get(result.id as string, { scopeContext: ctx });
    expect(record?.temporalState).toBe("retracted");
  }, 30_000);

  it("reinforce intent is preserved", async () => {
    const text = "对，就是这样";
    provider.register(text, contentVector(AX.reinforce, AX.pos, AX.runtime, true));
    const result = await coordinator.remember(
      { content: text },
      { scopeContext: ctx, evidenceRef: await evidenceRefFor(ctx) },
    );
    expect(result.outcome).toBe("remembered");
    const record = await memory.get(result.id as string, { scopeContext: ctx });
    expect(record?.temporalState).toBe("current");
  }, 30_000);

  it("negative polarity is stored on the record", async () => {
    const text = "这个项目不能使用 CGO";
    provider.register(text, contentVector(AX.create, AX.neg, AX.database, true));
    const result = await coordinator.remember(
      { content: text },
      { scopeContext: ctx, evidenceRef: await evidenceRefFor(ctx) },
    );
    expect(result.outcome).toBe("remembered");
    const record = await memory.get(result.id as string, { scopeContext: ctx });
    expect(record?.polarity).toBe("negative");
  }, 30_000);
});
