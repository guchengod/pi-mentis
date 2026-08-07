import { describe, it, expect, beforeEach } from "vitest";

import { TurnContextManager } from "../src/turn-context.js";

describe("TurnContextManager", () => {
  let ctx: TurnContextManager;

  beforeEach(() => {
    ctx = new TurnContextManager();
  });

  it("starts with empty topic and task", () => {
    expect(ctx.activeTopic.topicId).toBeUndefined();
    expect(ctx.activeTopic.confidence).toBe(0);
    expect(ctx.activeTask.taskId).toBeUndefined();
    expect(ctx.activeTask.status).toBe("none");
  });

  it("updates topic state", () => {
    ctx.updateTopic("topic-1", 0.9);
    expect(ctx.activeTopic.topicId).toBe("topic-1");
    expect(ctx.activeTopic.confidence).toBe(0.9);
    expect(ctx.activeTopic.lastUpdatedTurn).toBe(0);
  });

  it("updates task state", () => {
    ctx.updateTask("task-1", "active", 0.85);
    expect(ctx.activeTask.taskId).toBe("task-1");
    expect(ctx.activeTask.status).toBe("active");
    expect(ctx.activeTask.confidence).toBe(0.85);
  });

  it("shouldRefreshTopic returns false within maxStaleTurns", () => {
    ctx.updateTopic("topic-1", 0.9);
    ctx.nextTurn("query 1");
    ctx.nextTurn("query 2");
    expect(ctx.shouldRefreshTopic(3)).toBe(false);
  });

  it("shouldRefreshTopic returns true after maxStaleTurns", () => {
    ctx.updateTopic("topic-1", 0.9);
    ctx.nextTurn("q1");
    ctx.nextTurn("q2");
    ctx.nextTurn("q3");
    ctx.nextTurn("q4");
    expect(ctx.shouldRefreshTopic(3)).toBe(true);
  });

  it("shouldRefreshTask returns false within maxStaleTurns", () => {
    ctx.updateTask("task-1", "active", 0.85);
    ctx.nextTurn("query 1");
    ctx.nextTurn("query 2");
    expect(ctx.shouldRefreshTask(5)).toBe(false);
  });

  it("shouldRefreshTask returns true after maxStaleTurns", () => {
    ctx.updateTask("task-1", "active", 0.85);
    for (let i = 0; i < 6; i++) ctx.nextTurn(`query ${i}`);
    expect(ctx.shouldRefreshTask(5)).toBe(true);
  });

  it("tracking turn count increments", () => {
    expect(ctx.turnCount).toBe(0);
    const t1 = ctx.nextTurn("hello");
    expect(ctx.turnCount).toBe(1);
    expect(t1.turnId).toBe("turn:1");
    expect(t1.normalizedQuery).toBe("hello");

    const t2 = ctx.nextTurn("world");
    expect(ctx.turnCount).toBe(2);
    expect(t2.turnId).toBe("turn:2");
  });

  it("stores and retrieves query vector for cross-turn sharing", () => {
    expect(ctx.queryVector).toBeUndefined();

    const vec = new Float32Array([0.1, 0.2, 0.3]);
    ctx.setQueryVector(vec);
    expect(ctx.queryVector).toBe(vec);

    const turn = ctx.nextTurn("query");
    expect(turn.queryVector).toBe(vec);
  });

  it("turn context includes correct flags", () => {
    const turn = ctx.nextTurn("test query");
    expect(turn.projectIdentityCacheHit).toBe(false);
    expect(turn.topicReused).toBe(false);
    expect(turn.taskReused).toBe(false);
    expect(turn.createdAt).toBeGreaterThan(0);
    expect(turn.normalizedQuery).toBe("test query");
  });

  it("topic update tracks turn-based staleness", () => {
    expect(ctx.shouldRefreshTopic(3)).toBe(true);

    ctx.updateTopic("t1", 0.8);
    expect(ctx.shouldRefreshTopic(3)).toBe(false);

    for (let i = 0; i < 3; i++) ctx.nextTurn(`q${i}`);
    expect(ctx.shouldRefreshTopic(3)).toBe(true);
  });

  it("task status changes are tracked", () => {
    ctx.updateTask("task-1", "active", 0.9);
    expect(ctx.activeTask.status).toBe("active");

    ctx.updateTask("task-1", "completed", 0.95);
    expect(ctx.activeTask.status).toBe("completed");
  });

  it("topic cleared on undefined update", () => {
    ctx.updateTopic("topic-1", 0.9);
    expect(ctx.activeTopic.topicId).toBe("topic-1");

    ctx.updateTopic(undefined, 0);
    expect(ctx.activeTopic.topicId).toBeUndefined();
  });
});
