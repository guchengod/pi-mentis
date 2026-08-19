import { describe, expect, it } from "vitest";

import type { WorkingMemorySnapshot } from "@pi-mentis/pi-mentis-memory-core";

import { shouldAcceptActiveContext } from "../src/active-context.js";

function snapshot(revision: number, branchGeneration = 2): WorkingMemorySnapshot {
  return {
    version: 1,
    stateId: "state",
    namespace: "namespace",
    sessionId: "session",
    branchId: "branch",
    branchGeneration,
    revision,
    generatedAt: revision,
    content: "context",
    estimatedTokens: 1,
    recalledMemoryIds: [],
    artifactRefs: [],
  };
}

describe("Active Context revision lease", () => {
  it("rejects stale revisions and snapshots from stale branch generations", () => {
    const current = snapshot(4);
    const expected = { sessionId: "session", branchId: "branch", branchGeneration: 2 };
    expect(shouldAcceptActiveContext(current, "session", snapshot(3), expected)).toBe(false);
    expect(shouldAcceptActiveContext(current, "session", snapshot(4), expected)).toBe(false);
    expect(shouldAcceptActiveContext(current, "session", snapshot(5, 1), expected)).toBe(false);
    expect(shouldAcceptActiveContext(current, "session", snapshot(5), expected)).toBe(true);
  });
});
