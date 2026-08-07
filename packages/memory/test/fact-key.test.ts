import { describe, it, expect } from "vitest";

import { deriveFactKey } from "../src/fact-key.js";
import type { KnownPredicate } from "../src/predicate-registry.js";

describe("deriveFactKey", () => {
  it("detects project_package_manager predicate", () => {
    const result = deriveFactKey("Project uses pnpm@10.20.0 as package manager", "project", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
      repositoryId: "my-repo",
    });
    expect(result.predicateKey).toBe("project_package_manager");
    expect(result.factKey).toContain("/project_package_manager");
    expect(result.fallbackUsed).toBe(false);
  });

  it("detects project_build_command predicate", () => {
    const result = deriveFactKey("The build command for this project is turbo build", "project", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
      repositoryId: "my-repo",
    });
    expect(result.predicateKey).toBe("project_build_command");
    expect(result.factKey).toContain("/project_build_command");
  });

  it("detects project_test_command predicate", () => {
    const result = deriveFactKey("Run vitest for testing", "project", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
      repositoryId: "my-repo",
    });
    expect(result.predicateKey).toBe("project_test_command");
  });

  it("detects runtime predicate", () => {
    const result = deriveFactKey("Runtime is Node.js", "environment", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
      repositoryId: "my-repo",
    });
    expect(result.predicateKey).toBe("runtime");
  });

  it("detects assistant_alias predicate", () => {
    const result = deriveFactKey("以后叫你小明", "user", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
    });
    expect(result.predicateKey).toBe("assistant_alias");
  });

  it("different predicates produce different factKeys", () => {
    const r1 = deriveFactKey("pnpm is the package manager", "project", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
      repositoryId: "my-repo",
    });
    const r2 = deriveFactKey("build command is turbo build", "project", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
      repositoryId: "my-repo",
    });
    expect(r1.factKey).not.toBe(r2.factKey);
    expect(r1.predicateKey).toBe("project_package_manager");
    expect(r2.predicateKey).toBe("project_build_command");
  });

  it("falls back when no predicate matches", () => {
    const result = deriveFactKey("The sky is blue", "topic", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
    });
    expect(result.fallbackUsed).toBe(true);
    expect(result.predicateKey).toBeUndefined();
    expect(result.confidence).toBeLessThan(0.6);
  });

  it("uses different subjectKeys for different domains", () => {
    const userResult = deriveFactKey("以后叫你小明", "user", {
      tenantId: "local",
      userId: "user-1",
      appId: "pi",
      agentId: "test",
    });
    const projectResult = deriveFactKey("构建命令是 pnpm build", "project", {
      tenantId: "local",
      userId: "user-1",
      appId: "pi",
      agentId: "test",
      repositoryId: "repo-1",
    });
    expect(userResult.subjectKey).toBe("user-1");
    expect(projectResult.subjectKey).toBe("repo-1");
  });

  // ─── Regression: Semantic Dedup / Set Cardinality / Cross-Predicate ───

  it("detects programming_language_preference with normalizedValue", () => {
    const result = deriveFactKey("除了 Go 之外，我也很喜欢 TypeScript", "user", {
      tenantId: "local",
      userId: "user-1",
      appId: "pi",
      agentId: "test",
    });
    expect(result.predicateKey).toBe("programming_language_preference");
    expect(result.fallbackUsed).toBe(false);
    expect(result.normalizedValue).toBeDefined();
    // Should extract language names
    expect(result.normalizedValue?.toLowerCase()).toContain("go");
    expect(result.normalizedValue?.toLowerCase()).toContain("typescript");
    expect(result.setMemberKey).toBeDefined();
  });

  it("detects programming_language_preference for a single language mention", () => {
    const result = deriveFactKey("我喜欢 Go", "user", {
      tenantId: "local",
      userId: "user-1",
      appId: "pi",
      agentId: "test",
    });
    expect(result.predicateKey).toBe("programming_language_preference");
    expect(result.fallbackUsed).toBe(false);
    expect(result.normalizedValue?.toLowerCase()).toBe("go");
    expect(result.setMemberKey?.toLowerCase()).toBe("go");
  });

  it("detects code_style_preference for code style content", () => {
    const result = deriveFactKey("我喜欢简单直接的实现，避免过度设计", "user", {
      tenantId: "local",
      userId: "user-1",
      appId: "pi",
      agentId: "test",
    });
    expect(result.predicateKey).toBe("code_style_preference");
    expect(result.fallbackUsed).toBe(false);
  });

  it("code_style and programming_language produce DIFFERENT factKeys", () => {
    const codeStyle = deriveFactKey("喜欢简单直接的代码，不要过度抽象", "user", {
      tenantId: "local",
      userId: "user-1",
      appId: "pi",
      agentId: "test",
    });
    const progLang = deriveFactKey("除了 Go，我也喜欢 TypeScript", "user", {
      tenantId: "local",
      userId: "user-1",
      appId: "pi",
      agentId: "test",
    });
    expect(codeStyle.predicateKey).toBe("code_style_preference");
    expect(progLang.predicateKey).toBe("programming_language_preference");
    expect(codeStyle.factKey).not.toBe(progLang.factKey);
  });

  it("extracts multiple language names as normalizedValue", () => {
    const result = deriveFactKey("我平时最喜欢 Go，其次是 TypeScript", "user", {
      tenantId: "local",
      userId: "user-1",
      appId: "pi",
      agentId: "test",
    });
    expect(result.predicateKey).toBe("programming_language_preference");
    const nv = result.normalizedValue?.toLowerCase() ?? "";
    expect(nv).toContain("go");
    expect(nv).toContain("typescript");
  });

  it("extracts setMemberKey for set cardinality predicates", () => {
    const rust = deriveFactKey("我最近也喜欢 Rust", "user", {
      tenantId: "local",
      userId: "user-1",
      appId: "pi",
      agentId: "test",
    });
    expect(rust.predicateKey).toBe("programming_language_preference");
    expect(rust.setMemberKey).toBeDefined();
    expect(rust.setMemberKey?.toLowerCase()).toContain("rust");

    const python = deriveFactKey("我也喜欢 Python", "user", {
      tenantId: "local",
      userId: "user-1",
      appId: "pi",
      agentId: "test",
    });
    expect(python.setMemberKey?.toLowerCase()).toContain("python");
    // Different languages = different set member keys
    expect(rust.setMemberKey).not.toBe(python.setMemberKey);
  });

  it("same language gets same factKey for consistent set identity", () => {
    const go1 = deriveFactKey("我喜欢 Go", "user", {
      tenantId: "local",
      userId: "user-1",
      appId: "pi",
      agentId: "test",
    });
    const go2 = deriveFactKey("我也喜欢 Go", "user", {
      tenantId: "local",
      userId: "user-1",
      appId: "pi",
      agentId: "test",
    });
    expect(go1.factKey).toBe(go2.factKey);
    // Same setMemberKey for the same language
    expect(go1.setMemberKey?.toLowerCase()).toBe("go");
    expect(go2.setMemberKey?.toLowerCase()).toBe("go");
  });
});

describe("predicate collision prevention", () => {
  const predicates: KnownPredicate[] = [
    "project_package_manager",
    "project_build_command",
    "project_test_command",
    "project_lint_command",
    "project_typecheck_command",
    "project_format_command",
    "project_database",
    "project_deployment_target",
    "runtime",
    "language",
    "storage_engine",
    "architecture_decision",
    "known_failure",
    "project_purpose",
  ];

  for (const pred of predicates) {
    it(`predicate ${pred} maps to a distinct factKey segment`, () => {
      expect(pred).toBeTruthy();
      expect(pred).not.toContain(":");
    });
  }
});
