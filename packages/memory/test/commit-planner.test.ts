import { describe, it, expect } from "vitest";

import { classifyDomain, resolveScope, planCommit } from "../src/commit-planner.js";

describe("classifyDomain", () => {
  it("classifies preference as user domain by default", () => {
    const result = classifyDomain("I prefer dark mode", "preference");
    expect(result.domain).toBe("user");
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("classifies global preference as user domain even in repo context", () => {
    const result = classifyDomain(
      "I prefer short answers, this is a global preference not just this project",
      "preference",
      { tenantId: "local", userId: "u1", appId: "pi", agentId: "test", repositoryId: "my-repo" },
    );
    expect(result.domain).toBe("user");
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("classifies project-scoped preference as project domain", () => {
    const result = classifyDomain("this project should use tabs for indentation", "preference", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
      repositoryId: "my-repo",
    });
    expect(result.domain).toBe("project");
  });

  it("classifies build-related fact as environment domain", () => {
    const result = classifyDomain("The project uses Node.js 22.14.0 with pnpm@10.20.0", "fact", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
      repositoryId: "my-repo",
    });
    expect(result.domain).toBe("environment");
  });

  it("classifies episodic as episodic domain", () => {
    const result = classifyDomain("Build failed with 3 errors", "episodic");
    expect(result.domain).toBe("episodic");
  });

  it("classifies task as task domain", () => {
    const result = classifyDomain("Implement auth module", "task");
    expect(result.domain).toBe("task");
  });

  it("classifies procedural as procedure domain", () => {
    const result = classifyDomain("Run npm test before pushing", "procedural");
    expect(result.domain).toBe("procedure");
  });
});

describe("resolveScope", () => {
  it("resolves user domain to user scope", () => {
    const result = resolveScope("user", "test", "preference", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
    });
    expect(result.scope.kind).toBe("user");
  });

  it("resolves project domain to repository scope when repoId is present", () => {
    const result = resolveScope("project", "test", "fact", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
      repositoryId: "my-repo",
    });
    expect(result.scope.kind).toBe("repository");
    expect(result.scope.id).toBe("my-repo");
  });

  it("resolves environment domain to repository scope", () => {
    const result = resolveScope("environment", "test", "fact", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
      repositoryId: "my-repo",
    });
    expect(result.scope.kind).toBe("repository");
  });

  it("falls back to user scope when no project/repo context", () => {
    const result = resolveScope("project", "test", "fact", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
    });
    expect(result.scope.kind).toBe("user");
  });

  it("resolves task domain to task scope", () => {
    const result = resolveScope("task", "test", "task", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
      taskId: "task-123",
    });
    expect(result.scope.kind).toBe("task");
    expect(result.scope.id).toBe("task-123");
  });
});

describe("planCommit", () => {
  it("plans user preference in repo → user scope", () => {
    const plan = planCommit("I prefer short answers, globally", "preference", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
      repositoryId: "my-repo",
    });
    expect(plan.domain).toBe("user");
    expect(plan.scope.kind).toBe("user");
  });

  it("plans build command → project domain, repository scope", () => {
    const plan = planCommit("Build command is pnpm build", "fact", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
      repositoryId: "my-repo",
    });
    // Build commands are project config facts, not environment facts
    expect(plan.domain).toBe("project");
    expect(plan.scope.kind).toBe("repository");
  });

  it("plans event → episodic domain", () => {
    const plan = planCommit("Build failed", "episodic");
    expect(plan.domain).toBe("episodic");
    expect(plan.cardinality).toBe("event");
  });

  it("plans preference without repo → user scope", () => {
    const plan = planCommit("I like dark mode", "preference", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
    });
    expect(plan.domain).toBe("user");
    expect(plan.scope.kind).toBe("user");
  });
});
