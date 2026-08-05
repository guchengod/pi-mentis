import { describe, it, expect } from "vitest";

import { deriveTemporalState, type MemoryLifecycleStatus } from "../src/temporal.js";

describe("deriveTemporalState", () => {
  it('maps "active" → "current"', () => {
    expect(deriveTemporalState("active")).toBe("current");
  });

  it('maps "superseded" → "historical"', () => {
    expect(deriveTemporalState("superseded")).toBe("historical");
  });

  it('maps "retracted" → "historical"', () => {
    expect(deriveTemporalState("retracted")).toBe("historical");
  });

  it('maps "tombstoned" → "historical"', () => {
    expect(deriveTemporalState("tombstoned")).toBe("historical");
  });

  it('maps "expired" → "historical"', () => {
    expect(deriveTemporalState("expired")).toBe("historical");
  });

  it('maps "conflicted" → "conflicted"', () => {
    expect(deriveTemporalState("conflicted")).toBe("conflicted");
  });

  it('maps "pending" → "invalid"', () => {
    expect(deriveTemporalState("pending")).toBe("invalid");
  });

  it('maps "rejected" → "invalid"', () => {
    expect(deriveTemporalState("rejected")).toBe("invalid");
  });

  it("is symmetric: superseded never maps to current", () => {
    expect(deriveTemporalState("superseded")).not.toBe("current");
    expect(deriveTemporalState("retracted")).not.toBe("current");
    expect(deriveTemporalState("tombstoned")).not.toBe("current");
  });
});

describe("MemoryLifecycleStatus completeness", () => {
  it("covers all known statuses", () => {
    const statuses: MemoryLifecycleStatus[] = [
      "pending",
      "active",
      "superseded",
      "conflicted",
      "retracted",
      "tombstoned",
      "rejected",
      "expired",
    ];
    for (const status of statuses) {
      const result = deriveTemporalState(status);
      expect(result).toBeDefined();
      expect(["current", "historical", "conflicted", "invalid"]).toContain(result);
    }
  });
});
