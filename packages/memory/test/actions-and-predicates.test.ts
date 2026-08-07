/**
 * Comprehensive tests for domain classification, scope resolution,
 * and secret detection. Action/predicate/cardinality semantics are covered
 * by commit-semantics.test.ts and scope-semantics.test.ts.
 */

import { describe, it, expect } from "vitest";
import { classifyDomain, resolveScope } from "../src/commit-planner.js";
import { shouldReject, detectSecrets } from "../src/secret-detector.js";

// ─── Domain Classification Tests ──────────────────────────────────

describe("domain classification", () => {
  it("fact type defaults to user domain (never topic)", () => {
    const result = classifyDomain("Go is a great language", "fact");
    expect(result.domain).toBe("user");
  });

  it("preference type defaults to user domain", () => {
    const result = classifyDomain("I prefer dark mode", "preference");
    expect(result.domain).toBe("user");
  });

  it("episodic type maps to episodic domain", () => {
    const result = classifyDomain("Build failed with 3 errors", "episodic");
    expect(result.domain).toBe("episodic");
  });
});

// ─── Scope Tests ───────────────────────────────────────────────────

describe("scope resolution", () => {
  it("user signal → user scope", () => {
    const scope = resolveScope("user", "我叫小明", "fact", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
    });
    expect(scope.scope.kind).toBe("user");
  });

  it("project fact in repo → repository scope", () => {
    const scope = resolveScope("project", "构建命令是 pnpm build", "fact", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
      repositoryId: "repo-1",
    });
    expect(scope.scope.kind).toBe("repository");
    expect(scope.scope.id).toBe("repo-1");
  });

  it("project fact without repo → user scope (NOT unknown-project)", () => {
    const scope = resolveScope("project", "需要 pnpm", "fact", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
    });
    expect(scope.scope.kind).toBe("user");
    expect(scope.scope.id).not.toBe("unknown-project");
    expect(scope.scope.id).toBe("u1");
  });

  it("different repos get different scopes", () => {
    const scopeA = resolveScope("project", "fact", "fact", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
      repositoryId: "repo-a",
    });
    const scopeB = resolveScope("project", "fact", "fact", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
      repositoryId: "repo-b",
    });
    expect(scopeA.scope.id).toBe("repo-a");
    expect(scopeB.scope.id).toBe("repo-b");
    expect(scopeA.scope.id).not.toBe(scopeB.scope.id);
  });
});

// ─── Secret Detector Tests ────────────────────────────────────────

describe("secret detector", () => {
  it("benign: MENTIS_CASE_20260806_a1b2c3d4 is NOT rejected", () => {
    expect(shouldReject("MENTIS_CASE_20260806_a1b2c3d4")).toBe(false);
  });

  it("benign: MENTIS_NATURAL_20260805154347_f7b68251 is NOT rejected", () => {
    expect(shouldReject("MENTIS_NATURAL_20260805154347_f7b68251")).toBe(false);
  });

  it("benign: TRACE_20260805_deadbeef is NOT rejected", () => {
    expect(shouldReject("TRACE_20260805_deadbeef")).toBe(false);
  });

  it("benign: BUILD_FAIL_20260805_a1b2c3d4 is NOT rejected", () => {
    expect(shouldReject("BUILD_FAIL_20260805_a1b2c3d4")).toBe(false);
  });

  it("benign: CASE_PROJECT_A_001 is NOT rejected", () => {
    expect(shouldReject("CASE_PROJECT_A_001")).toBe(false);
  });

  it("real token: OpenAI sk- prefix IS rejected", () => {
    expect(shouldReject("sk-proj-abc123def456ghi789jkl012mno345pqr678stu")).toBe(true);
  });

  it("real token: GitHub ghp_ prefix IS rejected", () => {
    expect(shouldReject("ghp_abcdefghijklmnopqrstuvwxyz1234567890")).toBe(true);
  });

  it("real token: Bearer token IS detected as sensitive", () => {
    const result = detectSecrets(
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0u3EE9QnM3",
    );
    expect(result.sensitive).toBe(true);
  });

  it("benign identifier has low confidence", () => {
    const result = detectSecrets("MENTIS_CASE_20260806_a1b2c3d4");
    expect(result.sensitive).toBe(false);
  });

  it("mixed: benign identifier in description with name", () => {
    const result = detectSecrets("以后叫你 MENTIS_CASE_20260806_a1b2c3d4-小明");
    expect(result.sensitive).toBe(false);
  });

  it("real token is sensitive with high confidence", () => {
    const result = detectSecrets("sk-proj-abc123def456ghi789jkl012mno345pqr678stu");
    expect(result.sensitive).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });
});

// ─── Predicate-Cardinality Mapping Tests ──────────────────────────
