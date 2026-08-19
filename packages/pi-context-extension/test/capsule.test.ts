import { describe, expect, it } from "vitest";
import { estimateModelTokens } from "@pi-mentis/pi-mentis-core";

import {
  capsuleEntry,
  emptyCapsule,
  formatProcedureBlock,
  procedureContextBudget,
  selectCapsuleEntries,
  selectProcedureEntry,
} from "../src/capsule.js";

const optionalProcedure = {
  candidateId: "candidate:optional-config",
  familyKey: "procedure-family:optional-config",
  family: {
    domain: "config",
    failureMode: "initialization_failure",
    trigger: "value_missing",
    semanticRole: "optional",
    intendedBehavior: "fallback",
  },
  independentSuccesses: 3,
  trigger: "configuration initialization fails when an optional value is absent",
  firstCheck: "Inspect the missing-value path and confirm optional versus required semantics.",
  validatedSteps: [
    "Inspect the missing-value path and confirm optional versus required semantics.",
    "Apply the smallest fallback only when the value is optional.",
    "Run the focused configuration test.",
  ],
  successCriteria: ["Focused configuration tests pass"],
  excludesWhen: ["The configuration value is required"],
  lifecycle: "promoted" as const,
};

function procedureCapsule(repositoryId = "repo-a") {
  return {
    ...emptyCapsule("session-new"),
    entries: [
      capsuleEntry({
        id: "memory:procedure",
        text: "optional configuration initialization missing value fallback",
        kind: "procedure" as const,
        authority: 40,
        scopeKind: "repository",
        scopeId: repositoryId,
        procedure: optionalProcedure,
      }),
    ],
  };
}

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

  it("enforces a model-token budget for CJK capsule entries", () => {
    const capsule = {
      ...emptyCapsule("session-1"),
      entries: [
        capsuleEntry({
          id: "first",
          text: `数据库偏好：${"中文".repeat(200)}`,
          kind: "memory" as const,
          authority: 100,
        }),
        capsuleEntry({
          id: "second",
          text: `数据库备份：${"中文".repeat(200)}`,
          kind: "memory" as const,
          authority: 90,
        }),
      ],
    };
    const firstCost = capsule.entries[0]?.estimatedTokens ?? 0;
    expect(selectCapsuleEntries(capsule, "数据库 中文", { maxTokens: firstCost })).toHaveLength(1);
  });

  it("deduplicates memories already referenced by active context", () => {
    const capsule = {
      ...emptyCapsule("session-1"),
      entries: [
        capsuleEntry({
          id: "already-active",
          text: "The repository uses pnpm for package management.",
          kind: "memory" as const,
          authority: 90,
        }),
      ],
    };
    expect(
      selectCapsuleEntries(capsule, "Which package manager does the repository use?", {
        excludeIds: new Set(["already-active"]),
      }),
    ).toEqual([]);
  });

  it("retrieves one promoted optional-config procedure for a new session in the same repository", () => {
    const selected = selectProcedureEntry(
      procedureCapsule(),
      "项目现在启动报了一个配置错误，请修好并验证。",
      {
        tenantId: "local",
        userId: "local",
        appId: "pi",
        agentId: "pi-mentis",
        repositoryId: "repo-a",
        sessionId: "brand-new-session",
      },
    );
    expect(selected).toEqual(
      expect.objectContaining({
        rank: 1,
        gateDecision: "allowed",
        entry: expect.objectContaining({ id: "memory:procedure", kind: "procedure" }),
      }),
    );
  });

  it("does not apply an optional-config procedure to an explicitly required value", () => {
    expect(
      selectProcedureEntry(
        procedureCapsule(),
        "REQUIRED_SERVICE_TOKEN is required and startup configuration initialization fails",
        {
          tenantId: "local",
          userId: "local",
          appId: "pi",
          agentId: "pi-mentis",
          repositoryId: "repo-a",
        },
      ),
    ).toBeUndefined();
  });

  it("rejects a procedure from the wrong repository", () => {
    expect(
      selectProcedureEntry(procedureCapsule("repo-a"), "startup config error", {
        tenantId: "local",
        userId: "local",
        appId: "pi",
        agentId: "pi-mentis",
        repositoryId: "repo-b",
      }),
    ).toBeUndefined();
  });

  it("keeps the typed procedure block and combined Working Memory budget bounded", () => {
    const entry = procedureCapsule().entries[0];
    expect(entry).toBeDefined();
    const block = formatProcedureBlock(entry!, 200);
    expect(block).toContain("Verified procedure");
    expect(block).toContain("First check:");
    expect(block).toContain("Do not apply when:");
    expect(block).toContain("configuration value is required");
    expect(estimateModelTokens(block!)).toBeLessThanOrEqual(200);
    expect(procedureContextBudget(900, 1_200)).toBe(200);
    expect(procedureContextBudget(1_100, 1_200)).toBe(100);
    expect(procedureContextBudget(1_200, 1_200)).toBe(0);
  });

  it("does not select degraded or retired procedure lifecycle entries", () => {
    const capsule = procedureCapsule();
    const stale = {
      ...capsule,
      entries: capsule.entries.map((entry) => ({
        ...entry,
        procedure: { ...optionalProcedure, lifecycle: "retired" },
      })),
    };
    expect(
      selectProcedureEntry(stale as typeof capsule, "startup config error", {
        tenantId: "local",
        userId: "local",
        appId: "pi",
        agentId: "pi-mentis",
        repositoryId: "repo-a",
      }),
    ).toBeUndefined();
  });
});
