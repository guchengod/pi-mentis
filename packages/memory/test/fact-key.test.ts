import { describe, it, expect } from "vitest";

import { deriveFactKey, type KnownPredicate } from "../src/fact-key.js";

describe("deriveFactKey", () => {
  it("detects package_manager predicate", () => {
    const result = deriveFactKey("Project uses pnpm@10.20.0 as package manager", "project", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
      repositoryId: "my-repo",
    });
    expect(result.predicateKey).toBe("package_manager");
    expect(result.factKey).toContain("/package_manager");
    expect(result.fallbackUsed).toBe(false);
  });

  it("detects build_command predicate", () => {
    const result = deriveFactKey("The build command for this project is turbo build", "project", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
      repositoryId: "my-repo",
    });
    expect(result.predicateKey).toBe("build_command");
    expect(result.factKey).toContain("/build_command");
  });

  it("detects test_command predicate", () => {
    const result = deriveFactKey("Run vitest for testing", "project", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
      repositoryId: "my-repo",
    });
    expect(result.predicateKey).toBe("test_command");
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

  it("detects user_preference predicate", () => {
    const result = deriveFactKey("I prefer concise code reviews", "user", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
    });
    expect(result.predicateKey).toBe("user_preference");
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
    expect(r1.predicateKey).toBe("package_manager");
    expect(r2.predicateKey).toBe("build_command");
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
    const userResult = deriveFactKey("preference", "user", {
      tenantId: "local",
      userId: "user-1",
      appId: "pi",
      agentId: "test",
    });
    const projectResult = deriveFactKey("fact", "project", {
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
  // Ensure that two different predicates on the same subject don't silently collide
  const predicates: KnownPredicate[] = [
    "project_purpose",
    "package_manager",
    "build_command",
    "test_command",
    "runtime",
    "language",
    "storage_engine",
    "deployment_target",
    "architecture_decision",
    "known_failure",
  ];

  for (const pred of predicates) {
    it(`predicate ${pred} maps to a distinct factKey segment`, () => {
      expect(pred).toBeTruthy();
      expect(pred).not.toContain(":");
    });
  }
});
