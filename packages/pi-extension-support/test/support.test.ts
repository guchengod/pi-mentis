import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  createPiPairwiseRelationshipReasoner,
  formatPiToolJson,
  normalizePiPathArgument,
  notifyWhenUiAvailable,
  RecentAssertionOverlay,
} from "../src/index.js";

describe("Pi extension support", () => {
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
        projection: "shadowed_by_pending",
        shadowedByPendingId: "new",
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
              sameReferent: true,
              sameAttribute: true,
              explicitNewAssertion: true,
              explicitRetraction: false,
              replacementValuePresent: true,
              compatibleValue: false,
              incompatibleValue: true,
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
      signals: { sameReferent: true, incompatibleValue: true },
      incomingHints: { valueHint: "51842" },
    });
    expect(complete).toHaveBeenCalledOnce();
  });
});
