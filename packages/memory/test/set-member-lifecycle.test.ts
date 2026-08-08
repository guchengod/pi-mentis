/**
 * Set Member Identity & Conflict Lifecycle — regression suite.
 *
 * Verifies the write-path redesign:
 *   - set member identity is decided BEFORE value relation;
 *   - temporal heads are member-level (`factKey/setMemberKey`);
 *   - Kotlin vs Elixir can never enter a same-value comparison;
 *   - legacy set records without a member key never block new members;
 *   - conflicted candidates have an automatic resolution path
 *     (activate when orphaned, remain on genuine ambiguity);
 *   - retract only affects the addressed member.
 *
 * One shared store keeps the suite fast.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EvidenceAuthority } from "@pi-mentis/pi-mentis-core";
import type {
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResponse,
} from "@pi-mentis/pi-mentis-inference";
import { ZvecStore } from "@pi-mentis/pi-mentis-zvec";

import {
  createMemoryService,
  deriveFactKeyNew,
  type CommitMemoryCommand,
  type MemoryRecord,
  type PiScopeContext,
  type TemporalHead,
} from "../src/index.js";

const DIM = 128;

function unitVector(seed: number): Float32Array {
  const vector = new Float32Array(DIM);
  let state = seed * 2654435761;
  let squared = 0;
  for (let index = 0; index < DIM; index++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const value = ((state / 0xffffffff) * 2 - 1) as number;
    vector[index] = value;
    squared += value * value;
  }
  const norm = Math.sqrt(squared);
  for (let index = 0; index < DIM; index++) vector[index] = (vector[index] ?? 0) / norm;
  return vector;
}

function withCosine(base: Float32Array, target: number, seed: number): Float32Array {
  const perpendicular = unitVector(seed);
  let dot = 0;
  for (let index = 0; index < DIM; index++) dot += (base[index] ?? 0) * (perpendicular[index] ?? 0);
  const component = new Float32Array(DIM);
  for (let index = 0; index < DIM; index++) {
    component[index] = (perpendicular[index] ?? 0) - dot * (base[index] ?? 0);
  }
  let squared = 0;
  for (const value of component) squared += value * value;
  const norm = Math.sqrt(squared) || 1;
  const result = new Float32Array(DIM);
  for (let index = 0; index < DIM; index++) {
    result[index] =
      target * (base[index] ?? 0) +
      Math.sqrt(Math.max(0, 1 - target * target)) * ((component[index] ?? 0) / norm);
  }
  return result;
}

class TestEmbeddingProvider implements EmbeddingProvider {
  readonly id = "set-lifecycle-test";
  async capabilities() {
    return { models: [] };
  }
  async health() {
    return { status: "healthy" as const, checkedAt: Date.now() };
  }
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    return {
      model: { providerId: this.id, modelId: "set-lifecycle-test", capabilityVersion: "1" },
      vectors: request.inputs.map(() => ({
        values: unitVector(1),
        dimensions: request.dimensions,
        normalized: true,
      })),
      usage: { inputTokens: request.inputs.reduce((sum, text) => sum + text.length, 0) },
    };
  }
}

let rootDir: string;
let store: ZvecStore;
let memory: ReturnType<typeof createMemoryService>;

const scopeContext: PiScopeContext = {
  tenantId: "local",
  userId: "u1",
  appId: "pi",
  agentId: "pi-mentis",
};

const GROUP_KEY = "user:u1/lang_set";

function memberKey(member: string): string {
  return `${GROUP_KEY}/${member}`;
}

function commitCommand(overrides: {
  readonly content: string;
  readonly embedding: Float32Array;
  readonly factKey?: string;
  readonly cardinality?: "single" | "set" | "ordered";
  readonly normalizedValue?: string;
  readonly setMemberKey?: string;
  readonly memberFactKey?: string;
  readonly retractsFact?: boolean;
}): CommitMemoryCommand {
  return {
    content: overrides.content,
    type: "fact",
    domain: "user",
    scope: { kind: "user", id: "u1" },
    scopeContext,
    confidence: 0.9,
    importance: 0.8,
    authority: EvidenceAuthority.VerifiedToolObservation,
    factKey: overrides.factKey ?? GROUP_KEY,
    cardinality: overrides.cardinality ?? "set",
    observedAt: Date.now(),
    contentOrigin: "user",
    embedding: { values: overrides.embedding, dimensions: DIM, normalized: true },
    polarity: "positive",
    ...(overrides.normalizedValue === undefined ? {} : { normalizedValue: overrides.normalizedValue }),
    ...(overrides.setMemberKey === undefined ? {} : { setMemberKey: overrides.setMemberKey }),
    ...(overrides.memberFactKey === undefined ? {} : { memberFactKey: overrides.memberFactKey }),
    ...(overrides.retractsFact === undefined ? {} : { retractsFact: overrides.retractsFact }),
  };
}

async function temporalHead(
  factKey: string,
): Promise<TemporalHead | undefined> {
  const svc = memory as unknown as {
    temporalHead: (
      factKey: string,
      scope: MemoryRecord["scope"],
      scopeContext?: PiScopeContext,
    ) => Promise<TemporalHead | undefined>;
  };
  return svc.temporalHead(factKey, { kind: "user", id: "u1" }, scopeContext);
}

function seed(language: string): number {
  let hash = 0;
  for (const char of language) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 10_000;
}

async function commitMember(
  language: string,
  content: string,
  embedding?: Float32Array,
): Promise<{ id: string; outcome: string }> {
  const result = await memory.commit(
    commitCommand({
      content,
      embedding: embedding ?? unitVector(seed(language) + 100),
      cardinality: "set",
      normalizedValue: language,
      setMemberKey: language,
    }),
  );
  return { id: result.record?.id as string, outcome: result.outcome };
}

async function searchText(text: string) {
  return memory.search(
    { text, limit: 10, scopeContext, scopes: [{ kind: "user", id: "u1" }] },
    { timeoutMs: 60_000 },
  );
}

interface MigrateResult {
  inspected: number;
  migrated: number;
  flagged: number;
  reheaded: number;
  errors: readonly string[];
}
interface ResolveResult {
  inspected: number;
  activated: number;
  remains: number;
  errors: readonly string[];
}
const svc = (): {
  migrateLegacySetRecords: () => Promise<MigrateResult>;
  resolveConflictedCandidates: () => Promise<ResolveResult>;
} => memory as unknown as never;

describe("set member identity (fact-key level)", () => {
  it("builds memberFactKey for set predicates", () => {
    const r = deriveFactKeyNew(
      "我喜欢 Kotlin",
      "user",
      { tenantId: "local", userId: "u1", appId: "pi", agentId: "test" },
      "programming_language_preference",
    );
    expect(r.factKey).toBe("user:u1/programming_language_preference");
    expect(r.memberFactKey).toBe("user:u1/programming_language_preference/kotlin");
    expect(r.setMemberKey).toBe("kotlin");
  });

  it("no memberFactKey for single facts or fallback keys", () => {
    const single = deriveFactKeyNew(
      "结论先行",
      "user",
      { tenantId: "local", userId: "u1", appId: "pi", agentId: "test" },
      "response_style" as never,
    );
    expect(single.memberFactKey).toBeUndefined();
    const fallback = deriveFactKeyNew("一条事实", "user", {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "test",
    });
    expect(fallback.memberFactKey).toBeUndefined();
  });

  it("different members produce different memberFactKeys on the same group key", () => {
    const ctx = { tenantId: "local", userId: "u1", appId: "pi", agentId: "test" };
    const go = deriveFactKeyNew("我喜欢 Go", "user", ctx, "programming_language_preference");
    const kotlin = deriveFactKeyNew(
      "我喜欢 Kotlin",
      "user",
      ctx,
      "programming_language_preference",
    );
    expect(go.memberFactKey).not.toBe(kotlin.memberFactKey);
    expect(go.factKey).toBe(kotlin.factKey);
  });
});

describe("set member lifecycle + legacy migration + conflict resolver", () => {
  beforeAll(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "pi-mentis-set-lifecycle-"));
    store = new ZvecStore({
      rootDir,
      readOnly: false,
      lockTimeoutMs: 500,
      generationRetentionMs: 60_000,
      writeBatch: { maxOperations: 256, maxBytes: 8 * 1024 * 1024, maxWaitMs: 5 },
    });
    await store.start({
      knowledge: { providerId: "test", modelId: "test", dimensions: DIM, normalization: "none", preprocessingVersion: "v1", inputKindVersion: "v1" },
      memory: { providerId: "test", modelId: "test", dimensions: DIM, normalization: "none", preprocessingVersion: "v1", inputKindVersion: "v1" },
      capability: { providerId: "test", modelId: "test", dimensions: DIM, normalization: "none", preprocessingVersion: "v1", inputKindVersion: "v1" },
    });
    memory = createMemoryService({
      store,
      embedding: new TestEmbeddingProvider(),
      embeddingSpace: { providerId: "test", modelId: "test", dimensions: DIM, normalization: "none", preprocessingVersion: "v1", inputKindVersion: "v1" },
      dimensions: DIM,
      viewsEnabled: false,
    });
  });

  afterAll(async () => {
    await memory.flushBackground?.();
    await store.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("Case A: Go/Kotlin/Elixir/Zig → 4 active members, distinct identities, no conflicts", async () => {
    const ids = new Map<string, string>();
    for (const language of ["go", "kotlin", "elixir", "zig"]) {
      const { id, outcome } = await commitMember(
        language,
        `用户喜欢的编程语言包括 ${language}。`,
      );
      expect(outcome).toBe("created");
      ids.set(language, id);
    }
    expect(new Set(ids.values()).size).toBe(4);

    for (const language of ["go", "kotlin", "elixir", "zig"]) {
      const stored = await memory.get(ids.get(language) as string, {
        scopeContext,
        accessIntent: "explicit_id",
      });
      expect(stored?.status).toBe("active");
      expect(stored?.memberFactKey).toBe(memberKey(language));
      expect(stored?.conflictsWithIds).toEqual([]);
      expect(stored?.supersedesIds).toEqual([]);
      const head = await temporalHead(memberKey(language));
      expect(head?.currentClaims.map((c) => c.memoryId)).toEqual([ids.get(language)]);
    }

    const groupHead = await temporalHead(GROUP_KEY);
    expect(groupHead?.currentClaims ?? []).toEqual([]);

    // Production recall (default status=active filter) returns all four.
    const search = await searchText("programming language preference");
    const found = search.hits.filter((h) => [...ids.values()].includes(h.id));
    expect(found.length).toBe(4);
    expect(search.diagnostics?.degraded).toEqual([]);
  }, 120_000);

  it("Case B: Kotlin paraphrase → reinforce the SAME Kotlin ID", async () => {
    const { id: firstId } = await commitMember("kotlin", "用户喜欢的编程语言包括 Kotlin。");
    const secondResult = await memory.commit(
      commitCommand({
        content: "我确实挺喜欢 Kotlin。",
        embedding: withCosine(unitVector(seed("kotlin") + 100), 0.95, seed("kotlin") + 500),
        cardinality: "set",
        normalizedValue: "kotlin",
        setMemberKey: "kotlin",
      }),
    );
    expect(secondResult.outcome).toBe("reinforced");
    expect(secondResult.record?.id).toBe(firstId);
    const stored = await memory.get(firstId, { scopeContext, accessIntent: "explicit_id" });
    expect(stored?.reinforceCount).toBeGreaterThanOrEqual(1);
    const kotlinHead = await temporalHead(memberKey("kotlin"));
    expect(kotlinHead?.currentClaims.map((c) => c.memoryId)).toEqual([firstId]);
  }, 120_000);

  it("Case C: retract Kotlin → only kotlin changes, Elixir/Zig untouched", async () => {
    const elixirId = (
      await commitMember("elixir", "用户喜欢的编程语言还包括 Elixir。")
    ).id;
    const zigId = (await commitMember("zig", "用户喜欢的编程语言还包括 Zig。")).id;
    const activeKotlin = (await searchText("kotlin")).hits.find((h) =>
      h.text.includes("Kotlin"),
    );

    const retractResult = await memory.commit(
      commitCommand({
        content: "Kotlin 现在不算我偏好的语言了。",
        embedding: unitVector(seed("kotlin") + 900),
        cardinality: "set",
        normalizedValue: "kotlin",
        setMemberKey: "kotlin",
        retractsFact: true,
      }),
    );
    expect(retractResult.record?.memberFactKey).toBe(memberKey("kotlin"));
    expect(retractResult.record?.status).toBe("tombstoned");

    const kotlinHead = await temporalHead(memberKey("kotlin"));
    expect(kotlinHead?.currentClaims ?? []).toEqual([]);

    if (activeKotlin !== undefined) {
      const oldKotlin = await memory.get(activeKotlin.id, {
        scopeContext,
        accessIntent: "explicit_id",
      });
      expect(oldKotlin?.status).toBe("tombstoned");
      expect(oldKotlin?.temporalState).toBe("retracted");
    }

    const elixir = await memory.get(elixirId, { scopeContext, accessIntent: "explicit_id" });
    const zig = await memory.get(zigId, { scopeContext, accessIntent: "explicit_id" });
    expect(elixir?.status).toBe("active");
    expect(elixir?.conflictsWithIds).toEqual([]);
    expect(zig?.status).toBe("active");
    expect((await temporalHead(memberKey("elixir")))?.currentClaims.length).toBe(1);
    expect((await temporalHead(memberKey("zig")))?.currentClaims.length).toBe(1);

    // Kotlin is gone from default (status=active) recall.
    const after = await searchText("kotlin");
    expect(after.hits.some((h) => h.text.includes("Kotlin"))).toBe(false);
  }, 120_000);

  it("Case D: re-liking Kotlin creates a fresh Kotlin member; others unchanged", async () => {
    const elixirId = (
      await commitMember("elixir", "用户喜欢的编程语言还包括 Elixir。")
    ).id;
    const { id: kotlinId, outcome } = await commitMember(
      "kotlin",
      "用户重新把 Kotlin 加回编程语言偏好。",
    );
    expect(outcome).toBe("created");
    const kotlinHead = await temporalHead(memberKey("kotlin"));
    expect(kotlinHead?.currentClaims.map((c) => c.memoryId)).toEqual([kotlinId]);
    const elixir = await memory.get(elixirId, { scopeContext, accessIntent: "explicit_id" });
    expect(elixir?.status).toBe("active");
  }, 120_000);

  it("Case E: legacy unkeyed set record never blocks a new member", async () => {
    const legacyResult = await memory.commit(
      commitCommand({ content: "用户喜欢的编程语言风格是简洁直接。", embedding: unitVector(1), cardinality: "set" }),
    );
    expect(legacyResult.outcome).toBe("created");
    expect(legacyResult.record?.status).toBe("active");
    expect(legacyResult.record?.legacyMalformed).toBe(true);

    const { id: swiftId, outcome } = await commitMember(
      "swift",
      "用户喜欢的编程语言还包括 Swift。",
    );
    expect(outcome).toBe("created");
    const swift = await memory.get(swiftId, { scopeContext, accessIntent: "explicit_id" });
    expect(swift?.status).toBe("active");
    expect(swift?.memberFactKey).toBe(memberKey("swift"));
    expect(swift?.conflictsWithIds).toEqual([]);
  }, 120_000);

  it("migration flags legacy unkeyed records and moves their claim off the group head", async () => {
    const migrate = await svc().migrateLegacySetRecords();
    expect(migrate.flagged).toBeGreaterThanOrEqual(1);
    expect(migrate.reheaded).toBeGreaterThanOrEqual(1);

    // The group head no longer carries any claims.
    const groupHead = await temporalHead(GROUP_KEY);
    expect(groupHead?.currentClaims ?? []).toEqual([]);

    // A new member still creates cleanly after migration.
    const { id: rustId, outcome } = await commitMember("rust", "用户喜欢的编程语言还包括 Rust。");
    expect(outcome).toBe("created");
    const rust = await memory.get(rustId, { scopeContext, accessIntent: "explicit_id" });
    expect(rust?.status).toBe("active");
    expect(rust?.conflictsWithIds).toEqual([]);
  }, 120_000);

  it("resolver activates an orphaned conflicted candidate (no competing claim)", async () => {
    // Fabricate the pre-fix dead state: a conflicted set member with a
    // memberFactKey but NO claim on its member head and NO competing claim.
    const now = Date.now();
    const candidateId = "candidate-orphaned-1";
    await store.upsertVectors("memory", [
      {
        id: candidateId,
        kind: "memory",
        namespace: "local:local:pi:pi-mentis::user:u1",
        status: "conflicted",
        payload: {
          id: candidateId,
          content: "用户喜欢的编程语言包括 Clojure。",
          normalizedContent: "用户喜欢的编程语言包括 clojure。",
          contentHash: "orphaned-candidate-hash",
          type: "preference",
          domain: "user",
          scope: { kind: "user", id: "u1" },
          scopeContext,
          ownership: { tenantId: "local", userId: "u1", appId: "pi", agentId: "pi-mentis" },
          sensitivity: "none",
          confidence: 0.9,
          importance: 0.8,
          authority: EvidenceAuthority.VerifiedToolObservation,
          evidenceRefs: [],
          supersedesIds: [],
          conflictsWithIds: ["legacy-record"],
          status: "conflicted",
          temporalState: "conflicted",
          embeddingSpaceId: "test",
          createdAt: now,
          updatedAt: now,
          observedAt: now,
          validFrom: now,
          lastAccessedAt: now,
          reinforceCount: 0,
          revision: 1,
          factKey: GROUP_KEY,
          cardinality: "set",
          normalizedValue: "clojure",
          setMemberKey: "clojure",
          memberFactKey: memberKey("clojure"),
        },
        searchableText: "用户喜欢的编程语言包括 Clojure。",
        contentHash: "orphaned-candidate-hash",
        sourceId: "local:local:pi:pi-mentis::user:u1",
        documentId: candidateId,
        authority: EvidenceAuthority.VerifiedToolObservation,
        tokenCount: 24,
        revision: 1,
        embedding: unitVector(777),
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const resolve = await svc().resolveConflictedCandidates();
    expect(resolve.activated).toBeGreaterThanOrEqual(1);

    const stored = await memory.get(candidateId, { scopeContext, accessIntent: "explicit_id" });
    expect(stored?.status).toBe("active");
    expect(stored?.conflictsWithIds).toEqual([]);
    expect(stored?.conflictResolution?.action).toBe("activated");
    const head = await temporalHead(memberKey("clojure"));
    expect(head?.currentClaims.map((c) => c.memoryId)).toContain(candidateId);
  }, 120_000);

  it("resolver keeps a genuine same-member ambiguity conflicted", async () => {
    const first = await memory.commit(
      commitCommand({ content: "用户喜欢方案 X。", embedding: unitVector(101), cardinality: "set", setMemberKey: "perl" }),
    );
    const firstId = first.record?.id as string;
    const second = await memory.commit(
      commitCommand({ content: "用户喜欢方案 Y。", embedding: withCosine(unitVector(101), 0.7, 102), cardinality: "set", setMemberKey: "perl" }),
    );
    expect(second.outcome).toBe("conflict");
    expect(second.record?.status).toBe("conflicted");
    expect(second.record?.conflictsWithIds).toContain(firstId);

    const resolve = await svc().resolveConflictedCandidates();
    expect(resolve.remains).toBeGreaterThanOrEqual(1);

    const stored = await memory.get(second.record?.id as string, {
      scopeContext,
      accessIntent: "explicit_id",
    });
    expect(stored?.status).toBe("conflicted");
    const incumbent = await memory.get(firstId, { scopeContext, accessIntent: "explicit_id" });
    expect(incumbent?.status).toBe("active");
  }, 120_000);
});
