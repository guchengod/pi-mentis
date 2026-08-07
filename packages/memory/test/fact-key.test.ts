import { describe, it, expect } from "vitest";

import { deriveFactKey } from "../src/fact-key.js";
import type { KnownPredicate } from "../src/predicate-registry.js";

/**
 * FactIdentityBuilder tests. The SEMANTIC predicate is supplied by
 * CommitSemanticPlanner (tested in commit-semantics.test.ts); this module
 * only builds the deterministic identity string from it.
 */

describe("deriveFactKey — predicate supplied semantically", () => {
  it("builds factKey with project_package_manager predicate", () => {
    const result = deriveFactKey(
      "Project uses pnpm@10.20.0 as package manager",
      "project",
      { tenantId: "local", userId: "u1", appId: "pi", agentId: "test", repositoryId: "my-repo" },
      "project_package_manager",
    );
    expect(result.predicateKey).toBe("project_package_manager");
    expect(result.factKey).toContain("/project_package_manager");
    expect(result.fallbackUsed).toBe(false);
  });

  it("builds factKey with project_build_command predicate", () => {
    const result = deriveFactKey(
      "The build command for this project is turbo build",
      "project",
      { tenantId: "local", userId: "u1", appId: "pi", agentId: "test", repositoryId: "my-repo" },
      "project_build_command",
    );
    expect(result.predicateKey).toBe("project_build_command");
    expect(result.factKey).toContain("/project_build_command");
  });

  it("different predicates on the same subject produce different factKeys", () => {
    const ctx = { tenantId: "local", userId: "u1", appId: "pi", agentId: "test", repositoryId: "my-repo" };
    const r1 = deriveFactKey("pnpm is the package manager", "project", ctx, "project_package_manager");
    const r2 = deriveFactKey("build command is turbo build", "project", ctx, "project_build_command");
    expect(r1.factKey).not.toBe(r2.factKey);
    expect(r1.predicateKey).toBe("project_package_manager");
    expect(r2.predicateKey).toBe("project_build_command");
  });

  it("falls back deterministically when no predicate is selected", () => {
    const result = deriveFactKey("The sky is blue", "topic", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
    });
    expect(result.fallbackUsed).toBe(true);
    expect(result.predicateKey).toBeUndefined();
    expect(result.factKey).toContain("/fallback:");
  });

  it("uses different subjectKeys for different domains", () => {
    const userResult = deriveFactKey("以后叫你小明", "user", {
      tenantId: "local",
      userId: "user-1",
      appId: "pi",
      agentId: "test",
    }, "assistant_alias");
    const projectResult = deriveFactKey("构建命令是 pnpm build", "project", {
      tenantId: "local",
      userId: "user-1",
      appId: "pi",
      agentId: "test",
      repositoryId: "repo-1",
    }, "project_build_command");
    expect(userResult.subjectKey).toBe("user-1");
    expect(projectResult.subjectKey).toBe("repo-1");
  });

  // ─── Regression: Set Cardinality / Normalized Value / Cross-Predicate ───

  it("programming_language_preference extracts normalizedValue and setMemberKey", () => {
    const result = deriveFactKey(
      "除了 Go 之外，我也很喜欢 TypeScript",
      "user",
      { tenantId: "local", userId: "user-1", appId: "pi", agentId: "test" },
      "programming_language_preference",
    );
    expect(result.predicateKey).toBe("programming_language_preference");
    expect(result.fallbackUsed).toBe(false);
    expect(result.normalizedValue?.toLowerCase()).toContain("go");
    expect(result.normalizedValue?.toLowerCase()).toContain("typescript");
    expect(result.setMemberKey).toBeDefined();
  });

  it("language predicate with a single mention → single-language set member", () => {
    const result = deriveFactKey(
      "我喜欢 Go",
      "user",
      { tenantId: "local", userId: "user-1", appId: "pi", agentId: "test" },
      "language",
    );
    expect(result.predicateKey).toBe("language");
    expect(result.normalizedValue?.toLowerCase()).toBe("go");
  });

  it("unknown predicate keeps identity stable for identical wording", () => {
    const ctx = { tenantId: "local", userId: "u1", appId: "pi", agentId: "test" };
    const a = deriveFactKey("一条普通的事实陈述", "user", ctx);
    const b = deriveFactKey("一条普通的事实陈述", "user", ctx);
    expect(a.factKey).toBe(b.factKey);
    expect(a.fallbackUsed).toBe(true);
  });

  it("known predicate keeps identity stable across equivalent wording", () => {
    const ctx = { tenantId: "local", userId: "u1", appId: "pi", agentId: "test", repositoryId: "repo" };
    const a = deriveFactKey("构建命令是 pnpm build", "project", ctx, "project_build_command");
    const b = deriveFactKey("这个项目的构建命令是 turbo build", "project", ctx, "project_build_command");
    expect(a.factKey).toBe(b.factKey);
  });

  it("assistant_alias predicate produces stable key", () => {
    const a = deriveFactKey("以后叫你小明", "user", undefined, "assistant_alias" as KnownPredicate);
    const b = deriveFactKey("以后叫你小红", "user", undefined, "assistant_alias" as KnownPredicate);
    expect(a.predicateKey).toBe("assistant_alias");
    expect(a.factKey).toBe(b.factKey);
  });
});
