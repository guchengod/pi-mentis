import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  BackgroundScheduler,
  CpuWorkerPool,
  MentisContextResolver,
  PriorityHeap,
  ProviderPriority,
  TaskPriority,
  UnsupportedPiVersionError,
  assertPiCompatibility,
  computeToolPlan,
  contextAffinity,
  detectInstalledPackageVersion,
  findInstalledPackageRoot,
  getOrCreateRuntime,
  inferInteractionMode,
  loadConfig,
  resetGlobalRuntime,
  resolveTopicIdentity,
} from "../src/index.js";

const fastContext = {
  runtimeKey: "session-1",
  identity: {
    tenantId: "local",
    userId: "galvin",
    appId: "pi",
    agentId: "pi-mentis",
  },
  conversation: {
    sessionId: "session-1",
    branchId: "entry-2",
    parentBranchId: "entry-1",
    runId: "run-1",
    sessionMode: "persistent" as const,
  },
  situation: {
    topicIds: ["topic:memory"],
    activeGoal: "Design a personal memory system",
    interactionMode: "planning" as const,
    startedAt: 1,
  },
  capability: {
    piVersion: "0.83.0",
    extensionsHash: "extensions",
    skillsHash: "skills",
    mcpHash: "mcp",
    toolsHash: "tools",
    snapshotId: "capabilities-1",
  },
};

describe("faceted context resolution", () => {
  it("reuses unchanged fast context and revises a changed snapshot", () => {
    const resolver = new MentisContextResolver();
    const first = resolver.resolve(fastContext);
    const reused = resolver.resolve(fastContext);
    const changed = resolver.resolve({
      ...fastContext,
      situation: { ...fastContext.situation, interactionMode: "research" },
    });

    expect(first.reused).toBe(false);
    expect(reused).toEqual({ snapshot: first.snapshot, reused: true });
    expect(changed.reused).toBe(false);
    expect(changed.snapshot.revision).toBe(2);
    expect(changed.snapshot.id).not.toBe(first.snapshot.id);
  });

  it("keeps interaction mode useful outside code workspaces", () => {
    expect(inferInteractionMode("研究长期记忆的时间真值模型", false)).toBe("research");
    expect(inferInteractionMode("聊聊我最近的学习计划", false)).toBe("planning");
    expect(inferInteractionMode("Please fix this TypeScript error", true)).toBe("coding");
    expect(inferInteractionMode("How was your day?", false)).toBe("conversation");
  });

  it("requires calibrated topic thresholds and does not create a topic without evidence", () => {
    expect(resolveTopicIdentity({ taskTitle: "NAS setup" })).toEqual({
      decision: "pending",
      label: "NAS setup",
      reason: "insufficient_topic_evidence",
    });
    expect(() =>
      resolveTopicIdentity({
        taskTitle: "NAS setup",
        vectorMatches: [
          {
            topic: { topicId: "topic:nas", label: "NAS", confidence: 0.9 },
            score: 0.76,
          },
        ],
      }),
    ).toThrow("Calibrated topic thresholds");
    expect(
      resolveTopicIdentity({
        taskTitle: "NAS setup",
        vectorMatches: [
          {
            topic: { topicId: "topic:nas", label: "NAS", confidence: 0.9 },
            score: 0.76,
          },
        ],
        thresholds: { calibratedLow: 0.65, calibratedHigh: 0.75 },
      }),
    ).toMatchObject({ decision: "reuse", topic: { topicId: "topic:nas" } });
  });

  it("hard-rejects security and project mismatches without penalizing absent code facets", () => {
    const snapshot = new MentisContextResolver().resolve(fastContext).snapshot;
    expect(
      contextAffinity(
        {
          tenantId: "local",
          userId: "someone-else",
          appId: "pi",
          agentId: "pi-mentis",
        },
        snapshot,
      ),
    ).toMatchObject({ allowed: false, hardReject: true, score: 0 });
    expect(
      contextAffinity(
        {
          tenantId: "local",
          userId: "galvin",
          appId: "pi",
          agentId: "pi-mentis",
          domain: "topic",
        },
        snapshot,
      ),
    ).toMatchObject({ allowed: true, hardReject: false, score: 1, applicableWeight: 0 });
    const projectSnapshot = new MentisContextResolver().resolve({
      ...fastContext,
      workspace: {
        repositoryId: "repo:current",
        projectId: "project:current",
        manifestTypes: ["package.json"],
      },
    }).snapshot;
    expect(
      contextAffinity(
        {
          tenantId: "local",
          userId: "galvin",
          appId: "pi",
          agentId: "pi-mentis",
          domain: "project",
          repositoryId: "repo:other",
        },
        projectSnapshot,
      ),
    ).toMatchObject({ allowed: false, hardReject: true, reasons: ["project_repository_mismatch"] });
  });
});

describe("Pi compatibility and tool surface", () => {
  it("locks Pi exactly to 0.83.0 before initialization", () => {
    expect(() => assertPiCompatibility("0.83.0")).not.toThrow();
    expect(() => assertPiCompatibility("0.82.2")).toThrow(UnsupportedPiVersionError);
    try {
      assertPiCompatibility("0.81.0");
    } catch (error) {
      expect((error as UnsupportedPiVersionError).toJSON()).toMatchObject({
        code: "UNSUPPORTED_PI_VERSION",
        details: {
          currentVersion: "0.81.0",
          supportedVersion: "0.83.0",
          initializationStopped: true,
        },
      });
    }
  });

  it("resolves a globally installed Pi package through the running CLI symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-mentis-compatibility-"));
    try {
      const packageRoot = path.join(
        root,
        "lib",
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
      );
      await mkdir(path.join(packageRoot, "dist"), { recursive: true });
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.83.0" }),
      );
      await writeFile(path.join(packageRoot, "dist", "cli.js"), "export {};\n");
      const binDirectory = path.join(root, "bin");
      await mkdir(binDirectory, { recursive: true });
      const cliLink = path.join(binDirectory, "pi");
      await symlink(path.relative(binDirectory, path.join(packageRoot, "dist", "cli.js")), cliLink);
      const extensionUrl = pathToFileURL(path.join(root, "extension", "dist", "index.js")).href;

      await expect(
        detectInstalledPackageVersion("@earendil-works/pi-coding-agent", extensionUrl, cliLink),
      ).resolves.toBe("0.83.0");
      await expect(
        findInstalledPackageRoot("@earendil-works/pi-coding-agent", extensionUrl, cliLink),
      ).resolves.toBe(await realpath(packageRoot));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads real SiliconFlow model configuration from environment variables", async () => {
    const config = await loadConfig("/nonexistent/pi-mentis-config-test", undefined, {
      SILICONFLOW_BASE_URL: "https://api.siliconflow.cn/v1",
      SILICONFLOW_EMBEDDING_MODEL: "BAAI/bge-m3",
      SILICONFLOW_RERANKER_MODEL: "BAAI/bge-reranker-v2-m3",
    });
    expect(config.inference.siliconflow).toMatchObject({
      baseUrl: "https://api.siliconflow.cn/v1",
      embedding: { model: "BAAI/bge-m3", dimensions: 1_024 },
      rerank: { model: "BAAI/bge-reranker-v2-m3", maxInputTokens: 8_192 },
    });
  });

  it("implements the exact tool truth table", () => {
    expect(computeToolPlan(false, false)).toEqual({ tools: [], knowledgeFirst: false });
    expect(computeToolPlan(true, false).tools).toEqual(["commit_knowledge", "search_knowledge"]);
    expect(computeToolPlan(false, true).tools).toEqual(["commit_memory", "search_memory"]);
    expect(computeToolPlan(true, true)).toEqual({
      tools: ["commit_memory", "search_memory"],
      knowledgeFirst: true,
    });
  });
});

describe("priority scheduling and arbitration", () => {
  it("orders a binary heap by priority and FIFO sequence", () => {
    const heap = new PriorityHeap<number>((left, right) => left - right);
    for (const value of [2, 9, 1, 7, 4]) heap.push(value);
    expect([heap.pop(), heap.pop(), heap.pop(), heap.pop(), heap.pop()]).toEqual([9, 7, 4, 2, 1]);
  });

  it("deduplicates work, applies backpressure, and cancels queued tasks", async () => {
    const scheduler = new BackgroundScheduler({
      maxQueuedTasks: 1,
      maxQueuedBytes: 10,
      maxActiveTasks: 1,
      maxPendingEmbeddingTokens: 10,
      maxPendingRerankTokens: 10,
    });
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(async () => blocker);
    const first = scheduler.schedule({
      id: "one",
      deduplicationKey: "same",
      priority: TaskPriority.BackgroundSync,
      estimatedBytes: 5,
      run,
    });
    const duplicate = scheduler.schedule({
      id: "duplicate",
      deduplicationKey: "same",
      priority: TaskPriority.Interactive,
      estimatedBytes: 5,
      run,
    });
    expect(duplicate.deduplicated).toBe(true);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const queued = scheduler.schedule({
      id: "two",
      priority: TaskPriority.BackgroundSync,
      estimatedBytes: 5,
      run: async () => undefined,
    });
    const rejected = scheduler.schedule({
      id: "three",
      priority: TaskPriority.BackgroundSync,
      estimatedBytes: 5,
      run: async () => undefined,
    });
    await expect(rejected.promise).rejects.toMatchObject({ code: "QUEUE_FULL" });
    expect(scheduler.cancel("two")).toBe(true);
    release();
    await first.promise;
    await expect(queued.promise).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
    expect(run).toHaveBeenCalledTimes(1);
    await scheduler.close();
  });

  it("starts CPU workers lazily and executes predefined CPU operations", async () => {
    const pool = new CpuWorkerPool(1, 4);
    expect(pool.started).toBe(false);
    await expect(pool.run({ operation: "normalize-text", text: " A\r\n  B " })).resolves.toBe(
      "A\n B",
    );
    expect(pool.started).toBe(true);
    await expect(pool.run({ operation: "token-count", text: "你好" })).resolves.toBe(6);
    await pool.close();
  });

  it("initializes only the winning provider and falls back after failure", async () => {
    resetGlobalRuntime();
    const runtime = getOrCreateRuntime();
    const shadowed = vi.fn(async () => "standalone");
    const fallback = vi.fn(async () => "fallback");
    runtime.registerKnowledge({
      id: "integrated",
      version: "1",
      priority: ProviderPriority.integrated,
      initialize: async () => {
        throw new Error("not available");
      },
    });
    runtime.registerKnowledge({
      id: "override",
      version: "1",
      priority: ProviderPriority.explicitOverride,
      initialize: async () => {
        throw new Error("override failed");
      },
    });
    runtime.registerKnowledge({
      id: "standalone",
      version: "1",
      priority: ProviderPriority.standalone,
      initialize: shadowed,
    });
    runtime.registerKnowledge({
      id: "standalone",
      version: "1",
      priority: ProviderPriority.standalone,
      initialize: fallback,
    });
    await runtime.ready();
    expect(runtime.getKnowledge()).toBe("standalone");
    expect(shadowed).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
    expect(runtime.snapshot().providers.map((item) => item.state)).toEqual([
      "failed",
      "failed",
      "active",
    ]);
    await runtime.dispose();
    resetGlobalRuntime();
  });
});
