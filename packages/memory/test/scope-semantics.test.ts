/**
 * ScopeSemantics — unit tests for the phrase-free semantic scope planner.
 *
 * These tests inject prototype vectors and content vectors directly so the
 * decision rule is exercised deterministically. Open-expression semantic
 * generalization is validated against the live embedding model in the
 * integration/live suites (scope-routing probe, 18/18).
 */

import { describe, it, expect } from "vitest";

import { ScopeSemanticPlanner } from "../src/scope-semantics.js";
import type { PiScopeContext } from "../src/types.js";
import type { EmbeddingProvider, EmbeddingRequest, EmbeddingResponse } from "@pi-mentis/pi-mentis-inference";

// ─── Deterministic provider: content → a vector near the intended prototype ──

const DIM = 8;
// Axis layout: [user, project, repository, task, topic, durable, temporary, subject-user]
const AXES = {
  user: [1, 0, 0, 0, 0, 0, 0, 0],
  project: [0, 1, 0, 0, 0, 0, 0, 0],
  repository: [0, 0, 1, 0, 0, 0, 0, 0],
  task: [0, 0, 0, 1, 0, 0, 0, 0],
  topic: [0, 0, 0, 0, 1, 0, 0, 0],
  durable: [0, 0, 0, 0, 0, 1, 0, 0],
  temporary: [0, 0, 0, 0, 0, 0, 1, 0],
} as const;

type OwnerKind = "user" | "project" | "repository" | "task" | "topic";

function vectorFor(owner: OwnerKind, temporary: boolean): Float32Array {
  const base = [...AXES[owner]];
  base[temporary ? 6 : 5] = 1; // temporary or durable axis
  base[7] = owner === "user" ? 1 : 0; // subject-user axis
  return Float32Array.from(base);
}

class ScopeTestEmbeddingProvider implements EmbeddingProvider {
  readonly id = "scope-test";
  readonly #routing: ReadonlyMap<string, Float32Array>;

  constructor(routing: ReadonlyMap<string, Float32Array>) {
    this.#routing = routing;
  }

  async capabilities() {
    return { models: [] };
  }

  async health() {
    return { status: "healthy" as const, checkedAt: Date.now() };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    return {
      model: { providerId: this.id, modelId: "scope-test", capabilityVersion: "1" },
      vectors: request.inputs.map((input) => ({
        values: this.#routing.get(input) ?? new Float32Array(DIM),
        dimensions: request.dimensions,
        normalized: true,
      })),
      usage: { inputTokens: request.inputs.reduce((sum, text) => sum + text.length, 0) },
    };
  }
}

function prototypes(): Map<string, Float32Array[]> {
  const map = new Map<string, Float32Array[]>();
  map.set("user", [Float32Array.from(AXES.user)]);
  map.set("project", [Float32Array.from(AXES.project)]);
  map.set("repository", [Float32Array.from(AXES.repository)]);
  map.set("task", [Float32Array.from(AXES.task)]);
  map.set("topic", [Float32Array.from(AXES.topic)]);
  map.set("durable", [Float32Array.from(AXES.durable)]);
  map.set("temporary", [Float32Array.from(AXES.temporary)]);
  map.set("subject:user", [Float32Array.from([0, 0, 0, 0, 0, 0, 0, 1])]);
  return map;
}

function context(overrides: Partial<PiScopeContext> = {}): PiScopeContext {
  return {
    tenantId: "local",
    userId: "u1",
    appId: "pi",
    agentId: "test",
    repositoryId: "repo-1",
    projectId: "proj-1",
    taskId: "task-1",
    topicIds: ["topic-1"],
    ...overrides,
  };
}

function planner() {
  return new ScopeSemanticPlanner({
    embedding: new ScopeTestEmbeddingProvider(new Map()),
    dimensions: DIM,
    prototypeVectors: prototypes(),
  });
}

describe("ScopeSemanticPlanner.decideOwnership — open expressions", () => {
  const cases: readonly { label: string; owner: OwnerKind; temporary: boolean; expected: OwnerKind }[] = [
    // User scope: durable, personal habits/terminology
    { label: "Aether 是用户平时对快速原型模式的叫法", owner: "user", temporary: false, expected: "user" },
    { label: "用户长期更倾向于维护工作量小的实现", owner: "user", temporary: false, expected: "user" },
    { label: "用户经常在讨论里先给结论", owner: "user", temporary: false, expected: "user" },
    { label: "用户所有项目里都倾向使用 Go", owner: "user", temporary: false, expected: "user" },
    { label: "用户处理任务时喜欢先拆最小步骤", owner: "user", temporary: false, expected: "user" },
    { label: "用户平时把话题分成三个层次", owner: "user", temporary: false, expected: "user" },
    // Project / repository / task: narrow scope requires evidence
    { label: "Nebula 工程运行期禁止依赖外部 Python", owner: "project", temporary: true, expected: "project" },
    { label: "这个项目内部服务端口固定为 45671", owner: "project", temporary: true, expected: "project" },
    { label: "该代码库发布候选版本统一从 staging-next 产生", owner: "repository", temporary: true, expected: "repository" },
    { label: "当前迁移完成以前不调整索引格式", owner: "task", temporary: true, expected: "task" },
    // Topic: temporary naming with positive binding evidence
    { label: "眼下讨论的这个设计问题内暂且把第二种结构称作 T-branch", owner: "topic", temporary: true, expected: "topic" },
    { label: "只在这个 design thread 里 call option B Atlas", owner: "topic", temporary: true, expected: "topic" },
    { label: "这个 alias 只在 current design thread 里有效：K9 = candidate B", owner: "topic", temporary: true, expected: "topic" },
  ];

  for (const c of cases) {
    it(`${c.label} → ${c.expected}`, async () => {
      const plan = planner();
      const decision = await plan.decideOwnership(
        { content: c.label, embedding: vectorFor(c.owner, c.temporary) },
        context(),
      );
      expect(decision.ownerKind).toBe(c.expected);
    });
  }
});

describe("ScopeSemanticPlanner — keyword-looking counter-examples stay user", () => {
  // These are the acid test for the phrase-free refactor: the content MENTIONS
  // "讨论/项目/任务/话题" (words a keyword router would latch onto) but the
  // semantic content is a durable user habit → user scope. No phrase rules
  // exist anymore; routing + binding evidence decides.
  const counterExamples: readonly { label: string; owner: OwnerKind; temporary: boolean }[] = [
    { label: "我经常在讨论里先给结论。", owner: "user", temporary: false },
    { label: "我所有项目里都倾向使用 Go。", owner: "user", temporary: false },
    { label: "我处理任务时喜欢先拆最小步骤。", owner: "user", temporary: false },
    { label: "我平时把话题分成三个层次。", owner: "user", temporary: false },
  ];

  for (const c of counterExamples) {
    it(`${c.label} → user (durable habit, not topic/task/project)`, async () => {
      const plan = planner();
      const decision = await plan.decideOwnership(
        { content: c.label, embedding: vectorFor(c.owner, c.temporary) },
        context(),
      );
      expect(decision.ownerKind).toBe("user");
    });
  }
});

describe("ScopeSemanticPlanner — context only supplies owner ids, never owner kind", () => {
  it("user fact stays user even when task/topic/repo are active", async () => {
    const plan = planner();
    const decision = await plan.decideOwnership(
      { content: "user habit", embedding: vectorFor("user", false) },
      context({ taskId: "task-9", topicIds: ["topic-9"], repositoryId: "repo-9" }),
    );
    expect(decision.ownerKind).toBe("user");
    expect(decision.ownerId).toBe("u1");
  });

  it("project owner resolves to the active project id", async () => {
    const plan = planner();
    const decision = await plan.decideOwnership(
      { content: "project rule", embedding: vectorFor("project", true) },
      context({ projectId: "proj-7" }),
    );
    expect(decision.ownerKind).toBe("project");
    expect(decision.ownerId).toBe("proj-7");
  });

  it("repository owner resolves to the active repository id", async () => {
    const plan = planner();
    const decision = await plan.decideOwnership(
      { content: "repo rule", embedding: vectorFor("repository", true) },
      context({ repositoryId: "repo-7" }),
    );
    expect(decision.ownerKind).toBe("repository");
    expect(decision.ownerId).toBe("repo-7");
  });

  it("task owner resolves to the active task id", async () => {
    const plan = planner();
    const decision = await plan.decideOwnership(
      { content: "task rule", embedding: vectorFor("task", true) },
      context({ taskId: "task-7" }),
    );
    expect(decision.ownerKind).toBe("task");
    expect(decision.ownerId).toBe("task-7");
  });

  it("topic owner resolves to the active topic id", async () => {
    const plan = planner();
    const decision = await plan.decideOwnership(
      { content: "topic alias", embedding: vectorFor("topic", true) },
      context({ topicIds: ["topic-7"] }),
    );
    expect(decision.ownerKind).toBe("topic");
    expect(decision.ownerId).toBe("topic-7");
  });

  it("topic decision with no active topic falls back to user (durable default)", async () => {
    const plan = planner();
    const decision = await plan.decideOwnership(
      { content: "topic alias", embedding: vectorFor("topic", true) },
      context({ topicIds: [] }),
    );
    expect(decision.ownerKind).toBe("user");
  });
});

describe("ScopeSemanticPlanner — narrow scope requires evidence", () => {
  it("low margin between user and topic favors user", async () => {
    const plan = planner();
    // Mixed vector: 0.5 user + 0.5 topic, temporary axis set → margin small
    const mixed = Float32Array.from([0.5, 0, 0, 0, 0.5, 0, 1, 0.5]);
    const decision = await plan.decideOwnership({ content: "mixed", embedding: mixed }, context());
    expect(decision.ownerKind).toBe("user");
  });

  it("degraded planner falls back to durable user", async () => {
    const failing = new ScopeSemanticPlanner({
      embedding: new ScopeTestEmbeddingProvider(new Map()),
      dimensions: DIM,
      prototypeVectors: prototypes(),
    });
    const decision = await failing.decideOwnership(
      { content: "anything", embedding: new Float32Array(DIM) },
      context(),
    );
    // Zero vector → no routing signal → durable user
    expect(decision.ownerKind).toBe("user");
  });
});

describe("resolveOwnerId / memoryScopeForDecision", () => {
  it("maps decision to MemoryScope", async () => {
    const { memoryScopeForDecision } = await import("../src/scope-semantics.js");
    const plan = planner();
    const decision = await plan.decideOwnership(
      { content: "user habit", embedding: vectorFor("user", false) },
      context(),
    );
    const scope = memoryScopeForDecision(decision, context());
    expect(scope).toEqual({ kind: "user", id: "u1" });
  });
});
