import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BackgroundScheduler,
  MentisContextResolver,
  ProviderPriority,
  TaskPriority,
  contextFingerprint,
  getOrCreateRuntime,
  PI_VERSION,
  resetGlobalRuntime,
  type Clock,
  type FastMentisContext,
} from "../src/index.js";

class VirtualClock implements Clock {
  constructor(private value = 0) {}
  now(): number {
    return this.value;
  }
  advance(milliseconds: number): void {
    this.value += milliseconds;
  }
}

function context(topicIds: readonly string[]): FastMentisContext {
  return {
    runtimeKey: "session:property",
    identity: { tenantId: "t", userId: "u", appId: "pi", agentId: "mentis" },
    conversation: { sessionId: "s", sessionMode: "persistent" },
    situation: { topicIds, interactionMode: "conversation", startedAt: 1 },
    capability: {
      piVersion: PI_VERSION,
      extensionsHash: "e",
      skillsHash: "s",
      mcpHash: "m",
      toolsHash: "t",
      snapshotId: "cap",
    },
  };
}

afterEach(async () => resetGlobalRuntime());

describe("core invariant properties", () => {
  it("produces a deterministic context fingerprint for arbitrary Unicode topics", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 32 }), (topicIds) => {
        const first = context(topicIds);
        const second = context([...topicIds]);
        expect(contextFingerprint(first)).toBe(contextFingerprint(second));
      }),
      { numRuns: 250 },
    );
  });

  it("keeps a snapshot stable within a turn and revises it after branch changes", () => {
    const clock = new VirtualClock(100);
    const resolver = new MentisContextResolver(clock);
    const initial = context(["topic:a"]);
    const first = resolver.resolve(initial);
    clock.advance(5_000);
    expect(resolver.resolve(initial)).toEqual({ snapshot: first.snapshot, reused: true });
    const branch = resolver.resolve({
      ...initial,
      conversation: { ...initial.conversation, branchId: "branch:b" },
    });
    expect(branch.snapshot).toMatchObject({ revision: 2, createdAt: 5_100 });
  });

  it("rejects equal-priority provider ambiguity before initializing either provider", async () => {
    const runtime = getOrCreateRuntime();
    const first = vi.fn(async () => "first");
    const second = vi.fn(async () => "second");
    runtime.registerMemory({
      id: "one",
      version: "1",
      priority: ProviderPriority.integrated,
      initialize: first,
    });
    runtime.registerMemory({
      id: "two",
      version: "1",
      priority: ProviderPriority.integrated,
      initialize: second,
    });
    await expect(runtime.ready()).rejects.toMatchObject({ code: "PROVIDER_CONFLICT" });
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it("records failed initialization, disposes in dependency order, and never calls a shadow", async () => {
    const runtime = getOrCreateRuntime();
    const order: string[] = [];
    runtime.registerEmbedding({
      id: "embedding",
      version: "1",
      priority: ProviderPriority.integrated,
      initialize: async () => "embedding",
      dispose: async () => void order.push("embedding"),
    });
    runtime.registerMemory({
      id: "memory",
      version: "1",
      priority: ProviderPriority.integrated,
      initialize: async () => "memory",
      dispose: async () => void order.push("memory"),
    });
    runtime.registerRetrieval({
      id: "retrieval",
      version: "1",
      priority: ProviderPriority.integrated,
      initialize: async () => "retrieval",
      dispose: async () => void order.push("retrieval"),
    });
    const shadow = vi.fn(async () => "shadow");
    runtime.registerRetrieval({
      id: "standalone",
      version: "1",
      priority: ProviderPriority.standalone,
      initialize: shadow,
    });
    await runtime.ready();
    expect(runtime.snapshot().providers.find((item) => item.id === "standalone")?.state).toBe(
      "shadowed",
    );
    expect(shadow).not.toHaveBeenCalled();
    await runtime.dispose();
    expect(order).toEqual(["retrieval", "memory", "embedding"]);
    expect(runtime.snapshot()).toMatchObject({ ready: false });
    expect(runtime.snapshot().providers.every((item) => item.state === "disposed")).toBe(true);
  });

  it("expires stale background work while preserving the interactive lane", async () => {
    const clock = new VirtualClock();
    const scheduler = new BackgroundScheduler(
      {
        maxQueuedTasks: 10,
        maxQueuedBytes: 1_000,
        maxActiveTasks: 2,
        maxPendingEmbeddingTokens: 100,
        maxPendingRerankTokens: 100,
        maxQueuedTaskAgeMs: 10,
      },
      clock,
    );
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = scheduler.schedule({
      id: "background-active",
      priority: TaskPriority.BackgroundSync,
      estimatedBytes: 1,
      run: async () => blocker,
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const stale = scheduler.schedule({
      id: "background-stale",
      priority: TaskPriority.BackgroundSync,
      estimatedBytes: 1,
      run: async () => "must-not-run",
    });
    clock.advance(100);
    const interactive = scheduler.schedule({
      id: "interactive",
      priority: TaskPriority.Interactive,
      estimatedBytes: 1,
      run: async () => "interactive-result",
    });
    await expect(interactive.promise).resolves.toBe("interactive-result");
    release();
    await first.promise;
    await expect(stale.promise).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
    await scheduler.close();
  });
});
