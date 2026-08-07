/**
 * Tests for the new Ownership/Relevance split, Personal security mode,
 * Sensitivity classification (classify-don't-destroy), and remote safety gates.
 */

import { describe, it, expect } from "vitest";
import { classifySensitivity, toRemoteSafe, detectSecrets } from "../src/secret-detector.js";
import type {
  ResourceOwnership,
  RelevanceScope,
  MentisSecurityMode,
  ResourceAccessIntent,
  Sensitivity,
} from "../src/types.js";

// ─── Ownership & Relevance Types ──────────────────────────────────

describe("ownership and relevance scope types", () => {
  it("ResourceOwnership has userId as required", () => {
    const ownership: ResourceOwnership = {
      userId: "u1",
      tenantId: undefined,
      appId: undefined,
      agentId: undefined,
    };
    expect(ownership.userId).toBe("u1");
    expect(ownership.tenantId).toBeUndefined();
  });

  it("global RelevanceScope has no id", () => {
    const scope: RelevanceScope = { kind: "global" };
    expect(scope.kind).toBe("global");
  });

  it("repository RelevanceScope has repositoryId", () => {
    const scope: RelevanceScope = { kind: "repository", repositoryId: "repo-1" };
    if (scope.kind === "repository") {
      expect(scope.repositoryId).toBe("repo-1");
    } else {
      expect.fail("expected repository kind");
    }
  });

  it("different RelevanceScope kinds are distinguishable", () => {
    const repo: RelevanceScope = { kind: "repository", repositoryId: "r1" };
    const proj: RelevanceScope = { kind: "project", projectId: "p1" };
    const task: RelevanceScope = { kind: "task", taskId: "t1" };
    expect(repo.kind).not.toBe(proj.kind);
    expect(proj.kind).not.toBe(task.kind);
    expect(task.kind).not.toBe(repo.kind);
  });
});

// ─── Security Mode Types ──────────────────────────────────────────

describe("security mode types", () => {
  it("personal mode is the default", () => {
    const mode: MentisSecurityMode = "personal";
    expect(mode).toBe("personal");
  });

  it("team and multi_tenant modes exist", () => {
    const modes: MentisSecurityMode[] = ["personal", "team", "multi_tenant"];
    expect(modes.length).toBe(3);
  });
});

// ─── Sensitivity Classification ───────────────────────────────────

describe("sensitivity classification", () => {
  it("benign: MENTIS_CASE_20260806_a1b2c3d4 is public", () => {
    const result = classifySensitivity("MENTIS_CASE_20260806_a1b2c3d4");
    expect(result.sensitivity).toBe("public");
    expect(result.confidence).toBe(0);
  });

  it("benign: normal text is public", () => {
    const result = classifySensitivity("这个项目的构建命令是 pnpm build");
    expect(result.sensitivity).toBe("public");
  });

  it("secret: OpenAI sk- key is secret", () => {
    const result = classifySensitivity("sk-proj-abc123def456ghi789jkl012mno345pqr678stu");
    expect(result.sensitivity).toBe("secret");
    expect(result.categories).toContain("api_key");
  });

  it("secret: GitHub ghp_ token is secret", () => {
    const result = classifySensitivity("ghp_abcdefghijklmnopqrstuvwxyz1234567890");
    expect(result.sensitivity).toBe("secret");
  });

  it("secret: private key PEM is secret", () => {
    const result = classifySensitivity("-----BEGIN RSA PRIVATE KEY-----");
    expect(result.sensitivity).toBe("secret");
    expect(result.categories).toContain("private_key");
  });

  it("sensitive: Bearer token with JWT is sensitive or secret", () => {
    const result = classifySensitivity(
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0u3EE9QnM3",
    );
    // Should detect the JWT
    expect(result.sensitivity).not.toBe("public");
    expect(result.categories.length).toBeGreaterThan(0);
  });

  it("public: user preference is public", () => {
    const result = classifySensitivity("我喜欢简洁的回答方式");
    expect(result.sensitivity).toBe("public");
  });
});

// ─── Remote Safe Content ──────────────────────────────────────────

describe("remote safe content", () => {
  it("public content is allowed through unmodified", () => {
    const safe = toRemoteSafe("这个项目的构建命令是 pnpm build");
    expect(safe.policy).toBe("allow");
    expect(safe.text).toBe("这个项目的构建命令是 pnpm build");
    expect(safe.redacted).toBe(false);
  });

  it("secret API key is local_only (not sent to remote)", () => {
    const safe = toRemoteSafe("sk-proj-abc123def456ghi789jkl012mno345pqr678stu");
    expect(safe.originalSensitivity).toBe("secret");
    expect(safe.policy).toBe("local_only");
    expect(safe.text).toBeUndefined();
    expect(safe.redacted).toBe(true);
  });

  it("private key is local_only", () => {
    const safe = toRemoteSafe("-----BEGIN RSA PRIVATE KEY-----");
    expect(safe.policy).toBe("local_only");
    expect(safe.text).toBeUndefined();
  });

  it("redact: sensitive content gets redacted", () => {
    // Use a confidence-0.75 authorization bearer which maps to "sensitive" => "redact"
    const safe = toRemoteSafe("My authorization: Bearer tok12345678901234567890");
    // Low-confidence enforcement maps to sensitive or below
    expect(safe.redacted).toBe(true);
  });
});

// ─── Benign Identifier Detection ──────────────────────────────────

describe("benign identifiers survive classification", () => {
  const benigns = [
    "MENTIS_NATURAL_20260805154347_f7b68251",
    "TRACE_20260805_deadbeef",
    "BUILD_FAIL_20260805_a1b2c3d4",
    "CASE_PROJECT_A_001",
  ];

  for (const benign of benigns) {
    it(`${benign} is public`, () => {
      const result = classifySensitivity(benign);
      expect(result.sensitivity).toBe("public");
    });
  }
});

// ─── Secret Detection (not destroyed) ─────────────────────────────

describe("secret detection preserves for local", () => {
  it("detectSecrets works for real tokens", () => {
    const result = detectSecrets("ghp_abcdefghijklmnopqrstuvwxyz1234567890");
    expect(result.sensitive).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("detectSecrets skips benign identifiers", () => {
    const result = detectSecrets("MENTIS_CASE_20260806_a1b2c3d4");
    expect(result.sensitive).toBe(false);
  });
});

// ─── Access Intent Types ──────────────────────────────────────────

describe("access intent types", () => {
  it("automatic_recall means system-initiated recall", () => {
    const intent: ResourceAccessIntent = "automatic_recall";
    expect(intent).toBe("automatic_recall");
  });

  it("explicit_id means user-provided ID", () => {
    const intent: ResourceAccessIntent = "explicit_id";
    expect(intent).toBe("explicit_id");
  });

  it("maintenance means user-requested diagnostics", () => {
    const intent: ResourceAccessIntent = "maintenance";
    expect(intent).toBe("maintenance");
  });
});
