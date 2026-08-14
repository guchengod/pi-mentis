import { describe, expect, it } from "vitest";

import {
  compactReadReference,
  fullReadResult,
  readRequestKey,
} from "@pi-mentis/pi-mentis-memory-core";

const artifactId = "a".repeat(64);

describe("large read results", () => {
  const envelope = {
    toolName: "read",
    input: { path: "skills/wewrite/SKILL.md" },
    cwd: "/workspace",
    text: "# Complete skill\n\nUse the complete workflow.",
    captureIntegrity: { complete: true, lossy: false, capturedBytes: 42 },
  } as const;
  const result = {
    mode: "truncated" as const,
    symbolic: {
      tool: "read",
      status: "completed" as const,
      artifactId,
      errorCount: 0,
      keyErrors: [],
      files: [],
      truncated: true,
      originalBytes: 42,
      preview: "# Complete skill",
    },
    modelText: "preview",
    tokenAccounting: {
      estimator: "conservative-utf8-v1" as const,
      originalTokens: 10,
      retainedTokens: 2,
      offloadedTokens: 8,
    },
  };

  it("returns the complete first read and a retrievable artifact reference", () => {
    const text = fullReadResult(envelope, result);

    expect(text).toContain(envelope.text);
    expect(text).toContain(artifactId);
    expect(text).toContain('search_memory({ id: "artifact-id", query: "focused keywords" })');
  });

  it("uses one stable key and omits the preview from repeated-read summaries", () => {
    expect(readRequestKey(envelope)).toBe(readRequestKey({ ...envelope, text: "different" }));

    const text = compactReadReference(envelope, result);
    expect(text).toContain(artifactId);
    expect(text).not.toContain("# Complete skill");
    expect(text).not.toContain("preview");
  });
});
