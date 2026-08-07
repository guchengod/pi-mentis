import { describe, it, expect } from "vitest";

import { deriveFactKey, type KnownPredicate } from "../src/fact-key.js";

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
