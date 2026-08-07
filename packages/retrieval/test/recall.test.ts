import { describe, it, expect } from "vitest";

import {
  decideRecall,
  classifyIntentScores,
  buildRecallQuery,
  computeCandidateScore,
  evaluateRecallDecision,
  scopeAffinityScore,
  taskContinuityScore,
  temporalRelevanceScore,
  type RecallSignals,
  type RecallQueryContext,
  type FastRecallCandidate,
} from "../src/recall.js";

function signals(overrides: Partial<RecallSignals> = {}): RecallSignals {
  return {
    prompt: "test prompt",
    queryCacheHit: false,
    embeddingCacheHit: false,
    remainingContextTokens: 10_000,
    isCommand: false,
    ...overrides,
  };
}

describe("decideRecall — always-on fast recall", () => {
  it("skips recall for commands", () => {
    const result = decideRecall(signals({ isCommand: true, prompt: "/help" }));
    expect(result.shouldRecall).toBe(false);
    expect(result.reason).toBe("command-input");
  });

  it("skips recall for very short empty input", () => {
    const result = decideRecall(signals({ prompt: "" }));
    expect(result.shouldRecall).toBe(false);
  });

  it("defers greeting memory need to the semantic planner", () => {
    const result = decideRecall(signals({ prompt: "你好" }));
    expect(result.shouldRecall).toBe(true);
  });

  it("defers short natural-language memory need to the semantic planner", () => {
    const result = decideRecall(signals({ prompt: "hi" }));
    expect(result.shouldRecall).toBe(true);
  });

  it("triggers recall for any non-trivial input — no keyword gate", () => {
    // "那台低功耗机器准备花多少钱？" — no explicit "remember" or "之前"
    const result = decideRecall(signals({ prompt: "那台低功耗机器准备花多少钱？" }));
    expect(result.shouldRecall).toBe(true);
    expect(result.reason).toBe("always-on-fast-recall");
  });

  it("triggers recall for pronouns and implicit references", () => {
    // "那这个呢？" — pure pronoun, no keywords
    const result = decideRecall(signals({ prompt: "那这个呢？" }));
    expect(result.shouldRecall).toBe(true);
    expect(result.reason).toBe("always-on-fast-recall");
  });

  it("triggers recall for natural NAS question without memory keywords", () => {
    // "存储服务器最后定的预算是多少？" — no 记得/之前/偏好
    const result = decideRecall(signals({ prompt: "存储服务器最后定的预算是多少？" }));
    expect(result.shouldRecall).toBe(true);
  });

  it("triggers recall for ECC question", () => {
    // "ECC 那套方案准备投入多少？" — natural, no recall keywords
    const result = decideRecall(signals({ prompt: "ECC 那套方案准备投入多少？" }));
    expect(result.shouldRecall).toBe(true);
  });

  it("always uses fast lane (no rerank)", () => {
    const result = decideRecall(signals({ prompt: "这个项目的构建命令是什么？" }));
    expect(result.shouldRecall).toBe(true);
    expect(result.allowRerank).toBe(false);
  });

  it("recall is on for user preference questions", () => {
    const result = decideRecall(signals({ prompt: "我平时喜欢用什么包管理器？" }));
    expect(result.shouldRecall).toBe(true);
  });
});

describe("classifyIntentScores — structural compatibility surface", () => {
  it("returns all-zero for empty input", () => {
    const scores = classifyIntentScores("");
    expect(scores["no_recall"]).toBe(1);
    expect(scores["current_input_only"]).toBe(1);
  });

  it("does not classify greeting semantics with language rules", () => {
    const scores = classifyIntentScores("你好");
    expect(Object.values(scores).every((score) => score === 0)).toBe(true);
  });

  it("does not classify preference, task, or topic domains", () => {
    const scores = classifyIntentScores("我平时习惯用 pnpm，项目构建是 turbo build");
    expect(Object.values(scores).every((score) => score === 0)).toBe(true);
  });

  it("keyword-free natural question has mostly zero scores", () => {
    const scores = classifyIntentScores("那这个呢？");
    const totalSignal = Object.values(scores).reduce((sum: number, v: number) => sum + v, 0);
    expect(totalSignal).toBe(0);
  });
});

describe("buildRecallQuery", () => {
  it("includes current message", () => {
    const query = buildRecallQuery({
      currentMessage: "为什么当时换掉了？",
      recentUserMessages: [],
    });
    expect(query).toContain("为什么当时换掉了？");
  });

  it("includes active goal", () => {
    const query = buildRecallQuery({
      currentMessage: "继续",
      recentUserMessages: [],
      activeGoal: "比较 SQLite 与 Zvec 的性能",
    });
    expect(query).toContain("SQLite");
  });

  it("includes repo context", () => {
    const query = buildRecallQuery({
      currentMessage: "test",
      recentUserMessages: [],
      repositoryId: "my-repo",
    });
    expect(query).toContain("repo:my-repo");
  });

  it("includes recent tool errors", () => {
    const query = buildRecallQuery({
      currentMessage: "fix it",
      recentUserMessages: [],
      recentToolErrors: ["TypeError: foo is not a function", "Build failed"],
    });
    expect(query).toContain("TypeError");
    expect(query).toContain("Build failed");
  });
});

describe("candidate scoring", () => {
  const now = Date.now();
  const baseContext: RecallQueryContext = {
    currentMessage: "test",
    recentUserMessages: [],
    taskId: "task-1",
    repositoryId: "repo-1",
    branchId: "main",
  };

  it("scopeAffinity: exact repo match → high score", () => {
    const score = scopeAffinityScore(
      {
        id: "m1",
        text: "test",
        kind: "memory",
        scope: { kind: "repository", id: "repo-1" },
        authority: 50,
        observedAt: now,
        updatedAt: now,
      },
      baseContext,
    );
    expect(score).toBe(1.0);
  });

  it("scopeAffinity: user scope → moderate score", () => {
    const score = scopeAffinityScore(
      {
        id: "m1",
        text: "test",
        kind: "memory",
        scope: { kind: "user", id: "user-1" },
        authority: 50,
        observedAt: now,
        updatedAt: now,
      },
      baseContext,
    );
    expect(score).toBe(0.6);
  });

  it("taskContinuity: same task → high score", () => {
    const score = taskContinuityScore(
      {
        id: "m1",
        text: "test",
        kind: "memory",
        scope: { kind: "repository", id: "repo-1" },
        taskId: "task-1",
        authority: 50,
        observedAt: now,
        updatedAt: now,
      },
      baseContext,
    );
    // Same task (0.35) + same repo (0.25) = 0.60 (no branch set on candidate)
    expect(score).toBeCloseTo(0.6);
  });

  it("temporalRelevance: fresh → high score", () => {
    const score = temporalRelevanceScore(
      {
        id: "m1",
        text: "test",
        kind: "memory",
        authority: 50,
        observedAt: now,
        updatedAt: now,
      },
      now,
    );
    expect(score).toBe(1.0);
  });

  it("computeCandidateScore produces a score between 0 and 1", () => {
    const result = computeCandidateScore({
      candidate: {
        id: "m1",
        text: "test",
        kind: "memory",
        scope: { kind: "repository", id: "repo-1" },
        taskId: "task-1",
        branchId: "main",
        authority: 80,
        observedAt: now - 60000, // 1 minute ago
        updatedAt: now - 60000,
        confidence: 0.9,
        semanticSimilarity: 0.75,
        lexicalMatchCount: 3,
      },
      context: baseContext,
      now,
    });
    expect(result.finalScore).toBeGreaterThan(0);
    expect(result.finalScore).toBeLessThanOrEqual(1);
  });
});

describe("evaluateRecallDecision", () => {
  function candidate(
    finalScore: number,
    overrides: Partial<FastRecallCandidate> = {},
  ): FastRecallCandidate {
    return {
      id: `m-${finalScore}`,
      text: "test",
      kind: "memory",
      source: "cache",
      semanticScore: finalScore,
      lexicalScore: 0,
      scopeAffinity: 0,
      taskContinuity: 0,
      temporalRelevance: 0,
      trustScore: 0,
      applicabilityScore: 0,
      finalScore,
      ...overrides,
    };
  }

  it("injects when top1 ≥ 0.78 with margin ≥ 0.08", () => {
    const result = evaluateRecallDecision(
      [candidate(0.82), candidate(0.7)],
      classifyIntentScores("test"),
    );
    expect(result.kind).toBe("inject_fast");
  });

  it("quality search when top1 between 0.55 and 0.78", () => {
    const result = evaluateRecallDecision(
      [candidate(0.65), candidate(0.6)],
      classifyIntentScores("test"),
    );
    expect(result.kind).toBe("quality_search");
  });

  it("skips when top1 < 0.55", () => {
    const result = evaluateRecallDecision([candidate(0.4)], classifyIntentScores("test"));
    expect(result.kind).toBe("skip");
  });

  it("skips when no candidates", () => {
    const result = evaluateRecallDecision([], classifyIntentScores("test"));
    expect(result.kind).toBe("skip");
  });

  it("does NOT inject when top1 high but margin low", () => {
    // Top1 high but very close to Top2 → shouldn't inject
    const result = evaluateRecallDecision(
      [candidate(0.82), candidate(0.8)],
      classifyIntentScores("test"),
    );
    // With margin < 0.08, it should go to quality_search, not inject_fast
    expect(result.kind).not.toBe("inject_fast");
  });
});
