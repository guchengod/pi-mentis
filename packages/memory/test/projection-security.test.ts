/**
 * Tests for PublicMemoryResult projection, Secret lifecycle,
 * maintenance intent detection, and remote safety.
 */

import { describe, it, expect } from "vitest";
import {
  projectMemoryRecallHit,
  projectMemoryForPublicUse,
  shouldExcludeFromAutomaticRecall,
  sanitizeForLog,
} from "../src/projection.js";
import { classifySensitivity, toRemoteSafe } from "../src/secret-detector.js";
import { detectAccessIntent } from "../src/maintenance-intent.js";
import type { MemoryRecord, Sensitivity } from "../src/types.js";

// ─── Test record builder ──────────────────────────────────────────

function makeRecord(
  overrides: Partial<Omit<MemoryRecord, "embedding">> = {},
): Omit<MemoryRecord, "embedding"> {
  return {
    id: "mem-test-001",
    content: "test content",
    normalizedContent: "test content",
    contentHash: "abc12345",
    type: "fact",
    domain: "project",
    scope: { kind: "repository", id: "repo-1" },
    confidence: 0.8,
    importance: 0.5,
    authority: 80,
    evidenceRefs: [],
    supersedesIds: [],
    conflictsWithIds: [],
    status: "active",
    embeddingSpaceId: "space-1",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    observedAt: Date.now(),
    lastAccessedAt: Date.now(),
    reinforceCount: 0,
    revision: 1,
    ...overrides,
  };
}

// ─── Public Projection Tests ──────────────────────────────────────

describe("public memory projection", () => {
  it("preserves explicit procedure identity independently of repository scope", () => {
    const projected = projectMemoryRecallHit(
      {
        id: "procedure-memory",
        content: "Verified procedure",
        scope: { kind: "repository", id: "repo-1" },
        role: "procedure",
      },
      { match: "semantic" },
    );
    expect(projected?.hit.kind).toBe("procedure");
  });

  it("normal record is projected without sanitization", () => {
    const record = makeRecord({ content: "构建命令是 pnpm build", sensitivity: "public" });
    const result = projectMemoryForPublicUse(record, { currentUserId: "u1", crossScope: false });
    expect(result.sanitized).toBe(false);
    expect(result.sensitivity).toBe("public");
    expect(result.content).toBe("构建命令是 pnpm build");
  });

  it("sensitive record is redacted", () => {
    const record = makeRecord({
      content: "My API key is sk-proj-test12345678901234567890abcdef",
      sensitivity: "sensitive",
    });
    const result = projectMemoryForPublicUse(record, { currentUserId: "u1", crossScope: false });
    expect(result.sanitized).toBe(true);
    expect(result.content).not.toContain("sk-proj");
    expect(result.content).toContain("sk-****");
  });

  it("secret record returns safe summary only", () => {
    const record = makeRecord({
      id: "mem-secret-1",
      content: "GitHub token: ghp_abcdefghijklmnopqrstuvwxyz1234567890ab",
      sensitivity: "secret",
      factKey: "user:u1/api_key",
      contentHash: "deadbeef1234",
    });
    const result = projectMemoryForPublicUse(record, { currentUserId: "u1", crossScope: false });
    expect(result.sanitized).toBe(true);
    expect(result.sensitivity).toBe("secret");
    // Content must NOT contain the original token
    expect(result.content).not.toContain("ghp_");
    expect(result.content).not.toContain("abcdefghijklmnop");
    // Should have secret metadata
    expect(result.secretMetadata).toBeDefined();
    expect(result.secretMetadata?.safeFingerprint).toBeDefined();
    expect(result.secretMetadata?.category).toBeDefined();
  });

  it("secret with GitHub service is identified", () => {
    const record = makeRecord({
      content: "GitHub PAT for my repos",
      sensitivity: "secret",
      contentHash: "hash1234",
    });
    const result = projectMemoryForPublicUse(record, { currentUserId: "u1", crossScope: false });
    expect(result.secretMetadata?.service).toBe("github");
  });

  it("cross-scope record has crossScope flag", () => {
    const record = makeRecord({ sensitivity: "public" });
    const result = projectMemoryForPublicUse(record, {
      currentUserId: "u1",
      crossScope: true,
      sourceScopeKind: "repository",
      sourceScopeLabel: "project-other",
    });
    expect(result.crossScope).toBe(true);
    expect(result.sourceScopeKind).toBe("repository");
    expect(result.sourceScopeLabel).toBe("project-other");
  });
});

// ─── Auto-recall exclusion ───────────────────────────────────────

describe("automatic recall exclusion", () => {
  it("secret records are excluded from auto recall", () => {
    const record = makeRecord({ sensitivity: "secret" as Sensitivity });
    expect(shouldExcludeFromAutomaticRecall(record)).toBe(true);
  });

  it("public records are not excluded", () => {
    const record = makeRecord({ sensitivity: "public" as Sensitivity });
    expect(shouldExcludeFromAutomaticRecall(record)).toBe(false);
  });

  it("sensitive records are not excluded", () => {
    const record = makeRecord({ sensitivity: "sensitive" as Sensitivity });
    expect(shouldExcludeFromAutomaticRecall(record)).toBe(false);
  });
});

// ─── Log sanitization ─────────────────────────────────────────────

describe("log sanitization", () => {
  it("redacts API keys in log values", () => {
    expect(sanitizeForLog("My key: sk-proj-abc123def456ghi789")).toBe("My key: sk-****");
  });

  it("redacts GitHub tokens", () => {
    expect(sanitizeForLog("ghp_abcdefghijklmnopqrstuvwxyz1234567890")).toBe("ghp_****");
  });

  it("redacts Bearer tokens", () => {
    expect(sanitizeForLog("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9")).toBe(
      "Authorization: Bearer ****",
    );
  });

  it("passes through non-sensitive data", () => {
    expect(sanitizeForLog("构建命令是 pnpm build")).toBe("构建命令是 pnpm build");
  });

  it("handles non-string values", () => {
    expect(sanitizeForLog(42)).toBe(42);
    expect(sanitizeForLog(null)).toBe(null);
  });
});

// ─── Remote safety tests ──────────────────────────────────────────

describe("remote safety", () => {
  it("public content is allowed as-is", () => {
    const safe = toRemoteSafe("构建命令是 pnpm build");
    expect(safe.policy).toBe("allow");
    expect(safe.text).toBe("构建命令是 pnpm build");
    expect(safe.redacted).toBe(false);
  });

  it("keeps opaque run identifiers public unless they are credential-labeled", () => {
    const identifier = "CONTEXT_FOLD_20260810T103859352Z";
    const acceptanceIdentifier = "MENTIS_ACCEPTANCE_20260810T132223494Z_aaeee703";
    expect(classifySensitivity(`本会话标识为 ${identifier}`).sensitivity).toBe("public");
    expect(toRemoteSafe(`本会话标识为 ${identifier}`)).toMatchObject({
      policy: "allow",
      text: `本会话标识为 ${identifier}`,
      redacted: false,
    });
    expect(classifySensitivity(`API_KEY=${identifier}`).sensitivity).not.toBe("public");
    expect(
      classifySensitivity(`${acceptanceIdentifier} BUILD_ERROR src/index.ts:42`).sensitivity,
    ).toBe("public");
  });

  it("secret API key is local_only", () => {
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
});

// ─── Maintenance intent detection ─────────────────────────────────

describe("maintenance intent detection", () => {
  it('"诊断 Store" detects maintenance', () => {
    const result = detectAccessIntent("请诊断当前隔离测试环境中的 Pi Mentis Store");
    expect(result.intent).toBe("maintenance");
    expect(result.userExplicitlyRequestedMaintenance).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('"修复 artifact" detects maintenance', () => {
    const result = detectAccessIntent("修复 artifact 损坏");
    expect(result.intent).toBe("maintenance");
    expect(result.userExplicitlyRequestedMaintenance).toBe(true);
  });

  it('"备份记忆库" detects maintenance', () => {
    const result = detectAccessIntent("备份记忆库");
    expect(result.intent).toBe("maintenance");
    expect(result.userExplicitlyRequestedMaintenance).toBe(true);
  });

  it("ordinary retrieval does NOT trigger maintenance", () => {
    const result = detectAccessIntent("帮我看看这条记录");
    expect(result.intent).not.toBe("maintenance");
    expect(result.userExplicitlyRequestedMaintenance).toBe(false);
  });

  it("ID query with no maintenance phrase is explicit_id", () => {
    const result = detectAccessIntent("帮我看看 mem-abc123def4567890");
    expect(result.intent).toBe("explicit_id");
  });

  it("empty text is automatic_recall", () => {
    const result = detectAccessIntent("");
    expect(result.intent).toBe("automatic_recall");
  });
});
