import { describe, expect, it, vi } from "vitest";

import { estimateModelTokens, type Clock, type EvidenceRef } from "@pi-mentis/pi-mentis-core";
import type { StoredRecord, ZvecStore } from "@pi-mentis/pi-mentis-zvec";

import {
  MemoryCandidateService,
  TaskEpisodeService,
  WorkingMemoryService,
  buildCandidateCognitionInput,
  createExperienceLearningService,
  createTaskEpisodeDigest,
  detectMemoryCandidateTrigger,
  deriveTaskEpisodeExperienceObservation,
  parseEpisodeConsolidationProposal,
  validateConsolidationEvidence,
  type MemoryService,
  type OutcomeStatus,
  type PiEpisode,
  type PiEvent,
  type PiScopeContext,
} from "../src/index.js";

class TestClock implements Clock {
  value = 1_000;
  now(): number {
    return this.value++;
  }
}

class ScalarStore {
  readonly records = new Map<string, StoredRecord>();

  fetchScalar(_collection: string, ids: readonly string[]) {
    return Promise.resolve(
      new Map(
        ids
          .map((id) => [id, this.records.get(id)?.payload] as const)
          .filter(
            (entry): entry is readonly [string, Readonly<Record<string, unknown>>] =>
              entry[1] !== undefined,
          ),
      ),
    );
  }

  upsertScalar(_collection: string, records: readonly StoredRecord[]) {
    for (const record of records) this.records.set(record.id, record);
    return Promise.resolve();
  }

  deleteScalar(_collection: string, ids: readonly string[]) {
    for (const id of ids) this.records.delete(id);
    return Promise.resolve();
  }

  filterScalar(_collection: string, filter: string) {
    const kind = filter.match(/kind = "([^"]+)"/u)?.[1];
    const namespace = filter.match(/namespace = "([^"]+)"/u)?.[1];
    return Promise.resolve(
      [...this.records.values()]
        .filter(
          (record) =>
            (kind === undefined || record.kind === kind) &&
            (namespace === undefined || record.namespace === namespace),
        )
        .map((record) => ({
          id: record.id,
          fields: { payload: JSON.stringify(record.payload) },
        })) as never,
    );
  }
}

const limits = {
  promptTokens: 220,
  hardMaxTokens: 1_200,
  maxConfirmed: 4,
  maxHypotheses: 3,
  maxOpenLoops: 3,
  maxRecentOutcomes: 4,
  maxActiveResources: 4,
} as const;

function scope(overrides: Partial<PiScopeContext> = {}): PiScopeContext {
  return {
    tenantId: "tenant",
    userId: "user",
    appId: "pi",
    agentId: "agent",
    sessionId: "session",
    branchId: "root",
    repositoryId: "repo",
    projectId: "project",
    taskId: "task",
    ...overrides,
  };
}

function episode(id: string, goal: string, overrides: Partial<PiEpisode> = {}): PiEpisode {
  return {
    id,
    sessionId: "session",
    securityNamespace: "tenant:user:pi:agent",
    branchId: "root",
    taskId: "task",
    topicIds: [],
    goal,
    startedAt: 1_000,
    endedAt: 1_100,
    status: "partial",
    firstSequence: 1,
    lastSequence: 1,
    ...overrides,
  };
}

function event(
  id: string,
  kind: PiEvent["kind"],
  sequence: number,
  payload: Readonly<Record<string, unknown>>,
  extras: Partial<PiEvent> = {},
): PiEvent {
  return {
    id,
    episodeId: "episode",
    securityNamespace: "tenant:user:pi:agent",
    sequence,
    kind,
    timestamp: 1_000 + sequence,
    payload,
    ...extras,
  };
}

const partial: OutcomeStatus = {
  executionStatus: "partial",
  verificationStatus: "not_run",
  taskStatus: "partial",
};

describe("WorkingMemoryService", () => {
  it("keeps the original goal across 20 continuation turns and remains bounded", async () => {
    const store = new ScalarStore();
    const service = new WorkingMemoryService(
      store as unknown as ZvecStore,
      limits,
      new TestClock(),
    );
    let state = await service.applyEpisode({
      scopeContext: scope(),
      episode: episode("e0", "修复并验证内存恢复问题"),
      events: [event("g0", "goal", 1, { goal: "修复并验证内存恢复问题" })],
      outcome: partial,
      taskId: "task",
    });
    for (let index = 1; index <= 20; index++) {
      state = await service.applyEpisode({
        scopeContext: scope(),
        episode: episode(`e${index}`, `继续处理第 ${index} 步`),
        events: [event(`g${index}`, "goal", 1, { goal: `继续处理第 ${index} 步` })],
        outcome: partial,
        taskId: "task",
      });
    }
    expect(state.goal?.text).toBe("修复并验证内存恢复问题");
    const snapshot = service.snapshot(state);
    expect(snapshot.estimatedTokens).toBeLessThanOrEqual(limits.promptTokens);
    expect(estimateModelTokens(snapshot.content)).toBeLessThanOrEqual(limits.promptTokens);
  });

  it("tracks failure/open-loop, closes it after verification, and never stores raw large output", async () => {
    const store = new ScalarStore();
    const service = new WorkingMemoryService(
      store as unknown as ZvecStore,
      limits,
      new TestClock(),
    );
    const large = "raw-secret-free-output ".repeat(10_000);
    const failedEvents = [
      event("goal", "goal", 1, { goal: "fix tests" }),
      event(
        "call",
        "tool_call",
        2,
        { toolName: "bash", input: { command: "pnpm test" } },
        { toolCallId: "t" },
      ),
      event(
        "failure",
        "tool_result",
        3,
        {
          result: {
            tool: "bash",
            status: "failed",
            keyErrors: ["one test failed"],
            preview: large,
            artifactId: "artifact-1",
          },
        },
        { toolCallId: "t", artifactRef: { kind: "artifact", id: "artifact-1", observedAt: 1_003 } },
      ),
    ];
    let state = await service.applyEpisode({
      scopeContext: scope(),
      episode: episode("e1", "fix tests"),
      events: failedEvents,
      outcome: { executionStatus: "failed", verificationStatus: "failed", taskStatus: "failed" },
      taskId: "task",
    });
    expect(state.openLoops.some((item) => item.state === "active")).toBe(true);
    expect(JSON.stringify(state)).not.toContain(large.slice(0, 500));
    expect(state.artifactRefs).toContain("artifact-1");

    state = await service.applyEpisode({
      scopeContext: scope(),
      episode: episode("e2", "继续验证"),
      events: [
        event("verify", "verification", 1, {
          command: "pnpm test",
          status: "passed",
          targetEvidenceIds: ["failure"],
        }),
      ],
      outcome: {
        executionStatus: "success",
        verificationStatus: "passed",
        taskStatus: "completed",
      },
      taskId: "task",
    });
    expect(state.openLoops.every((item) => item.state !== "active")).toBe(true);
    expect(state.confirmed.some((item) => item.text.includes("pnpm test"))).toBe(true);
  });

  it("bounds duplicate resources/outcomes and redacts secrets from model-visible state", async () => {
    const store = new ScalarStore();
    const service = new WorkingMemoryService(
      store as unknown as ZvecStore,
      limits,
      new TestClock(),
    );
    let state = await service.loadOrCreate(scope(), "session", "root");
    for (let index = 0; index < 20; index++) {
      state = await service.applyEpisode({
        scopeContext: scope(),
        episode: episode(`bounded-${index}`, "继续修复"),
        events: [
          event(
            `call-${index}`,
            "tool_call",
            1,
            { toolName: "bash", input: { command: `pnpm test ${index % 2}` } },
            { toolCallId: `tool-${index}` },
          ),
          event(
            `result-${index}`,
            "tool_result",
            2,
            { result: { tool: "bash", status: "completed" } },
            { toolCallId: `tool-${index}` },
          ),
        ],
        outcome: partial,
        taskId: "task",
      });
    }
    state =
      (await service.recordHypothesis(
        scope(),
        "API key is sk-abcdefghijklmnopqrstuvwxyz1234567890",
      )) ?? state;
    expect(state.activeResources.length).toBeLessThanOrEqual(limits.maxActiveResources);
    expect(state.recentOutcomes.length).toBeLessThanOrEqual(limits.maxRecentOutcomes);
    expect(service.snapshot(state).content).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("isolates branch forks, restores checkpoints, and invalidates only model hypotheses", async () => {
    const store = new ScalarStore();
    const clock = new TestClock();
    const service = new WorkingMemoryService(store as unknown as ZvecStore, limits, clock);
    await service.applyEpisode({
      scopeContext: scope(),
      episode: episode("p", "parent goal"),
      events: [
        event("pg", "goal", 1, { goal: "parent goal" }),
        event("pv", "verification", 2, { command: "pnpm test", status: "passed" }),
      ],
      outcome: {
        executionStatus: "success",
        verificationStatus: "passed",
        taskStatus: "completed",
      },
      taskId: "task",
    });
    await service.recordHypothesis(scope(), "the cache is stale");
    const childScope = scope({ branchId: "child", parentBranchId: "root" });
    await service.loadOrCreate(childScope, "session", "child", "root");
    const child = await service.applyEpisode({
      scopeContext: childScope,
      episode: episode("c", "new direction", { branchId: "child", parentBranchId: "root" }),
      events: [event("steer", "steering", 1, { updatedGoal: "new direction" })],
      outcome: partial,
      taskId: "task",
    });
    expect(child.hypotheses.some((item) => item.state === "invalidated")).toBe(true);
    expect(child.confirmed.some((item) => item.state === "confirmed")).toBe(true);
    const restoredParent = await new WorkingMemoryService(
      store as unknown as ZvecStore,
      limits,
      clock,
    ).restore(scope(), "session", "root");
    expect(restoredParent?.hypotheses.some((item) => item.state === "active")).toBe(true);
    expect(restoredParent?.goal?.text).toBe("parent goal");
    expect(child.confirmed).not.toBe(restoredParent?.confirmed);
    expect(Object.isFrozen(child.confirmed)).toBe(true);
    expect(Object.isFrozen(child.confirmed[0])).toBe(true);
  });

  it("resets all task-local state while preserving ambient recalled resources", async () => {
    const store = new ScalarStore();
    const service = new WorkingMemoryService(
      store as unknown as ZvecStore,
      limits,
      new TestClock(),
    );
    await service.applyEpisode({
      scopeContext: scope(),
      episode: episode("task-a", "finish task A"),
      events: [event("verified-a", "verification", 1, { command: "test A", status: "passed" })],
      outcome: {
        executionStatus: "success",
        verificationStatus: "passed",
        taskStatus: "completed",
      },
      taskId: "task-a",
    });
    await service.recordRecalledMemory(scope(), ["durable-memory"]);
    const next = await service.applyEpisode({
      scopeContext: scope(),
      episode: episode("task-b", "start task B"),
      events: [event("goal-b", "goal", 1, { goal: "start task B" })],
      outcome: partial,
      taskId: "task-b",
    });
    expect(next.confirmed).toEqual([]);
    expect(next.decisions).toEqual([]);
    expect(next.openLoops).toEqual([]);
    expect(next.recalledMemoryIds).toContain("durable-memory");
  });

  it("does not close an open loop for an unrelated passing verification", async () => {
    const store = new ScalarStore();
    const service = new WorkingMemoryService(
      store as unknown as ZvecStore,
      limits,
      new TestClock(),
    );
    await service.applyEpisode({
      scopeContext: scope(),
      episode: episode("failure", "repair database migration"),
      events: [
        event(
          "migration-failed",
          "tool_result",
          1,
          { result: { tool: "migration", status: "failed", keyErrors: ["schema mismatch"] } },
          { toolCallId: "migration-call" },
        ),
      ],
      outcome: { executionStatus: "failed", verificationStatus: "failed", taskStatus: "failed" },
      taskId: "task",
    });
    const state = await service.applyEpisode({
      scopeContext: scope(),
      episode: episode("lint", "run lint"),
      events: [event("lint-passed", "verification", 1, { command: "pnpm lint", status: "passed" })],
      outcome: { executionStatus: "success", verificationStatus: "passed", taskStatus: "partial" },
      taskId: "task",
    });
    expect(state.openLoops.some((loop) => loop.state === "active")).toBe(true);
  });
});

describe("automatic memory candidates", () => {
  const support = (evidenceId: string) => [{ evidenceId, relation: "entailed" as const }];
  const policy = {
    autoPromotion: false,
    maxCandidatesPerTurn: 3,
    candidateMaxCharacters: 500,
    candidateTtlMs: 86_400_000,
    minimumPreferenceObservations: 2,
    minimumBehaviorObservations: 3,
  } as const;

  it("uses conservative cheap triggers", () => {
    expect(detectMemoryCandidateTrigger("先试试 pnpm").shouldAnalyze).toBe(false);
    expect(detectMemoryCandidateTrigger("以后这个项目统一使用 pnpm").shouldAnalyze).toBe(true);
    expect(detectMemoryCandidateTrigger("我通常喜欢简洁回答").shouldAnalyze).toBe(true);
    expect(detectMemoryCandidateTrigger("不对，默认端口已经改成 51842").shouldAnalyze).toBe(true);
    expect(detectMemoryCandidateTrigger("帮我看看这个文件").shouldAnalyze).toBe(false);
  });

  it("bounds the candidate cognition request with the model token estimator", () => {
    const namespace = "tenant:user:pi:agent";
    const payload = buildCandidateCognitionInput({
      statement: `以后这个项目统一使用 pnpm ${"context ".repeat(2_000)}`,
      scopeContext: scope(),
      signals: detectMemoryCandidateTrigger("以后这个项目统一使用 pnpm"),
      evidence: Array.from({ length: 20 }, (_, index) => ({
        id: `e${index}`,
        ref: { kind: "event" as const, id: `e${index}`, observedAt: index },
        namespace,
        text: "以后这个项目统一使用 pnpm ".repeat(200),
        verified: false,
      })),
      maxTokens: 180,
    });
    expect(payload["estimatedTokens"]).toBeLessThanOrEqual(180);
    expect(estimateModelTokens(String(payload["serialized"]))).toBeLessThanOrEqual(180);
  });

  it("reinforces independent preference evidence but ignores duplicate evidence and shadow mode never commits", async () => {
    const store = new ScalarStore();
    const commit = vi.fn();
    const service = new MemoryCandidateService(
      store as unknown as ZvecStore,
      { commit } as unknown as MemoryService,
      policy,
      new TestClock(),
    );
    const namespace = "tenant:user:pi:agent";
    const evidence = (id: string, text: string) => ({
      id,
      ref: { kind: "event" as const, id, observedAt: 1_000 },
      namespace,
      text,
      verified: false,
      sourceKind: "user" as const,
      firstPersonPreferenceEvidence: true,
      allowedScopeCeiling: "user" as const,
    });
    const proposal = {
      content: "我通常喜欢简洁回答",
      scopeHint: "user" as const,
      confidence: 0.95,
      durability: 0.9,
      evidenceIds: ["e1"],
      support: support("e1"),
    };
    const first = await service.observe({
      proposal,
      source: "user_statement",
      scopeContext: scope(),
      evidence: [evidence("e1", "我通常喜欢简洁回答")],
      observationId: "observation-1",
    });
    expect(first.outcome).toBe("created");
    const restarted = new MemoryCandidateService(
      store as unknown as ZvecStore,
      { commit } as unknown as MemoryService,
      policy,
      new TestClock(),
    );
    await restarted.observe({
      proposal,
      source: "user_statement",
      scopeContext: scope(),
      evidence: [evidence("e1", "我通常喜欢简洁回答")],
      observationId: "observation-1",
    });
    const reinforced = await restarted.observe({
      proposal: { ...proposal, evidenceIds: ["e2"], support: support("e2") },
      source: "user_statement",
      scopeContext: scope({ sessionId: "session-2" }),
      evidence: [evidence("e2", "我一般喜欢简洁回答")],
      observationId: "observation-2",
    });
    expect(reinforced.outcome).toBe("reinforced");
    if (reinforced.outcome !== "rejected") {
      expect(reinforced.candidate.state).toBe("eligible");
      expect(reinforced.candidate.observations).toHaveLength(2);
    }
    expect(commit).not.toHaveBeenCalled();
  });

  it("rejects model hypotheses, secrets, and cross-namespace evidence", async () => {
    const store = new ScalarStore();
    const service = new MemoryCandidateService(
      store as unknown as ZvecStore,
      { commit: vi.fn() } as unknown as MemoryService,
      policy,
      new TestClock(),
    );
    const proposal = {
      content: "用户应该喜欢 pnpm",
      scopeHint: "user" as const,
      confidence: 0.9,
      durability: 0.9,
      evidenceIds: ["e"],
      support: support("e"),
    };
    const evidence = [
      {
        id: "e",
        ref: { kind: "event" as const, id: "e", observedAt: 1 },
        namespace: "other:user:pi:agent",
        text: "用户应该喜欢 pnpm",
        verified: false,
      },
    ];
    expect(
      (
        await service.observe({
          proposal,
          source: "model_hypothesis",
          scopeContext: scope(),
          evidence,
          observationId: "m",
        })
      ).outcome,
    ).toBe("rejected");
    expect(
      (
        await service.observe({
          proposal,
          source: "user_statement",
          scopeContext: scope(),
          evidence,
          observationId: "x",
        })
      ).outcome,
    ).toBe("rejected");
    expect(
      (
        await service.observe({
          proposal: { ...proposal, content: "API key is sk-abcdefghijklmnopqrstuvwxyz1234567890" },
          source: "user_statement",
          scopeContext: scope(),
          evidence: [
            {
              ...evidence[0]!,
              namespace: "tenant:user:pi:agent",
              text: "API key is sk-abcdefghijklmnopqrstuvwxyz1234567890",
            },
          ],
          observationId: "s",
        })
      ).outcome,
    ).toBe("rejected");
  });

  it("rejects unverified tool facts and never widens repository evidence to user scope", async () => {
    const store = new ScalarStore();
    const commit = vi.fn();
    const service = new MemoryCandidateService(
      store as unknown as ZvecStore,
      { commit } as unknown as MemoryService,
      { ...policy, autoPromotion: true },
      new TestClock(),
    );
    const proposal = {
      content: "repository package manager is pnpm",
      scopeHint: "user" as const,
      confidence: 0.95,
      durability: 0.95,
      evidenceIds: ["tool"],
      support: support("tool"),
    };
    const unverified = await service.observe({
      proposal,
      source: "verified_tool",
      scopeContext: scope(),
      evidence: [
        {
          id: "tool",
          ref: { kind: "event", id: "tool", observedAt: 1 },
          namespace: "tenant:user:pi:agent",
          text: "repository package manager is pnpm",
          verified: false,
          sourceKind: "tool",
          allowedScopeCeiling: "repository",
        },
      ],
      observationId: "tool-unverified",
    });
    expect(unverified.outcome).toBe("rejected");

    const verified = await service.observe({
      proposal,
      source: "verified_tool",
      scopeContext: scope(),
      evidence: [
        {
          id: "tool",
          ref: { kind: "event", id: "tool", observedAt: 1 },
          namespace: "tenant:user:pi:agent",
          text: "repository package manager is pnpm",
          verified: true,
          structural: true,
          sourceKind: "manifest",
          allowedScopeCeiling: "repository",
        },
      ],
      observationId: "tool-verified",
    });
    expect(verified.outcome).not.toBe("promoted");
    if (verified.outcome !== "rejected") {
      expect(verified.candidate.proposedScope).toEqual({ kind: "repository", id: "repo" });
    }
    expect(commit).not.toHaveBeenCalled();
  });

  it("keeps equivalent project candidates isolated across projects", async () => {
    const store = new ScalarStore();
    const service = new MemoryCandidateService(
      store as unknown as ZvecStore,
      { commit: vi.fn() } as unknown as MemoryService,
      policy,
      new TestClock(),
    );
    const observe = (projectId: string, evidenceId: string) =>
      service.observe({
        proposal: {
          content: "project default port is 51842",
          scopeHint: "project",
          confidence: 0.95,
          durability: 0.95,
          evidenceIds: [evidenceId],
          support: support(evidenceId),
        },
        source: "user_correction",
        scopeContext: scope({ projectId }),
        evidence: [
          {
            id: evidenceId,
            ref: { kind: "event", id: evidenceId, observedAt: 1 },
            namespace: "tenant:user:pi:agent",
            text: "project default port is 51842",
            verified: false,
            sourceKind: "user",
            explicitCorrection: true,
            allowedScopeCeiling: "project",
          },
        ],
        observationId: evidenceId,
      });
    const first = await observe("project-a", "a");
    const second = await observe("project-b", "b");
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("created");
    if (first.outcome !== "rejected" && second.outcome !== "rejected") {
      expect(first.candidate.id).not.toBe(second.candidate.id);
    }
  });

  it("promotes one explicit project commitment only when autoPromotion is enabled", async () => {
    const store = new ScalarStore();
    const commit = vi.fn().mockResolvedValue({
      outcome: "created",
      record: { id: "memory-1" },
      relatedIds: [],
      relationDecision: "unrelated",
    });
    const service = new MemoryCandidateService(
      store as unknown as ZvecStore,
      { commit } as unknown as MemoryService,
      { ...policy, autoPromotion: true },
      new TestClock(),
    );
    const result = await service.observe({
      proposal: {
        content: "以后这个项目统一使用 pnpm",
        scopeHint: "repository",
        confidence: 0.95,
        durability: 0.95,
        evidenceIds: ["e"],
        support: support("e"),
      },
      source: "user_commitment",
      scopeContext: scope(),
      evidence: [
        {
          id: "e",
          ref: { kind: "event", id: "e", observedAt: 1 },
          namespace: "tenant:user:pi:agent",
          text: "以后这个项目统一使用 pnpm",
          verified: false,
          sourceKind: "user",
          explicitCommitment: true,
          allowedScopeCeiling: "repository",
        },
      ],
      observationId: "commitment",
    });
    expect(result.outcome).toBe("promoted");
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: "repository", id: "repo" } }),
      expect.anything(),
    );
  });

  it("routes verified semantic consolidation through repository-scoped MemoryService commit", async () => {
    const store = new ScalarStore();
    const commit = vi.fn().mockResolvedValue({
      outcome: "created",
      record: { id: "semantic-memory" },
      relatedIds: [],
      relationDecision: "unrelated",
    });
    const service = new MemoryCandidateService(
      store as unknown as ZvecStore,
      { commit } as unknown as MemoryService,
      { ...policy, autoPromotion: true },
      new TestClock(),
    );
    const result = await service.observe({
      proposal: {
        content: "repository uses pnpm workspaces",
        scopeHint: "user",
        confidence: 0.95,
        durability: 0.9,
        evidenceIds: ["verified"],
        support: support("verified"),
      },
      source: "episode_consolidation",
      scopeContext: scope(),
      evidence: [
        {
          id: "verified",
          ref: { kind: "event", id: "verified", observedAt: 1 },
          namespace: "tenant:user:pi:agent",
          text: "verification passed: repository uses pnpm workspaces",
          verified: true,
          sourceKind: "verification",
          allowedScopeCeiling: "repository",
        },
      ],
      observationId: "semantic-observation",
    });
    expect(result.outcome).toBe("promoted");
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: "repository", id: "repo" } }),
      expect.anything(),
    );
  });

  it("rejects polarity reversal and model-created user preferences", async () => {
    const store = new ScalarStore();
    const service = new MemoryCandidateService(
      store as unknown as ZvecStore,
      { commit: vi.fn() } as unknown as MemoryService,
      policy,
      new TestClock(),
    );
    const polarity = await service.observe({
      proposal: {
        content: "tests pass",
        scopeHint: "repository",
        confidence: 0.95,
        durability: 0.9,
        evidenceIds: ["negative"],
        support: support("negative"),
      },
      source: "user_statement",
      scopeContext: scope(),
      evidence: [
        {
          id: "negative",
          ref: { kind: "event", id: "negative", observedAt: 1 },
          namespace: "tenant:user:pi:agent",
          text: "tests do not pass",
          verified: false,
          polarity: "negative",
          allowedScopeCeiling: "repository",
        },
      ],
      observationId: "negative-observation",
    });
    expect(polarity).toMatchObject({
      outcome: "rejected",
      reason: "candidate_polarity_conflicts_with_evidence",
    });

    const widened = await service.observe({
      proposal: {
        content: "I usually prefer pnpm",
        scopeHint: "user",
        confidence: 0.95,
        durability: 0.9,
        evidenceIds: ["repo"],
        support: support("repo"),
      },
      source: "user_statement",
      scopeContext: scope(),
      evidence: [
        {
          id: "repo",
          ref: { kind: "event", id: "repo", observedAt: 1 },
          namespace: "tenant:user:pi:agent",
          text: "repository uses pnpm",
          verified: false,
          firstPersonPreferenceEvidence: false,
          allowedScopeCeiling: "repository",
        },
      ],
      observationId: "repo-observation",
    });
    expect(widened).toMatchObject({
      outcome: "rejected",
      reason: "preference_not_explicit_in_source_evidence",
    });
  });

  it("does not treat repeated observations in one session as independent", async () => {
    const store = new ScalarStore();
    const service = new MemoryCandidateService(
      store as unknown as ZvecStore,
      { commit: vi.fn() } as unknown as MemoryService,
      policy,
      new TestClock(),
    );
    for (const evidenceId of ["same-session-1", "same-session-2"]) {
      await service.observe({
        proposal: {
          content: "我通常喜欢简洁回答",
          scopeHint: "user",
          confidence: 0.95,
          durability: 0.9,
          evidenceIds: [evidenceId],
          support: support(evidenceId),
        },
        source: "user_statement",
        scopeContext: scope({ sessionId: "same-session" }),
        evidence: [
          {
            id: evidenceId,
            ref: { kind: "event", id: evidenceId, observedAt: 1 },
            namespace: "tenant:user:pi:agent",
            text: "我通常喜欢简洁回答",
            verified: false,
            firstPersonPreferenceEvidence: true,
            allowedScopeCeiling: "user",
          },
        ],
        observationId: evidenceId,
      });
    }
    const candidates = await service.list("tenant:user:pi:agent");
    expect(candidates[0]?.observations).toHaveLength(2);
    expect(candidates[0]?.state).toBe("reinforced");
  });

  it("preserves concurrent candidate reinforcements through CAS retries", async () => {
    const store = new ScalarStore();
    const service = new MemoryCandidateService(
      store as unknown as ZvecStore,
      { commit: vi.fn() } as unknown as MemoryService,
      policy,
      new TestClock(),
    );
    const observe = (id: string) =>
      service.observe({
        proposal: {
          content: "我通常喜欢简洁回答",
          scopeHint: "user",
          confidence: 0.95,
          durability: 0.9,
          evidenceIds: [id],
          support: support(id),
        },
        source: "user_statement",
        scopeContext: scope({ sessionId: `session-${id}` }),
        evidence: [
          {
            id,
            ref: { kind: "event", id, observedAt: 1 },
            namespace: "tenant:user:pi:agent",
            text: "我通常喜欢简洁回答",
            verified: false,
            firstPersonPreferenceEvidence: true,
            allowedScopeCeiling: "user",
          },
        ],
        observationId: id,
      });
    await Promise.all([observe("concurrent-1"), observe("concurrent-2")]);
    const candidates = await service.list("tenant:user:pi:agent");
    expect(candidates[0]?.observations.map((entry) => entry.id).sort()).toEqual([
      "concurrent-1",
      "concurrent-2",
    ]);
  });
});

describe("TaskEpisode consolidation and Experience v2", () => {
  it("aggregates by task and branch, preserves artifact references, and bounds the digest", async () => {
    const store = new ScalarStore();
    const service = new TaskEpisodeService(store as unknown as ZvecStore, new TestClock());
    const events = [
      event(
        "call",
        "tool_call",
        1,
        { toolName: "bash", input: { command: "pnpm test" } },
        { toolCallId: "t" },
      ),
      event(
        "result",
        "tool_result",
        2,
        { result: { status: "completed" } },
        {
          toolCallId: "t",
          artifactRef: { kind: "artifact", id: "artifact-large", observedAt: 2 },
        },
      ),
      event("verify", "verification", 3, { command: "pnpm test", status: "passed" }),
    ];
    const success: OutcomeStatus = {
      executionStatus: "success",
      verificationStatus: "passed",
      taskStatus: "completed",
    };
    await service.append({
      taskId: "task",
      scopeContext: scope(),
      episode: episode("e1", "fix tests"),
      events,
      outcome: success,
    });
    const task = await service.append({
      taskId: "task",
      scopeContext: scope(),
      episode: episode("e2", "fix tests again"),
      events: events.map((item) => ({ ...item, id: `${item.id}-2` })),
      outcome: success,
    });
    expect(task.episodeIds).toHaveLength(2);
    const otherTask = await service.append({
      taskId: "other-task",
      scopeContext: scope({ taskId: "other-task" }),
      episode: episode("e-other", "different task", { taskId: "other-task" }),
      events,
      outcome: success,
    });
    expect(otherTask.id).not.toBe(task.id);
    const otherBranch = await service.append({
      taskId: "task",
      scopeContext: scope({ branchId: "child" }),
      episode: episode("e3", "fix tests", { branchId: "child" }),
      events,
      outcome: success,
    });
    expect(otherBranch.id).not.toBe(task.id);
    const digest = createTaskEpisodeDigest(task, 512);
    expect(digest.artifactIds).toContain("artifact-large");
    expect(digest.serialized).not.toContain("raw tool output");
    expect(digest.estimatedTokens).toBeLessThanOrEqual(512);
    expect(validateConsolidationEvidence(digest, ["verify"], true)).toBe(true);
    expect(validateConsolidationEvidence(digest, ["missing"], true)).toBe(false);
  });

  it("excludes pre-steering actions from the generalized successful path", async () => {
    const store = new ScalarStore();
    const service = new TaskEpisodeService(store as unknown as ZvecStore, new TestClock());
    const events = [
      event(
        "old-call",
        "tool_call",
        1,
        { toolName: "bash", input: { command: "dangerous-old-plan" } },
        { toolCallId: "old" },
      ),
      event(
        "old-result",
        "tool_result",
        2,
        { result: { status: "completed" } },
        { toolCallId: "old" },
      ),
      event("steer", "steering", 3, { updatedGoal: "use safe repair" }),
      event(
        "new-call",
        "tool_call",
        4,
        { toolName: "bash", input: { command: "safe-new-plan" } },
        { toolCallId: "new" },
      ),
      event(
        "new-result",
        "tool_result",
        5,
        { result: { status: "completed" } },
        { toolCallId: "new" },
      ),
      event("verify", "verification", 6, { command: "pnpm test", status: "passed" }),
    ];
    const task = await service.append({
      taskId: "task",
      scopeContext: scope(),
      episode: episode("steered", "repair safely"),
      events,
      outcome: {
        executionStatus: "success",
        verificationStatus: "passed",
        taskStatus: "completed",
      },
    });
    const digest = createTaskEpisodeDigest(task, 1_600);
    expect(digest.successfulActions.join(" ")).toContain("safe-new-plan");
    expect(digest.serialized).not.toContain("dangerous-old-plan");
  });

  it("invalidates earlier TaskEpisode turns when a later turn steers the task", async () => {
    const store = new ScalarStore();
    const service = new TaskEpisodeService(store as unknown as ZvecStore, new TestClock());
    await service.append({
      taskId: "task",
      scopeContext: scope(),
      episode: episode("old-turn", "use old plan"),
      events: [
        event(
          "old-call",
          "tool_call",
          1,
          { toolName: "bash", input: { command: "dangerous-old-plan" } },
          { toolCallId: "old" },
        ),
        event(
          "old-result",
          "tool_result",
          2,
          { result: { status: "completed" } },
          { toolCallId: "old" },
        ),
      ],
      outcome: partial,
    });
    const task = await service.append({
      taskId: "task",
      scopeContext: scope(),
      episode: episode("new-turn", "use safe plan"),
      events: [
        event("later-steer", "steering", 1, { updatedGoal: "use safe plan" }),
        event(
          "new-call",
          "tool_call",
          2,
          { toolName: "bash", input: { command: "safe-new-plan" } },
          { toolCallId: "new" },
        ),
        event(
          "new-result",
          "tool_result",
          3,
          { result: { status: "completed" } },
          { toolCallId: "new" },
        ),
      ],
      outcome: partial,
    });
    const digest = createTaskEpisodeDigest(task, 1_600);
    expect(digest.serialized).toContain("safe-new-plan");
    expect(digest.serialized).not.toContain("dangerous-old-plan");
    expect(task.episodeIds).toEqual(["new-turn"]);
  });

  it("strictly rejects semantic assertions without evidence", () => {
    expect(() =>
      parseEpisodeConsolidationProposal(
        {
          assertions: [
            {
              content: "repository uses pnpm",
              scopeHint: "repository",
              confidence: 0.9,
              durability: 0.9,
              evidenceIds: [],
            },
          ],
        },
        { maxAssertions: 5, candidateMaxCharacters: 500 },
      ),
    ).toThrow(/invalid/u);
    expect(
      parseEpisodeConsolidationProposal(
        {
          assertions: [
            {
              content: "API key is sk-abcdefghijklmnopqrstuvwxyz1234567890",
              scopeHint: "repository",
              confidence: 0.99,
              durability: 0.99,
              evidenceIds: ["event"],
              support: [{ evidenceId: "event", relation: "entailed" }],
            },
          ],
        },
        { maxAssertions: 5, candidateMaxCharacters: 500 },
      ).assertions,
    ).toHaveLength(0);
  });

  it("records failed verified procedures as negative outcomes instead of success evidence", async () => {
    const store = new ScalarStore();
    const tasks = new TaskEpisodeService(store as unknown as ZvecStore, new TestClock());
    const verification = event("verify-failed", "verification", 2, {
      command: "pnpm test",
      status: "failed",
    });
    const task = await tasks.append({
      taskId: "task",
      scopeContext: scope(),
      episode: episode("failed-episode", "repair tests"),
      events: [verification],
      outcome: {
        executionStatus: "failed",
        verificationStatus: "failed",
        taskStatus: "failed",
      },
    });
    const digest = createTaskEpisodeDigest(task, 512);
    expect(validateConsolidationEvidence(digest, [verification.id], false)).toBe(true);
    expect(validateConsolidationEvidence(digest, [verification.id], true)).toBe(false);
    const observation = deriveTaskEpisodeExperienceObservation(
      task,
      digest,
      {
        problemCues: ["test repair failed"],
        generalizedSteps: ["inspect failure", "apply repair", "run focused tests"],
        prerequisites: [],
        successCriteria: ["focused tests pass"],
        appliesWhen: ["repository tests fail"],
        excludesWhen: [],
        evidenceIds: [verification.id],
        confidence: 0.9,
      },
      { os: "darwin", runtime: "node" },
      scope(),
    );
    expect(observation?.outcome.succeeded).toBe(false);
    expect(observation?.outcome.evidence.id).toBe(verification.id);
  });

  it("derives positive procedure evidence only from a passed TaskEpisode and skips aborted work", async () => {
    const store = new ScalarStore();
    const tasks = new TaskEpisodeService(store as unknown as ZvecStore, new TestClock());
    const repairEvents = [
      event(
        "failed-tool",
        "tool_result",
        1,
        { result: { status: "failed" } },
        { toolCallId: "failed" },
      ),
      event(
        "repaired-tool",
        "tool_result",
        2,
        { result: { status: "completed" } },
        { toolCallId: "repair" },
      ),
      event("verify-passed", "verification", 3, { command: "pnpm test", status: "passed" }),
    ];
    const task = await tasks.append({
      taskId: "task",
      scopeContext: scope(),
      episode: episode("successful-repair", "repair tests"),
      events: repairEvents,
      outcome: {
        executionStatus: "success",
        verificationStatus: "passed",
        taskStatus: "completed",
      },
    });
    const digest = createTaskEpisodeDigest(task, 512);
    const procedure = {
      problemCues: ["tests fail"],
      generalizedSteps: ["inspect failure", "repair", "verify"],
      prerequisites: [],
      successCriteria: ["tests pass"],
      appliesWhen: ["repository tests fail"],
      excludesWhen: [],
      evidenceIds: ["verify-passed"],
      confidence: 0.9,
    };
    expect(
      deriveTaskEpisodeExperienceObservation(
        task,
        digest,
        procedure,
        { os: "darwin", runtime: "node" },
        scope(),
      )?.outcome.succeeded,
    ).toBe(true);

    const aborted = await tasks.append({
      taskId: "aborted-task",
      scopeContext: scope({ taskId: "aborted-task" }),
      episode: episode("aborted", "aborted repair", { taskId: "aborted-task" }),
      events: repairEvents,
      outcome: {
        executionStatus: "partial",
        verificationStatus: "not_run",
        taskStatus: "aborted",
      },
    });
    expect(
      deriveTaskEpisodeExperienceObservation(
        aborted,
        createTaskEpisodeDigest(aborted, 512),
        procedure,
        { os: "darwin", runtime: "node" },
        scope({ taskId: "aborted-task" }),
      ),
    ).toBeUndefined();
  });

  it("merges equivalent procedure wording, counts unique outcomes, and qualifies three successes", async () => {
    const store = new ScalarStore();
    const memory = {
      commit: vi
        .fn()
        .mockResolvedValue({ outcome: "created", relatedIds: [], relationDecision: "unrelated" }),
    } as unknown as MemoryService;
    const service = createExperienceLearningService({
      store: store as unknown as ZvecStore,
      memory,
      minimumOutcomes: 3,
      minimumSuccessEstimate: 0.7,
      clock: new TestClock(),
    });
    const base = {
      version: 2 as const,
      goal: "failing shared writer test",
      scopeContext: scope(),
      environment: { os: "darwin", runtime: "node" },
      prerequisites: ["shared writer"],
      steps: ["inspect writer lifecycle", "run focused tests"],
      generalizedSteps: ["inspect writer lifecycle", "run focused tests"],
      normalizedProblemCues: ["shared writer failure"],
      rawEpisodeIds: ["e1"],
      successCriteria: ["focused tests pass"],
      applicabilityContext: { os: "darwin", runtime: "node" },
      cost: 0,
      durationMs: 1,
      appliesWhen: ["shared writer"],
      excludesWhen: [],
      capabilityGaps: [],
      generationContext: ["model-a"],
      validationPlan: ["focused tests pass"],
    };
    const first = await service.observe(base);
    const differentlyWorded = await service.observe({
      ...base,
      goal: "the same writer test failed again",
      generationContext: ["model-b"],
    });
    expect(differentlyWorded.id).toBe(first.id);
    for (let index = 1; index <= 3; index++) {
      const evidence: EvidenceRef = { kind: "event", id: `verify-${index}`, observedAt: index };
      await service.recordOutcome(first.id, {
        outcomeId: `outcome-${index}`,
        taskEpisodeId: `task-episode-${index}`,
        episodeIds: [`episode-${index}`],
        sessionId: `session-${index}`,
        branchId: "root",
        succeeded: true,
        evidence,
        verificationEvidenceIds: [evidence.id],
        cost: 0,
        durationMs: 1,
        environment: base.environment,
      });
    }
    await service.recordOutcome(first.id, {
      outcomeId: "outcome-3",
      taskEpisodeId: "task-episode-3",
      episodeIds: ["episode-3"],
      sessionId: "session-3",
      branchId: "root",
      succeeded: true,
      evidence: { kind: "event", id: "verify-3", observedAt: 3 },
      verificationEvidenceIds: ["verify-3"],
      cost: 0,
      durationMs: 1,
      environment: base.environment,
    });
    const qualified = await service.qualify(first.id);
    expect(qualified.state).toBe("qualified");
    expect(qualified.successes).toBe(3);

    const unreliable = await service.observe({
      ...base,
      goal: "unstable repair procedure",
      normalizedProblemCues: ["unstable repair"],
      generalizedSteps: ["try unstable repair"],
      steps: ["try unstable repair"],
      successCriteria: ["repair remains stable"],
    });
    for (const [index, succeeded] of [true, false, false].entries()) {
      await service.recordOutcome(unreliable.id, {
        outcomeId: `unstable-outcome-${index}`,
        taskEpisodeId: `unstable-task-${index}`,
        episodeIds: [`unstable-episode-${index}`],
        sessionId: `unstable-session-${index}`,
        branchId: "root",
        succeeded,
        evidence: { kind: "event", id: `unstable-${index}`, observedAt: index },
        verificationEvidenceIds: [`unstable-${index}`],
        cost: 0,
        durationMs: 1,
        environment: base.environment,
      });
    }
    await expect(service.qualify(unreliable.id)).rejects.toThrow(/Beta estimate/u);
  });

  it("counts at most one outcome per TaskEpisode", async () => {
    const store = new ScalarStore();
    const service = createExperienceLearningService({
      store: store as unknown as ZvecStore,
      memory: { commit: vi.fn(), tombstone: vi.fn() } as unknown as MemoryService,
      minimumOutcomes: 2,
      minimumSuccessEstimate: 0.5,
      clock: new TestClock(),
    });
    const candidate = await service.observe({
      version: 2,
      goal: "repair writer",
      scopeContext: scope(),
      environment: { os: "darwin", runtime: "node" },
      prerequisites: [],
      steps: ["inspect writer", "verify repair"],
      generalizedSteps: ["inspect writer", "verify repair"],
      normalizedProblemCues: ["writer failure"],
      rawEpisodeIds: ["episode"],
      successCriteria: ["tests pass"],
      applicabilityContext: { os: "darwin", runtime: "node" },
      cost: 0,
      durationMs: 1,
      appliesWhen: ["writer fails"],
      excludesWhen: [],
      capabilityGaps: [],
      generationContext: ["test"],
      validationPlan: ["tests pass"],
    });
    for (const id of ["unit", "typecheck", "build"]) {
      await service.recordOutcome(candidate.id, {
        outcomeId: `outcome-${id}`,
        taskEpisodeId: "same-task-episode",
        episodeIds: ["same-episode"],
        sessionId: "session",
        branchId: "root",
        succeeded: true,
        evidence: { kind: "event", id, observedAt: 1 },
        verificationEvidenceIds: [id],
        cost: 0,
        durationMs: 1,
        environment: { os: "darwin", runtime: "node" },
      });
    }
    const current = await service.get(candidate.id);
    expect(current?.successes).toBe(1);
    await expect(service.qualify(candidate.id)).rejects.toThrow(/1 independent outcomes/u);
  });

  it("degrades and retires promoted procedures after independent failures", async () => {
    const store = new ScalarStore();
    const commit = vi.fn().mockResolvedValue({
      outcome: "created",
      record: { id: "procedure-memory" },
      relatedIds: [],
      relationDecision: "unrelated",
    });
    const tombstone = vi.fn().mockResolvedValue(true);
    const service = createExperienceLearningService({
      store: store as unknown as ZvecStore,
      memory: { commit, tombstone } as unknown as MemoryService,
      minimumOutcomes: 1,
      minimumSuccessEstimate: 0.6,
      clock: new TestClock(),
    });
    const candidate = await service.observe({
      version: 2,
      goal: "repair writer",
      scopeContext: scope(),
      environment: { os: "darwin", runtime: "node" },
      prerequisites: [],
      steps: ["inspect writer", "verify repair"],
      generalizedSteps: ["inspect writer", "verify repair"],
      normalizedProblemCues: ["writer failure"],
      rawEpisodeIds: ["success-episode"],
      successCriteria: ["tests pass"],
      applicabilityContext: { os: "darwin", runtime: "node" },
      cost: 0,
      durationMs: 1,
      appliesWhen: ["writer fails"],
      excludesWhen: [],
      capabilityGaps: [],
      generationContext: ["test"],
      validationPlan: ["tests pass"],
    });
    await service.recordOutcome(candidate.id, {
      outcomeId: "success",
      taskEpisodeId: "success-task",
      episodeIds: ["success-episode"],
      sessionId: "success-session",
      branchId: "root",
      succeeded: true,
      evidence: { kind: "event", id: "success", observedAt: 1 },
      verificationEvidenceIds: ["success"],
      cost: 0,
      durationMs: 1,
      environment: { os: "darwin", runtime: "node" },
    });
    await service.qualify(candidate.id);
    await service.promote(candidate.id);
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^experience-promotion:/u) }),
      expect.anything(),
    );
    let current = await service.get(candidate.id);
    expect(current?.state).toBe("promoted");
    for (let index = 1; index <= 4; index++) {
      current = await service.recordOutcome(candidate.id, {
        outcomeId: `failure-${index}`,
        taskEpisodeId: `failure-task-${index}`,
        episodeIds: [`failure-episode-${index}`],
        sessionId: `failure-session-${index}`,
        branchId: "root",
        succeeded: false,
        evidence: { kind: "event", id: `failure-${index}`, observedAt: index + 1 },
        verificationEvidenceIds: [`failure-${index}`],
        cost: 0,
        durationMs: 1,
        environment: { os: "darwin", runtime: "node" },
      });
    }
    expect(current?.state).toBe("retired");
    expect(tombstone).toHaveBeenCalledWith(
      "procedure-memory",
      expect.objectContaining({ scopeContext: expect.objectContaining({ userId: "user" }) }),
    );
  });
});
