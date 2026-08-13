import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  createPiPairwiseRelationshipReasoner,
  createMentisMemorySystemPrompt,
  CurrentTurnRecallGuard,
  formatPiToolJson,
  formatMentisHelp,
  isValidPublicMemoryId,
  MENTIS_MEMORY_SYSTEM_PROMPT,
  normalizePiPathArgument,
  notifyWhenUiAvailable,
  projectDurablePendingAssertions,
  projectDurablePendingAutomaticRecall,
  RecentAssertionOverlay,
  registerMemoryToolPair,
} from "../src/index.js";

describe("Pi extension support", () => {
  it("keeps the conditional memory tool instruction compact", () => {
    expect(MENTIS_MEMORY_SYSTEM_PROMPT).toContain("search_memory");
    expect(MENTIS_MEMORY_SYSTEM_PROMPT).toContain("commit_memory");
    expect(MENTIS_MEMORY_SYSTEM_PROMPT).toContain("only when the user explicitly asks");
    expect(MENTIS_MEMORY_SYSTEM_PROMPT).toContain("provided by the @galvinsan/pi-mentis extension");
    expect(MENTIS_MEMORY_SYSTEM_PROMPT).not.toContain("durable verified facts");
    expect(MENTIS_MEMORY_SYSTEM_PROMPT).toContain("~/.pi/.pi-mentis/config.json");
    expect(MENTIS_MEMORY_SYSTEM_PROMPT).toContain("/mentis help");
    expect(MENTIS_MEMORY_SYSTEM_PROMPT.length).toBeLessThan(400);
  });

  it("attributes the prompt to the package that provides the tools", () => {
    expect(createMentisMemorySystemPrompt("@galvinsan/pi-mentis-memory")).toContain(
      "provided by the @galvinsan/pi-mentis-memory extension",
    );
  });

  it("keeps machine-local paths out of the prompt and shows them only in help", () => {
    const configPath = "/tmp/pi-profile/.pi-mentis/config.json";
    const prompt = createMentisMemorySystemPrompt();
    const help = formatMentisHelp({ configPath, memory: true, knowledge: true });

    expect(prompt).toContain("~/.pi/.pi-mentis/config.json");
    expect(prompt).toContain("PI_MENTIS_HOME");
    expect(prompt).not.toContain(configPath);
    expect(prompt).not.toContain("/Users/");
    expect(prompt).toContain("/mentis help");
    expect(help).toContain(`配置文件：${configPath}`);
    expect(help).toContain("retrieval.automaticRecall=true");
    expect(help).toContain("TUI 可能出现可感知延迟");
    expect(help).toContain("/kb add <路径或网址>");
    expect(help).toContain("/mentis status");
  });

  it("allows independent memory tool calls to execute in parallel", () => {
    const tools: Array<{ readonly name: string; readonly executionMode?: string }> = [];
    registerMemoryToolPair(
      {
        registerTool: (tool: { readonly name: string; readonly executionMode?: string }) =>
          tools.push(tool),
      } as never,
      {
        remember: async () => ({
          outcome: "remembered",
          summary: "saved",
          readable: true,
          recallable: true,
        }),
        recall: async () => ({
          found: false,
          resourceType: "unknown",
          anchored: false,
          summary: "none",
          hits: [],
          supportLevel: "none",
          noDirectSupport: true,
        }),
      },
    );

    expect(tools).toMatchObject([
      { name: "commit_memory", executionMode: "parallel" },
      { name: "search_memory", executionMode: "parallel" },
    ]);
  });

  it("formats small tool results without a truncation notice", () => {
    expect(formatPiToolJson({ ok: true })).toBe('{\n  "ok": true\n}');
  });

  it("keeps large tool results inside Pi's output limits", () => {
    const output = formatPiToolJson({
      rows: Array.from({ length: 4_000 }, (_, index) => ({ index })),
    });

    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(output.split("\n")).toHaveLength(DEFAULT_MAX_LINES);
    expect(output).toContain("[Output truncated:");
    expect(output).toContain("Full data remains in Pi Mentis");
  });

  it("normalizes only the leading path marker", () => {
    expect(normalizePiPathArgument("@/tmp/book.md")).toBe("/tmp/book.md");
    expect(normalizePiPathArgument("@@scope/file.md")).toBe("@scope/file.md");
    expect(normalizePiPathArgument("/tmp/@book.md")).toBe("/tmp/@book.md");
  });

  it("does not call UI notifications in headless modes", () => {
    const notify = vi.fn();

    expect(notifyWhenUiAvailable({ hasUI: false, ui: { notify } }, "hidden", "info")).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    expect(notifyWhenUiAvailable({ hasUI: true, ui: { notify } }, "visible", "info")).toBe(true);
    expect(notify).toHaveBeenCalledWith("visible", "info");
  });

  it("projects a pending user assertion without changing persistent status", () => {
    let now = 1_000;
    const overlay = new RecentAssertionOverlay({ clock: () => now });
    overlay.record({
      memoryId: "new",
      content: "默认端口改为 51842。",
      observedAt: now,
      authority: "explicit_user",
      candidateIds: ["old"],
    });
    const persistent = {
      found: true,
      resourceType: "memory" as const,
      anchored: true,
      hits: [
        {
          id: "new",
          content: "默认端口改为 51842。",
          kind: "user" as const,
          status: "current" as const,
          match: "semantic" as const,
          resourceType: "memory" as const,
          sanitized: false,
        },
        {
          id: "old",
          content: "默认端口是 46321。",
          kind: "user" as const,
          status: "current" as const,
          match: "exact" as const,
          resourceType: "memory" as const,
          sanitized: false,
        },
      ],
    };

    const projected = overlay.project({ query: "默认端口" }, persistent);
    expect(projected).toMatchObject({
      consistency: "pending_relationship",
      provisionalLatestId: "new",
      pendingRelationshipIds: ["new"],
    });
    expect(projected.hits).toMatchObject([
      {
        id: "new",
        status: "current",
        match: "semantic",
        provisional: true,
        projection: "provisional_latest",
      },
      {
        id: "old",
        status: "current",
      },
    ]);
    expect(persistent.hits[0]).not.toHaveProperty("projection");

    overlay.resolve("new");
    expect(overlay.project({ query: "默认端口" }, persistent)).toBe(persistent);
    now += 1;
  });

  it("does not project a pending assertion onto an unrelated recall", () => {
    const overlay = new RecentAssertionOverlay({ clock: () => 2_000 });
    overlay.record({
      memoryId: "new",
      content: "默认端口改为 51842。",
      observedAt: 2_000,
      authority: "explicit_user",
      candidateIds: ["old"],
    });
    const unrelated = {
      found: true,
      resourceType: "memory" as const,
      anchored: false,
      hits: [
        {
          id: "other",
          content: "默认 shell 是 zsh。",
          kind: "user" as const,
          status: "current" as const,
          match: "semantic" as const,
          resourceType: "memory" as const,
          sanitized: false,
        },
      ],
    };
    expect(overlay.project({ query: "shell" }, unrelated)).toBe(unrelated);
  });

  it("does not treat candidate discovery alone as read-projection evidence", () => {
    const overlay = new RecentAssertionOverlay({ clock: () => 3_000 });
    overlay.record({
      memoryId: "new",
      content: "终端主题是 Nivora。",
      observedAt: 3_000,
      authority: "explicit_user",
      candidateIds: ["old"],
    });
    const exactCandidate = {
      found: true,
      resourceType: "memory" as const,
      anchored: true,
      hits: [
        {
          id: "old",
          content: "编辑器主题是 Nivora。",
          kind: "user" as const,
          status: "current" as const,
          match: "exact" as const,
          resourceType: "memory" as const,
          sanitized: false,
        },
      ],
    };
    expect(overlay.project({ id: "old" }, exactCandidate)).toBe(exactCandidate);
  });

  it("reconstructs pending projection after the session overlay is lost", async () => {
    const projected = await projectDurablePendingAssertions(
      {
        async getRelationshipLearning(id) {
          return id === "new"
            ? {
                incomingId: "new",
                state: "processing",
                candidates: [{ id: "old" }],
              }
            : undefined;
        },
        async listPendingRelationshipLearning() {
          return [{ incomingId: "new", state: "processing", candidates: [{ id: "old" }] }];
        },
        async get(id) {
          return id === "new"
            ? { content: "默认端口改为 51842。", observedAt: 2_000, scope: { kind: "user" } }
            : undefined;
        },
      },
      { query: "默认端口" },
      {
        found: true,
        resourceType: "memory",
        anchored: false,
        hits: [
          {
            id: "old",
            content: "默认端口是 46321。",
            kind: "user",
            status: "current",
            match: "semantic",
            resourceType: "memory",
            sanitized: false,
          },
        ],
      },
    );
    expect(projected).toMatchObject({
      consistency: "pending_relationship",
      provisionalLatestId: "new",
      hits: [
        { id: "new", projection: "provisional_latest" },
        { id: "old", status: "current" },
      ],
    });
  });

  it("recalls a relevant durable pending write before semantic retrieval catches up", async () => {
    const reader = {
      async getRelationshipLearning() {
        return undefined;
      },
      async listPendingRelationshipLearning() {
        return [{ incomingId: "new", state: "pending", candidates: [] }];
      },
      async get(id: string) {
        return id === "new"
          ? { content: "这个测试项目的昵称是晴舟。", observedAt: 2_000, scope: { kind: "user" } }
          : undefined;
      },
    };
    const empty = {
      found: false,
      contentFound: false,
      lookupMode: "global_query" as const,
      resourceType: "search" as const,
      anchored: false,
      hits: [],
    };

    await expect(
      projectDurablePendingAssertions(reader, { query: "测试项目叫什么名字" }, empty),
    ).resolves.toMatchObject({
      found: true,
      contentFound: true,
      consistency: "pending_relationship",
      hits: [{ id: "new", projection: "provisional_latest" }],
    });
    await expect(
      projectDurablePendingAssertions(reader, { query: "默认端口是多少" }, empty),
    ).resolves.toMatchObject({ found: false, contentFound: false, hits: [] });
  });

  it("does not turn an exact metadata-only entity lookup into a miss", async () => {
    const id = "8".repeat(64);
    const projected = await projectDurablePendingAssertions(
      {
        async getRelationshipLearning() {
          return undefined;
        },
        async listPendingRelationshipLearning() {
          return [];
        },
        async get() {
          return undefined;
        },
      },
      { id },
      {
        found: true,
        entityFound: true,
        contentFound: false,
        lookupMode: "exact_id",
        artifactId: id,
        resourceType: "artifact",
        anchored: true,
        summary: JSON.stringify({ id, chunkCount: 11 }),
        hits: [],
      },
    );

    expect(projected).toMatchObject({
      found: true,
      entityFound: true,
      contentFound: false,
      lookupMode: "exact_id",
      artifactId: id,
      hits: [],
    });
  });

  it("projects durable pending state into automatic recall after restart", async () => {
    const projected = await projectDurablePendingAutomaticRecall(
      {
        async listPendingRelationshipLearning() {
          return [{ incomingId: "new", state: "processing", candidates: [{ id: "old" }] }];
        },
        async get(id) {
          return id === "new"
            ? { content: "默认端口改为 51842。", observedAt: 2_000, authority: 100 }
            : undefined;
        },
      },
      {
        hits: [
          {
            id: "old",
            kind: "memory" as const,
            text: "默认端口是 46321。",
            score: 0.9,
            tokenCount: 8,
            authority: 100,
            namespace: "user",
            contentHash: "old-hash",
          },
        ],
        diagnostics: { durationMs: 1 },
      },
    );
    expect(projected.hits).toMatchObject([
      {
        id: "new",
        text: "默认端口改为 51842。",
        metadata: { pendingRelationship: true, provisionalLatest: true },
      },
    ]);
    expect(projected.hits.map((hit) => hit.id)).not.toContain("old");
  });

  it("uses the active Pi model for a concrete pair and validates structured evidence", async () => {
    const complete = vi.fn(async () => ({
      stopReason: "stop",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            relation: "supersede",
            confidence: 0.97,
            signals: {
              identityEvidence: {
                referent: "same",
                attribute: "same",
                value: "different",
              },
              explicitNewAssertion: true,
              explicitRetraction: false,
              replacementValuePresent: true,
              compatibleValue: false,
              incompatibleValue: true,
              mutuallyExclusive: false,
            },
            incomingHints: {
              subjectHint: "default port",
              relationHint: "uses",
              valueHint: "51842",
            },
            targetHints: {
              subjectHint: "default port",
              relationHint: "uses",
              valueHint: "46321",
            },
            reasonCodes: ["same_referent_and_attribute"],
          }),
        },
      ],
    }));
    const reasoner = createPiPairwiseRelationshipReasoner({
      model: { provider: "test", id: "test" },
      modelRegistry: { complete },
    } as unknown as Parameters<typeof createPiPairwiseRelationshipReasoner>[0]);
    const result = await reasoner?.judge("default port is now 51842", {
      id: "old",
      content: "default port is 46321",
      status: "current",
      match: "semantic",
    });
    expect(result).toMatchObject({
      relation: "supersede",
      confidence: 0.97,
      signals: {
        identityEvidence: { referent: "same", attribute: "same", value: "different" },
        incompatibleValue: true,
      },
      incomingHints: { valueHint: "51842" },
    });
    expect(complete).toHaveBeenCalledOnce();
  });

  it("aborts pairwise model work when relationship shutdown is requested", async () => {
    let observedSignal: AbortSignal | undefined;
    const complete = vi.fn(
      async (
        _model: unknown,
        _request: unknown,
        options: { readonly signal: AbortSignal },
      ): Promise<never> => {
        observedSignal = options.signal;
        return await new Promise<never>((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("pairwise aborted")), {
            once: true,
          });
        });
      },
    );
    const reasoner = createPiPairwiseRelationshipReasoner({
      model: { provider: "test", id: "test" },
      modelRegistry: { complete },
    } as unknown as Parameters<typeof createPiPairwiseRelationshipReasoner>[0]);
    const controller = new AbortController();
    const judgment = reasoner?.judge(
      "default port is now 51842",
      {
        id: "old",
        content: "default port is 46321",
        status: "current",
        match: "semantic",
      },
      controller.signal,
    );
    controller.abort();

    await expect(judgment).rejects.toThrow("pairwise aborted");
    expect(observedSignal?.aborted).toBe(true);
  });

  it("accepts only exact public memory IDs", () => {
    expect(isValidPublicMemoryId("a".repeat(64))).toBe(true);
    expect(isValidPublicMemoryId("q443020a225")).toBe(false);
    expect(isValidPublicMemoryId("A".repeat(64))).toBe(false);
    expect(isValidPublicMemoryId(`memory:${"a".repeat(64)}`)).toBe(false);
  });

  it("stops semantically duplicate recall queries within one turn", () => {
    const guard = new CurrentTurnRecallGuard();
    guard.beginTurn();
    const first = guard.record(
      { query: "我这次临时实验的内部颜色标记是什么" },
      { found: false, resourceType: "unknown", anchored: false, hits: [] },
    );
    expect(first).toMatchObject({ supportLevel: "none", noDirectSupport: true });
    expect(guard.repeated({ query: "我这次临时实验内部颜色标记是什么？" })).toMatchObject({
      reason: "no_direct_memory_support",
      alreadySearchedThisTurn: true,
    });
    expect(guard.repeated({ query: "那个实验使用的恢复步骤是什么" })).toBeUndefined();
  });

  it("keeps exact entity lookup successful when it returns metadata without content hits", () => {
    const guard = new CurrentTurnRecallGuard();
    const id = "a".repeat(64);
    const result = guard.record(
      { id },
      {
        found: true,
        entityFound: true,
        contentFound: false,
        lookupMode: "exact_id",
        resourceType: "artifact",
        anchored: true,
        summary: JSON.stringify({ id, chunkCount: 11 }),
        hits: [],
      },
    );

    expect(result).toMatchObject({
      found: true,
      entityFound: true,
      contentFound: false,
      lookupMode: "exact_id",
      supportLevel: "direct",
      noDirectSupport: false,
    });
  });

  it("enforces an ID boundary across follow-up recalls in the same user turn", () => {
    const guard = new CurrentTurnRecallGuard();
    const artifactId = "b".repeat(64);
    guard.beginTurn();

    expect(guard.scope({ id: artifactId, query: "尾部标记" })).toEqual({
      id: artifactId,
      query: "尾部标记",
    });
    expect(guard.scope({ query: "换一种说法再找一次" })).toEqual({
      id: artifactId,
      query: "换一种说法再找一次",
    });
    expect(guard.scope({ id: "c".repeat(64), query: "模型尝试切换锚点" })).toEqual({
      id: artifactId,
      query: "模型尝试切换锚点",
    });

    guard.beginTurn();
    expect(guard.scope({ query: "用户在新 turn 明确发起全局检索" })).toEqual({
      query: "用户在新 turn 明确发起全局检索",
    });
  });

  it("does not deduplicate the same query across different anchors", () => {
    const guard = new CurrentTurnRecallGuard();
    const firstId = "c".repeat(64);
    const secondId = "d".repeat(64);
    guard.record(
      { id: firstId, query: "查找尾部标记" },
      {
        found: false,
        entityFound: true,
        contentFound: false,
        lookupMode: "anchored_query",
        resourceType: "artifact",
        anchored: true,
        hits: [],
      },
    );

    expect(guard.repeated({ id: secondId, query: "查找尾部标记" })).toBeUndefined();
  });

  it("bounds model-driven recall loops within one turn", () => {
    const guard = new CurrentTurnRecallGuard();
    for (let index = 0; index < 4; index += 1) {
      guard.record(
        { query: `不同检索 ${index}` },
        { found: false, resourceType: "search", anchored: false, hits: [] },
      );
    }

    expect(guard.repeated({ query: "第五次检索" })).toMatchObject({
      found: false,
      lookupMode: "global_query",
      alreadySearchedThisTurn: true,
      searchLimitReachedThisTurn: true,
      noDirectSupport: true,
    });
  });
});
