import { describe, expect, it } from "vitest";

import { capsuleEntry, emptyCapsule, selectCapsuleEntries } from "../src/capsule.js";

describe("memory capsule", () => {
  it("selects relevant English facts without I/O", () => {
    const capsule = {
      ...emptyCapsule("session-1"),
      revision: 2,
      entries: [
        capsuleEntry({
          id: "editor",
          text: "The user prefers Neovim for editing TypeScript.",
          kind: "profile",
          authority: 90,
        }),
        capsuleEntry({
          id: "database",
          text: "The project uses PostgreSQL for durable storage.",
          kind: "memory",
          authority: 90,
        }),
      ],
    };

    expect(selectCapsuleEntries(capsule, "Which editor should I use for TypeScript?")).toEqual([
      expect.objectContaining({ id: "editor" }),
    ]);
  });

  it("uses CJK bigrams for Chinese prompts", () => {
    const capsule = {
      ...emptyCapsule("session-1"),
      entries: [
        capsuleEntry({
          id: "response-style",
          text: "用户喜欢回答先给结论，再解释原因。",
          kind: "profile",
          authority: 100,
        }),
      ],
    };

    expect(selectCapsuleEntries(capsule, "请按照用户喜欢的回答方式回复")).toEqual([
      expect.objectContaining({ id: "response-style" }),
    ]);
  });

  it("returns no evidence for unrelated prompts", () => {
    const capsule = {
      ...emptyCapsule("session-1"),
      entries: [
        capsuleEntry({
          id: "database",
          text: "The project uses PostgreSQL.",
          kind: "memory",
          authority: 90,
        }),
      ],
    };

    expect(selectCapsuleEntries(capsule, "Render the landing page header")).toEqual([]);
  });
});
