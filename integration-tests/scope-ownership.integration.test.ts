/**
 * Scope Ownership E2E — the P0 acceptance matrix, driven through the REAL
 * memory service + coordinator, with the semantic scope planner.
 *
 * Scope semantics are exercised via hand-crafted prototype/content vectors
 * (deterministic, phrase-free); open-expression generalization against the
 * live embedding model is covered by the live probe (18/18).
 *
 * Matrix covered:
 *   A. user fact → user scope → cross-session natural query recall
 *   B. user preference → user scope → cross-session recall
 *   C. project fact → project scope → cross-project isolation
 *   D. topic fact → topic scope → cross-topic isolation
 *   E. durable-default user when no narrow evidence
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { normalizeText, type EvidenceRef } from "@pi-mentis/pi-mentis-core";
import type { EmbeddingProvider, EmbeddingRequest, EmbeddingResponse } from "@pi-mentis/pi-mentis-inference";
import { ZvecStore } from "@pi-mentis/pi-mentis-zvec";

import {
  createMemoryService,
  createPiEvidenceStore,
  DefaultRememberCoordinator,
  ScopeSemanticPlanner,
  type PiScopeContext,
  type PiEpisode,
  type PiEvent,
} from "@pi-mentis/pi-mentis-memory-core";
import { testStorage, embeddingSpace } from "./helpers.js";

// ─── Deterministic semantic-ish embedding ─────────────────────────
// 8 axes: [user, project, repository, task, topic, durable, temporary, subjectUser]

const DIM = 8;

function basis(axis: number): Float32Array {
  const v = new Float32Array(DIM);
  v[axis] = 1;
  return v;
}

const AXIS = {
  user: 0,
  project: 1,
  repository: 2,
  task: 3,
  topic: 4,
  durable: 5,
  temporary: 6,
  subjectUser: 7,
} as const;

/** Content vector for a fact owned by `owner`, with durable or temporary binding. */
function factVector(owner: keyof typeof AXIS, temporary: boolean): Float32Array {
  const v = new Float32Array(DIM);
  v[AXIS[owner]] = 1;
  v[temporary ? AXIS.temporary : AXIS.durable] = 1;
  if (owner === "user") v[AXIS.subjectUser] = 1;
  return v;
}

function queryVector(text: string): Float32Array {
  // Deterministic n-gram vector so lexical similarity drives dense recall.
  const v = new Float32Array(DIM);
  let acc = 0;
  for (let i = 0; i < text.length; i++) {
    acc = (acc * 31 + (text.charCodeAt(i) ?? 0)) >>> 0;
    v[acc % DIM] = (v[acc % DIM] ?? 0) + 1;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

class MatrixEmbeddingProvider implements EmbeddingProvider {
  readonly id = "matrix-test";
  readonly #contentVectors = new Map<string, Float32Array>();

  register(content: string, owner: keyof typeof AXIS, temporary: boolean): void {
    this.#contentVectors.set(normalizeText(content), factVector(owner, temporary));
  }

  async capabilities() {
    return { models: [] };
  }

  async health() {
    return { status: "healthy" as const, checkedAt: Date.now() };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    return {
      model: { providerId: this.id, modelId: "matrix-test", capabilityVersion: "1" },
      vectors: request.inputs.map((input) => {
        const semantic = this.#contentVectors.get(normalizeText(input));
        const lexical = queryVector(input);
        // Real embeddings preserve lexical similarity between content and
        // query: blend the semantic axes with the lexical n-gram vector.
        const values = new Float32Array(DIM);
        if (semantic !== undefined) {
          for (let i = 0; i < DIM; i++) values[i] = (values[i] ?? 0) + semantic[i] * 1.0;
        }
        for (let i = 0; i < DIM; i++) values[i] = (values[i] ?? 0) + lexical[i] * 0.4;
        let norm = 0;
        for (const x of values) norm += x * x;
        norm = Math.sqrt(norm) || 1;
        for (let i = 0; i < DIM; i++) values[i] = (values[i] ?? 0) / norm;
        return { values, dimensions: request.dimensions, normalized: true };
      }),
      usage: { inputTokens: request.inputs.reduce((sum, text) => sum + text.length, 0) },
    };
  }
}

function prototypeVectors(): Map<string, Float32Array[]> {
  const map = new Map<string, Float32Array[]>();
  map.set("user", [basis(AXIS.user)]);
  map.set("project", [basis(AXIS.project)]);
  map.set("repository", [basis(AXIS.repository)]);
  map.set("task", [basis(AXIS.task)]);
  map.set("topic", [basis(AXIS.topic)]);
  map.set("durable", [basis(AXIS.durable)]);
  map.set("temporary", [basis(AXIS.temporary)]);
  map.set("subject:user", [basis(AXIS.subjectUser)]);
  return map;
}

// ─── Contexts ─────────────────────────────────────────────────────

function ctx(overrides: Partial<PiScopeContext> = {}): PiScopeContext {
  return {
    tenantId: "local",
    userId: "u1",
    appId: "pi",
    agentId: "pi-mentis",
    ...overrides,
  };
}

const sessionA = ctx({
  sessionId: "session-A",
  repositoryId: "repo-A",
  projectId: "proj-A",
  taskId: "task-A",
  topicIds: ["topic-A"],
});
const sessionB = ctx({
  sessionId: "session-B",
  repositoryId: "repo-A",
  projectId: "proj-A",
  taskId: "task-B",
  topicIds: ["topic-B"],
});
const projectB = ctx({
  sessionId: "session-C",
  repositoryId: "repo-B",
  projectId: "proj-B",
  taskId: "task-C",
  topicIds: ["topic-C"],
});

// ─── Harness ──────────────────────────────────────────────────────

let store: ZvecStore;
let rootDir: string;
const space = embeddingSpace(DIM);

beforeAll(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), "pi-mentis-scope-e2e-"));
  store = new ZvecStore(testStorage(rootDir));
  await store.start({ knowledge: space, memory: space, capability: space });
});

afterAll(async () => {
  await store.close();
  await rm(rootDir, { recursive: true, force: true });
});

/** Production commits carry a goal-event evidence ref; without it, user
 *  authority is demoted and the memory stays pending. Mirror that here. */
async function evidenceRefFor(scopeContext: PiScopeContext): Promise<EvidenceRef> {
  const evidence = createPiEvidenceStore(store);
  const boundary = [scopeContext.tenantId, scopeContext.userId, scopeContext.appId, scopeContext.agentId]
    .map(encodeURIComponent)
    .join(":");
  const episodeId = `ep-${scopeContext.sessionId ?? "s"}`;
  const episode: PiEpisode = {
    id: episodeId,
    sessionId: scopeContext.sessionId ?? "session",
    securityNamespace: boundary,
    branchId: scopeContext.branchId ?? "root",
    topicIds: scopeContext.topicIds ?? [],
    goal: "test",
    startedAt: Date.now(),
    status: "running",
    firstSequence: 1,
    lastSequence: 1,
  };
  await evidence.createEpisode(episode);
  const event: PiEvent = {
    id: `ev-${scopeContext.sessionId ?? "s"}`,
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

describe("Scope Ownership P0 matrix (semantic planner, no phrase rules)", () => {
  const provider = new MatrixEmbeddingProvider();
  let planner: ScopeSemanticPlanner;
  let memory: ReturnType<typeof createMemoryService>;
  let coordinator: DefaultRememberCoordinator;

  beforeAll(async () => {
    planner = new ScopeSemanticPlanner({
      embedding: provider,
      dimensions: DIM,
      prototypeVectors: prototypeVectors(),
    });
    memory = createMemoryService({
      store,
      embedding: provider,
      embeddingSpace: space,
      dimensions: DIM,
      viewsEnabled: false,
    });
    coordinator = new DefaultRememberCoordinator(memory, planner);
  });

  it("A. user fact → user scope → recalled in a new session", async () => {
    provider.register("我把自己的本地试验区叫'青沐'。", "user", false);
    const t0 = Date.now();
    const commit = await coordinator.remember(
      { content: "我把自己的本地试验区叫'青沐'。" },
      { scopeContext: sessionA, evidenceRef: await evidenceRefFor(sessionA) },
    );
    console.log("A commit ms:", Date.now() - t0);
    expect(commit.outcome).toBe("remembered");
    expect(commit.id).toBeDefined();

    const t1 = Date.now();
    const record = await memory.get(commit.id as string, { scopeContext: sessionA });
    console.log("A get ms:", Date.now() - t1);
    expect(record?.scope.kind).toBe("user");
    expect(record?.scope.id).toBe("u1");

    // /new: different task + topic, same user
    const search = await memory.search(
      { text: "我的本地试验区叫什么名字？", limit: 5, scopeContext: sessionB, scopes: [{ kind: "user", id: "u1" }] },
      { timeoutMs: 5_000 },
    );
    expect(search.hits.some((hit) => hit.id === commit.id)).toBe(true);
  });

  it("B. user preference → user scope → recalled across sessions", async () => {
    provider.register("我更喜欢维护成本低的方案。", "user", false);

    const commit = await coordinator.remember(
      { content: "我更喜欢维护成本低的方案。" },
      { scopeContext: sessionA, evidenceRef: await evidenceRefFor(sessionA) },
    );
    expect(commit.outcome).toBe("remembered");
    const record = await memory.get(commit.id as string, { scopeContext: sessionA });
    expect(record?.scope.kind).toBe("user");

    const search = await memory.search(
      { text: "技术方案选择上我更看重什么？", limit: 5, scopeContext: sessionB, scopes: [{ kind: "user", id: "u1" }] },
      { timeoutMs: 5_000 },
    );
    expect(search.hits.some((hit) => hit.id === commit.id)).toBe(true);
  });

  it("C. project fact → project scope → isolated from another project", async () => {
    provider.register("这个项目内部服务端口固定为 45671。", "project", true);

    const commit = await coordinator.remember(
      { content: "这个项目内部服务端口固定为 45671。" },
      { scopeContext: sessionA, evidenceRef: await evidenceRefFor(sessionA) },
    );
    expect(commit.outcome).toBe("remembered");
    const record = await memory.get(commit.id as string, { scopeContext: sessionA });
    expect(record?.scope.kind).toBe("project");
    expect(record?.scope.id).toBe("proj-A");

    // Same query from project B must NOT recall A's fact
    const otherProject = await memory.search(
      { text: "内部服务端口是多少？", limit: 5, scopeContext: projectB, scopes: [{ kind: "project", id: "proj-B" }, { kind: "user", id: "u1" }] },
      { timeoutMs: 5_000 },
    );
    expect(otherProject.hits.some((hit) => hit.id === commit.id)).toBe(false);

    // Same project still recalls it
    const sameProject = await memory.search(
      { text: "内部服务端口是多少？", limit: 5, scopeContext: sessionB, scopes: [{ kind: "project", id: "proj-A" }, { kind: "user", id: "u1" }] },
      { timeoutMs: 5_000 },
    );
    expect(sameProject.hits.some((hit) => hit.id === commit.id)).toBe(true);
  });

  it("D. topic fact → topic scope → isolated from a new topic", async () => {
    provider.register("在眼下讨论的这个设计问题内，暂且把第二种结构称作 T-branch。", "topic", true);

    const commit = await coordinator.remember(
      { content: "在眼下讨论的这个设计问题内，暂且把第二种结构称作 T-branch。" },
      { scopeContext: sessionA, evidenceRef: await evidenceRefFor(sessionA) },
    );
    expect(commit.outcome).toBe("remembered");
    const record = await memory.get(commit.id as string, { scopeContext: sessionA });
    expect(record?.scope.kind).toBe("topic");
    expect(record?.scope.id).toBe("topic-A");

    // New topic (topic-B): the old topic's alias must NOT be recalled
    const newTopic = await memory.search(
      { text: "第二种结构临时叫什么？", limit: 5, scopeContext: sessionB, scopes: [{ kind: "topic", id: "topic-B" }, { kind: "user", id: "u1" }] },
      { timeoutMs: 5_000 },
    );
    expect(newTopic.hits.some((hit) => hit.id === commit.id)).toBe(false);

    // Same topic still recalls it
    const sameTopic = await memory.search(
      { text: "第二种结构临时叫什么？", limit: 5, scopeContext: sessionA, scopes: [{ kind: "topic", id: "topic-A" }, { kind: "user", id: "u1" }] },
      { timeoutMs: 5_000 },
    );
    expect(sameTopic.hits.some((hit) => hit.id === commit.id)).toBe(true);
  });

  it("E. durable-default: no narrow evidence → user, even with active task/topic", async () => {
    // Content vector aligned with user + durable (no narrow axis)
    provider.register("我长期更倾向于维护工作量小的实现。", "user", false);

    const commit = await coordinator.remember(
      { content: "我长期更倾向于维护工作量小的实现。" },
      { scopeContext: sessionA, evidenceRef: await evidenceRefFor(sessionA) },
    );
    const record = await memory.get(commit.id as string, { scopeContext: sessionA });
    expect(record?.scope.kind).toBe("user");

    // Cross-session recall (user scope is always in query scopes)
    const search = await memory.search(
      { text: "实现选择上倾向于什么？", limit: 5, scopeContext: sessionB, scopes: [{ kind: "user", id: "u1" }] },
      { timeoutMs: 5_000 },
    );
    expect(search.hits.some((hit) => hit.id === commit.id)).toBe(true);
  });
});
