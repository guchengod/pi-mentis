import { describe, it, expect, beforeEach } from "vitest";

import { MentisBackgroundQueue, type MentisBackgroundJob } from "../src/background-queue.js";

function job(id: string, delayMs = 0, coalesceKey?: string): MentisBackgroundJob {
  return {
    kind: "capture.persist",
    ...(coalesceKey !== undefined ? { coalesceKey } : {}),
    execute: async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      results.push(id);
    },
  };
}

let results: string[];

beforeEach(() => {
  results = [];
});

describe("MentisBackgroundQueue", () => {
  it("executes enqueued jobs", async () => {
    const queue = new MentisBackgroundQueue({ maxConcurrency: 1 });
    queue.enqueue(job("a"));
    queue.enqueue(job("b"));

    await queue.drain();
    expect(results).toContain("a");
    expect(results).toContain("b");
  });

  it("respects max concurrency", async () => {
    const running: string[] = [];
    const completed: string[] = [];

    const queue = new MentisBackgroundQueue({ maxConcurrency: 1 });
    queue.enqueue({
      kind: "capture.persist",
      execute: async () => {
        running.push("a");
        await new Promise((r) => setTimeout(r, 50));
        completed.push("a");
      },
    });
    queue.enqueue({
      kind: "capture.persist",
      execute: async () => {
        running.push("b");
        await new Promise((r) => setTimeout(r, 10));
        completed.push("b");
      },
    });

    await new Promise((r) => setTimeout(r, 20));

    // Max concurrency=1 means only "a" starts immediately
    expect(running).toEqual(["a"]);

    await queue.drain();
    expect(completed).toContain("a");
    expect(completed).toContain("b");
  });

  it("coalesces jobs with same coalesceKey", async () => {
    const queue = new MentisBackgroundQueue({ maxConcurrency: 1 });
    queue.enqueue(job("first"));
    queue.enqueue(job("second", 0, "snapshot.checkpoint"));
    queue.enqueue(job("third", 0, "snapshot.checkpoint"));

    await queue.drain();
    expect(results).toContain("first");
    expect(results).toContain("third");
    expect(results).not.toContain("second");
  });

  it("drops oldest when queue is full", async () => {
    const queue = new MentisBackgroundQueue({ maxConcurrency: 1, maxQueueLength: 2 });

    queue.enqueue({
      kind: "capture.persist",
      execute: async () => {
        await new Promise((r) => setTimeout(r, 100));
        results.push("blocker");
      },
    });
    queue.enqueue(job("old1", 10));
    queue.enqueue(job("old2", 10));
    queue.enqueue(job("keep1", 10));
    queue.enqueue(job("keep2", 10));

    await queue.drain();
    expect(results).not.toContain("old1");
    expect(results).not.toContain("old2");
    expect(results).toContain("keep1");
    expect(results).toContain("keep2");
    expect(results).toContain("blocker");
  });

  it("isolates errors from affecting other jobs", async () => {
    const queue = new MentisBackgroundQueue({ maxConcurrency: 1 });
    queue.enqueue({
      kind: "capture.persist",
      execute: async () => {
        throw new Error("boom");
      },
    });
    queue.enqueue(job("b"));

    await queue.drain();
    expect(results).toContain("b");
  });

  it("ignores enqueue after drain called", async () => {
    const queue = new MentisBackgroundQueue({ maxConcurrency: 1 });
    queue.enqueue(job("a"));

    const drainPromise = queue.drain();
    queue.enqueue(job("b"));

    await drainPromise;
    // Only "a" runs; "b" was enqueued after draining started
  });

  it("reports pending and running counts", async () => {
    const queue = new MentisBackgroundQueue({ maxConcurrency: 1 });
    expect(queue.pendingCount).toBe(0);
    expect(queue.runningCount).toBe(0);

    queue.enqueue({
      kind: "capture.persist",
      execute: async () => {
        await new Promise((r) => setTimeout(r, 80));
        results.push("slow");
      },
    });
    queue.enqueue(job("b"));

    await new Promise((r) => setTimeout(r, 10));
    expect(queue.runningCount).toBe(1);
    expect(queue.pendingCount).toBe(1);

    await queue.drain();
    expect(queue.runningCount).toBe(0);
    expect(queue.pendingCount).toBe(0);
    expect(results).toContain("slow");
    expect(results).toContain("b");
  });

  it("supports multiple job kinds", async () => {
    const queue = new MentisBackgroundQueue({ maxConcurrency: 2 });
    const kinds: string[] = [];

    const kinds_: ("capture.persist" | "topic.refresh" | "task.refresh" | "snapshot.checkpoint" | "memory.consolidate" | "experience.extract")[] = [
      "capture.persist",
      "topic.refresh",
      "task.refresh",
      "snapshot.checkpoint",
      "memory.consolidate",
      "experience.extract",
    ];

    for (const kind of kinds_) {
      queue.enqueue({
        kind,
        execute: async () => {
          kinds.push(kind);
        },
      });
    }

    await queue.drain();
    expect(kinds.length).toBe(6);
    expect(new Set(kinds).size).toBe(6);
  });
});
