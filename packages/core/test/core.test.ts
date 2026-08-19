import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  BackgroundScheduler,
  CpuWorkerPool,
  DeferredIdleWork,
  MentisContextResolver,
  PriorityHeap,
  ProviderPriority,
  TaskPriority,
  UnsupportedPiVersionError,
  PI_COMPATIBILITY,
  assertPiCompatibility,
  computeToolPlan,
  contextAffinity,
  detectInstalledPackageVersion,
  findInstalledPackageRoot,
  getOrCreateRuntime,
  inferInteractionMode,
  assertStorageRootReady,
  detectLegacyProjectStore,
  getStorageStatus,
  getEmbeddingRuntimeResolution,
  loadConfig,
  resetGlobalRuntime,
  resolveStorageRoot,
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
    piVersion: "0.84.0",
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
  it("accepts Pi at or above the minimum required version", () => {
    expect(() => assertPiCompatibility(PI_COMPATIBILITY.minVersion)).not.toThrow();
    expect(() => assertPiCompatibility("0.85.0")).not.toThrow();
    expect(() => assertPiCompatibility("1.0.0")).not.toThrow();
    expect(() => assertPiCompatibility("0.82.2")).toThrow(UnsupportedPiVersionError);
    try {
      assertPiCompatibility("0.81.0");
    } catch (error) {
      expect((error as UnsupportedPiVersionError).toJSON()).toMatchObject({
        code: "UNSUPPORTED_PI_VERSION",
        details: {
          currentVersion: "0.81.0",
          minVersion: PI_COMPATIBILITY.minVersion,
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
    const root = await mkdtemp(path.join(tmpdir(), "pi-mentis-config-"));
    try {
      const config = await loadConfig("/nonexistent/pi-mentis-config-test", undefined, {
        PI_MENTIS_HOME: path.join(root, "mentis"),
        SILICONFLOW_BASE_URL: "https://api.siliconflow.cn/v1",
        SILICONFLOW_EMBEDDING_MODEL: "BAAI/bge-m3",
        SILICONFLOW_RERANKER_MODEL: "BAAI/bge-reranker-v2-m3",
      });
      expect(config.inference.siliconflow).toMatchObject({
        baseUrl: "https://api.siliconflow.cn/v1",
        embedding: { model: "BAAI/bge-m3", dimensions: 1_024 },
        rerank: { model: "BAAI/bge-reranker-v2-m3", maxInputTokens: 8_192 },
      });
      expect(config.storage.rootDir).toBe(path.join(root, "mentis", "zvec"));
      expect(config.retrieval.automaticRecall).toBe(false);
      expect(config.intelligence.workingMemory).toMatchObject({
        enabled: true,
        promptTokens: 900,
        hardMaxTokens: 1_200,
      });
      expect(config.intelligence.memoryFormation).toMatchObject({
        enabled: true,
        autoPromotion: false,
        maxCandidatesPerTurn: 3,
      });
      expect(config.intelligence.consolidation).toMatchObject({
        enabled: true,
        maxDigestTokens: 1_600,
        procedureMinimumOutcomes: 3,
      });
      expect(config.performance.sidecar).toEqual({
        cpuNice: 10,
        knowledgeJobConcurrency: 2,
        maintenanceDelayMs: 5_000,
      });
      expect(config.performance.resources.maxConcurrentParsers).toBe(2);
      expect(getEmbeddingRuntimeResolution(config)).toMatchObject({
        source: "environment",
        environmentOverrideActive: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps explicit embedding configuration authoritative over inherited environment", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-mentis-config-priority-"));
    try {
      const filename = path.join(root, "config.json");
      await writeFile(
        filename,
        JSON.stringify({
          inference: {
            siliconflow: {
              embedding: { model: "Qwen/Qwen3-Embedding-8B", dimensions: 4096 },
            },
          },
        }),
      );
      const config = await loadConfig("/nonexistent/pi-mentis-config-test", filename, {
        SILICONFLOW_EMBEDDING_MODEL: "BAAI/bge-m3",
        SILICONFLOW_EMBEDDING_DIMENSIONS: "1024",
      });
      expect(config.inference.siliconflow.embedding).toMatchObject({
        model: "Qwen/Qwen3-Embedding-8B",
        dimensions: 4096,
      });
      expect(getEmbeddingRuntimeResolution(config)).toMatchObject({
        configured: { model: "Qwen/Qwen3-Embedding-8B", dimensions: 4096 },
        effective: { model: "Qwen/Qwen3-Embedding-8B", dimensions: 4096 },
        source: "config",
        environmentOverrideActive: false,
      });
      expect(Object.isFrozen(config.inference.siliconflow.embedding)).toBe(true);
      await writeFile(
        filename,
        JSON.stringify({
          inference: { siliconflow: { embedding: { model: "BAAI/bge-m3", dimensions: 1024 } } },
        }),
      );
      // A running extension closes over this immutable effective snapshot; a
      // config-file edit only takes effect after the next process startup.
      expect(config.inference.siliconflow.embedding).toMatchObject({
        model: "Qwen/Qwen3-Embedding-8B",
        dimensions: 4096,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves an explicit BGE configuration when a different model leaks through the environment", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-mentis-config-bge-"));
    try {
      const filename = path.join(root, "config.json");
      await writeFile(
        filename,
        JSON.stringify({
          inference: {
            siliconflow: { embedding: { model: "BAAI/bge-m3", dimensions: 1024 } },
          },
        }),
      );
      const config = await loadConfig("/nonexistent/pi-mentis-config-test", filename, {
        SILICONFLOW_EMBEDDING_MODEL: "Qwen/Qwen3-Embedding-8B",
        SILICONFLOW_EMBEDDING_DIMENSIONS: "4096",
      });
      expect(config.inference.siliconflow.embedding).toMatchObject({
        model: "BAAI/bge-m3",
        dimensions: 1024,
      });
      expect(getEmbeddingRuntimeResolution(config)).toMatchObject({ source: "config" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

describe("single global storage root", () => {
  it("resolves implicit and explicit default Pi profiles to the same canonical root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-mentis-root-"));
    try {
      const homeDir = path.join(root, "home");
      const defaultAgentDir = path.join(homeDir, ".pi", "agent");
      const implicit = resolveStorageRoot({ environment: {}, homeDir });
      const explicit = resolveStorageRoot({
        environment: { PI_CODING_AGENT_DIR: defaultAgentDir },
        homeDir,
      });

      expect(implicit.mentisRoot).toBe(path.join(homeDir, ".pi", ".pi-mentis"));
      expect(explicit.mentisRoot).toBe(implicit.mentisRoot);
      expect(implicit.source).toBe("pi-default-agent-dir");
      expect(explicit.source).toBe("pi-agent-dir");
      expect(implicit.isDefaultProfile).toBe(true);
      expect(explicit.isDefaultProfile).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an explicit Pi profile and PI_MENTIS_HOME isolated", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-mentis-profile-"));
    try {
      const homeDir = path.join(root, "home");
      const profile = path.join(root, "profiles", "review");
      const profileRoot = resolveStorageRoot({
        environment: { PI_CODING_AGENT_DIR: profile },
        homeDir,
      });
      const override = path.join(root, "isolated-mentis");
      const overridden = resolveStorageRoot({
        environment: { PI_CODING_AGENT_DIR: profile, PI_MENTIS_HOME: override },
        homeDir,
      });

      expect(profileRoot.mentisRoot).toBe(path.join(profile, ".pi-mentis"));
      expect(profileRoot.isDefaultProfile).toBe(false);
      expect(overridden.mentisRoot).toBe(override);
      expect(overridden.source).toBe("pi-mentis-env");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("selects one compatible default-profile root without disabling the extension", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-mentis-legacy-"));
    try {
      const homeDir = path.join(root, "home");
      const stableRoot = path.join(homeDir, ".pi", ".pi-mentis");
      const agentCompatibilityRoot = path.join(homeDir, ".pi", "agent", ".pi-mentis");

      await mkdir(agentCompatibilityRoot, { recursive: true });
      await writeFile(path.join(agentCompatibilityRoot, "config.json"), "{}\n");
      const compatibility = resolveStorageRoot({ environment: {}, homeDir });
      expect(compatibility.mentisRoot).toBe(agentCompatibilityRoot);
      expect(compatibility.selectionStrategy).toBe("agent-root-compat");
      expect(() => assertStorageRootReady(compatibility)).not.toThrow();

      await mkdir(stableRoot, { recursive: true });
      await writeFile(path.join(stableRoot, "config.json"), "{}\n");
      const deterministic = resolveStorageRoot({ environment: {}, homeDir });
      expect(deterministic.mentisRoot).toBe(stableRoot);
      expect(deterministic.selectionStrategy).toBe("default-home-root");
      expect(deterministic.multipleStoresDetected).toBe(true);
      expect(deterministic.splitBrainDetected).toBe(false);
      expect(deterministic.inactiveAlternateEvidence?.root).toBe(agentCompatibilityRoot);
      expect(() => assertStorageRootReady(deterministic)).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports but never selects a project-local legacy store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-mentis-project-legacy-"));
    try {
      const homeDir = path.join(root, "home");
      const workspace = path.join(root, "workspace");
      const projectStore = path.join(workspace, ".pi-mentis");
      await mkdir(path.join(projectStore, "zvec"), { recursive: true });
      await writeFile(path.join(projectStore, "zvec", "active-index-manifest.json"), "{}\n");
      const options = {
        environment: { PI_MENTIS_HOME: path.join(root, "canonical") },
        homeDir,
      };

      expect(detectLegacyProjectStore(workspace, options)).toMatchObject({
        detected: true,
        path: projectStore,
      });
      expect(getStorageStatus(workspace, undefined, options)).toMatchObject({
        mentisRoot: path.join(root, "canonical"),
        legacyProjectStoreDetected: true,
        legacyProjectStorePath: projectStore,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("priority scheduling and arbitration", () => {
  it("defers cold startup work until an interactive turn settles and the TUI stays quiet", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(async () => undefined);
      const idleWork = new DeferredIdleWork({ delayMs: 100 });
      idleWork.set(run);

      await vi.advanceTimersByTimeAsync(500);
      expect(run).not.toHaveBeenCalled();

      idleWork.settled();
      await vi.advanceTimersByTimeAsync(50);
      idleWork.activity();
      await vi.advanceTimersByTimeAsync(500);
      expect(run).not.toHaveBeenCalled();
      expect(idleWork.pending).toBe(true);

      idleWork.settled();
      await vi.advanceTimersByTimeAsync(100);
      expect(run).toHaveBeenCalledOnce();
      expect(idleWork.pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

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

  it("cleans rejected deduplicated work without creating an unhandled rejection", async () => {
    const scheduler = new BackgroundScheduler({
      maxQueuedTasks: 2,
      maxQueuedBytes: 1_024,
      maxActiveTasks: 1,
    });
    const failed = scheduler.schedule({
      id: "failed",
      deduplicationKey: "same-work",
      priority: TaskPriority.UserRequested,
      estimatedBytes: 1,
      run: async () => {
        throw new Error("expected failure");
      },
    });
    await expect(failed.promise).rejects.toThrow("expected failure");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const retried = scheduler.schedule({
      id: "retried",
      deduplicationKey: "same-work",
      priority: TaskPriority.UserRequested,
      estimatedBytes: 1,
      run: async () => "completed",
    });
    expect(retried.deduplicated).toBe(false);
    await expect(retried.promise).resolves.toBe("completed");
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
