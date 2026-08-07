import { describe, it, expect } from "vitest";

import { PerformanceTrace } from "../src/performance-trace.js";

describe("PerformanceTrace", () => {
  it("tracks total elapsed time", async () => {
    const trace = new PerformanceTrace();
    trace.start();
    await new Promise((r) => setTimeout(r, 20));
    const timing = trace.snapshot({ projectCacheHit: true, topicReused: true, taskReused: true });
    expect(timing.totalMs).toBeGreaterThan(0);
  });

  it("marks distinct phases and computes deltas", () => {
    const trace = new PerformanceTrace();
    trace.start();
    trace.mark("projectIdentity");
    trace.mark("topic");
    trace.mark("task");
    trace.mark("embedding");
    trace.mark("rerank");
    trace.mark("recall");
    trace.mark("zvec");
    trace.mark("snapshotRead");
    trace.mark("snapshotWrite");
    trace.mark("capture");

    const timing = trace.snapshot({ projectCacheHit: true, topicReused: false, taskReused: false });
    expect(timing.totalMs).toBeGreaterThanOrEqual(0);
    expect(timing.projectIdentityMs).toBeGreaterThanOrEqual(0);
    expect(timing.topicMs).toBeGreaterThanOrEqual(0);
    expect(timing.taskMs).toBeGreaterThanOrEqual(0);
  });

  it("counts remote calls", () => {
    const trace = new PerformanceTrace();
    trace.incrementEmbeddingCalls();
    trace.incrementEmbeddingCalls();
    trace.incrementRerankCalls();
    trace.incrementRemoteCalls();

    const timing = trace.snapshot({ projectCacheHit: true, topicReused: true, taskReused: true });
    expect(timing.embeddingCallCount).toBe(2);
    expect(timing.rerankCallCount).toBe(1);
    expect(timing.remoteCallCount).toBe(1);
  });

  it("snapshot includes cache hit flags", () => {
    const trace = new PerformanceTrace();
    trace.start();
    const timing = trace.snapshot({ projectCacheHit: true, topicReused: true, taskReused: false });
    expect(timing.projectCacheHit).toBe(true);
    expect(timing.topicReused).toBe(true);
    expect(timing.taskReused).toBe(false);
  });

  it("all timing fields are present in snapshot", () => {
    const trace = new PerformanceTrace();
    trace.start();
    const timing = trace.snapshot({ projectCacheHit: false, topicReused: false, taskReused: false });

    expect(timing).toHaveProperty("totalMs");
    expect(timing).toHaveProperty("projectIdentityMs");
    expect(timing).toHaveProperty("topicMs");
    expect(timing).toHaveProperty("taskMs");
    expect(timing).toHaveProperty("embeddingMs");
    expect(timing).toHaveProperty("rerankMs");
    expect(timing).toHaveProperty("recallMs");
    expect(timing).toHaveProperty("zvecMs");
    expect(timing).toHaveProperty("snapshotReadMs");
    expect(timing).toHaveProperty("snapshotWriteMs");
    expect(timing).toHaveProperty("captureMs");
    expect(timing).toHaveProperty("remoteCallCount");
    expect(timing).toHaveProperty("embeddingCallCount");
    expect(timing).toHaveProperty("rerankCallCount");
    expect(timing).toHaveProperty("projectCacheHit");
    expect(timing).toHaveProperty("topicReused");
    expect(timing).toHaveProperty("taskReused");
  });

  it("fresh trace has zero counts", () => {
    const trace = new PerformanceTrace();
    trace.start();
    const timing = trace.snapshot({ projectCacheHit: true, topicReused: true, taskReused: true });

    expect(timing.remoteCallCount).toBe(0);
    expect(timing.embeddingCallCount).toBe(0);
    expect(timing.rerankCallCount).toBe(0);
  });
});
