/**
 * Set Recall Completeness — diversity selection must never treat distinct
 * set members (same predicate group, different setMemberKey) as semantic
 * duplicates. Structural fact identity wins over embedding/text similarity.
 */

import { describe, expect, it } from "vitest";

import { EvidenceAuthority, type SearchHit } from "@pi-mentis/pi-mentis-core";
import type {
  MemoryQuery,
  MemoryRecord,
  MemoryService,
  PiScopeContext,
} from "@pi-mentis/pi-mentis-memory-core";

import {
  adaptiveCutoff,
  DefaultRecallCoordinator,
  createRetrievalService,
  maximalMarginalRelevance,
  maximalMarginalRelevanceWithTrace,
  memoryStructuralIdentity,
  structuralDedupe,
  structuralRelation,
  type DiversityTraceEntry,
  type MemoryStructuralIdentity,
} from "../src/index.js";
import type { RecallExecutionContext } from "../src/recall-coordinator.js";
import type { RetrievalService } from "../src/service.js";

// ─── Fixtures ─────────────────────────────────────────────────────

const GROUP_KEY = "user:u1/lang_set";
const member = (m: string): string => `${GROUP_KEY}/${m}`;

function memoryHit(
  id: string,
  content: string,
  score: number,
  identity: Partial<MemoryStructuralIdentity>,
): SearchHit {
  return {
    id,
    kind: "memory",
    text: content,
    score,
    tokenCount: Math.ceil(content.length / 4),
    authority: EvidenceAuthority.UserCurrentInstruction,
    namespace: "local:local:pi:pi-mentis::user:u1",
    contentHash: id,
    metadata: {
      factKey: GROUP_KEY,
      cardinality: "set",
      ...identity,
    },
  };
}

const KOTLIN = memoryHit("kotlin", "用户喜欢的编程语言包括 Kotlin。", 1.0, {
  memberFactKey: member("kotlin"),
  setMemberKey: "kotlin",
});
const ELIXIR = memoryHit("elixir", "用户喜欢的编程语言还包括 Elixir。", 0.9, {
  memberFactKey: member("elixir"),
  setMemberKey: "elixir",
});
const ZIG = memoryHit("zig", "用户喜欢的编程语言还包括 Zig。", 0.8, {
  memberFactKey: member("zig"),
  setMemberKey: "zig",
});
const UNRELATED = memoryHit(
  "unrelated",
  "我把自己的本地实验区取名为玄青用于性能基准测试。",
  0.79,
  { factKey: "user:u1/experiment_subject", cardinality: "single" },
);

// ─── Structural identity ──────────────────────────────────────────

describe("structural identity (memoryStructuralIdentity / structuralRelation)", () => {
  it("extracts identity from metadata — never from natural language", () => {
    const identity = memoryStructuralIdentity(KOTLIN);
    expect(identity.predicate).toBe("lang_set");
    expect(identity.cardinality).toBe("set");
    expect(identity.memberFactKey).toBe(member("kotlin"));
    expect(identity.setMemberKey).toBe("kotlin");
  });

  it("same memberFactKey → same_member (duplicate / version)", () => {
    const old = memoryHit("kotlin-old", "用户喜欢 Kotlin。", 0.5, {
      memberFactKey: member("kotlin"),
      setMemberKey: "kotlin",
    });
    expect(structuralRelation(memoryStructuralIdentity(KOTLIN), memoryStructuralIdentity(old))).toBe(
      "same_member",
    );
  });

  it("same set group, different member → set_sibling", () => {
    expect(
      structuralRelation(memoryStructuralIdentity(KOTLIN), memoryStructuralIdentity(ELIXIR)),
    ).toBe("set_sibling");
    expect(
      structuralRelation(memoryStructuralIdentity(KOTLIN), memoryStructuralIdentity(ZIG)),
    ).toBe("set_sibling");
  });

  it("different predicates / non-set facts → unrelated", () => {
    expect(
      structuralRelation(memoryStructuralIdentity(KOTLIN), memoryStructuralIdentity(UNRELATED)),
    ).toBe("unrelated");
  });

  it("different sets (language vs database) are NOT aggregated", () => {
    const postgres = memoryHit("pg", "我常用的数据库是 PostgreSQL。", 0.9, {
      factKey: "user:u1/database_preference",
      memberFactKey: "user:u1/database_preference/postgresql",
      setMemberKey: "postgresql",
    });
    expect(structuralRelation(memoryStructuralIdentity(KOTLIN), memoryStructuralIdentity(postgres))).toBe(
      "unrelated",
    );
  });

  it("legacy unkeyed record vs keyed member of the same group → set_sibling, never duplicate", () => {
    const legacy = memoryHit("legacy", "用户喜欢的编程语言风格是简洁直接。", 0.6, {
      factKey: GROUP_KEY,
      cardinality: "set",
    });
    expect(structuralRelation(memoryStructuralIdentity(legacy), memoryStructuralIdentity(KOTLIN))).toBe(
      "set_sibling",
    );
  });
});

// ─── Structural dedup ─────────────────────────────────────────────

describe("structuralDedupe", () => {
  it("collapses same-member versions to the best-scoring current one", () => {
    const oldKotlin = memoryHit("kotlin-old", "用户喜欢 Kotlin。", 0.5, {
      memberFactKey: member("kotlin"),
      setMemberKey: "kotlin",
    });
    const deduped = structuralDedupe([KOTLIN, oldKotlin, ELIXIR, ZIG]);
    const kotlinIds = deduped.filter((h) =>
      memoryStructuralIdentity(h).memberFactKey === member("kotlin"),
    );
    expect(kotlinIds).toHaveLength(1);
    expect(kotlinIds[0]?.id).toBe("kotlin");
  });

  it("keeps every distinct set sibling", () => {
    const deduped = structuralDedupe([KOTLIN, ELIXIR, ZIG]);
    expect(deduped.map((h) => h.id).sort()).toEqual(["elixir", "kotlin", "zig"]);
  });

  it("keeps unidentifiable (knowledge/fallback) hits individually", () => {
    const knowledge = { ...UNRELATED, kind: "knowledge" as const };
    const deduped = structuralDedupe([KOTLIN, knowledge]);
    expect(deduped.map((h) => h.id).sort()).toEqual(["kotlin", "unrelated"]);
  });
});

// ─── Set-aware MMR ────────────────────────────────────────────────

describe("maximalMarginalRelevanceWithTrace (set completeness)", () => {
  const inputs = [KOTLIN, ELIXIR, ZIG, UNRELATED];

  it("ordinary MMR drops the third sibling (reproduces the live bug)", () => {
    const ordinary = maximalMarginalRelevance(inputs, 3, 0.75);
    expect(ordinary.map((h) => h.id)).not.toContain("zig");
  });

  it("set-aware MMR preserves all three siblings", () => {
    const selected = maximalMarginalRelevanceWithTrace(inputs, 3, 0.75);
    expect(selected.map((h) => h.id)).toEqual(["kotlin", "elixir", "zig"]);
  });

  it("traces explain exactly why zig is preserved / unrelated dropped", () => {
    const trace: DiversityTraceEntry[] = [];
    maximalMarginalRelevanceWithTrace(inputs, 3, 0.75, { onTrace: (e) => trace.push(e) });

    const zig = trace.find((e) => e.candidateId === "zig");
    expect(zig?.structuralRelation).toBe("set_sibling");
    expect(zig?.pairwiseSimilarity).toBeGreaterThan(0.2);
    expect(zig?.mmrPenalty).toBe(0);
    expect(zig?.preservedBySetCompleteness).toBe(true);
    expect(zig?.selected).toBe(true);
    expect(zig?.setMemberKey).toBe("zig");
    expect(zig?.memberFactKey).toBe(member("zig"));

    const unrelated = trace.find((e) => e.candidateId === "unrelated");
    expect(unrelated?.structuralRelation).toBe("unrelated");
    expect(unrelated?.selected).toBe(false);
    expect(unrelated?.dropReason).toBe("diversity_limit");
  });

  it("ordinary candidates still receive the normal similarity penalty", () => {
    const a = memoryHit("a", "用户部署经验 使用固定版本回滚", 1.0, {
      factKey: "user:u1/deploy_exp",
      cardinality: "single",
    });
    const b = memoryHit("b", "用户部署经验 采用固定版本回滚", 0.98, {
      factKey: "user:u1/deploy_exp",
      cardinality: "single",
    });
    const c = memoryHit("c", "用户部署经验 固定版本回滚 方案", 0.97, {
      factKey: "user:u1/deploy_exp",
      cardinality: "single",
    });
    const trace: DiversityTraceEntry[] = [];
    const selected = maximalMarginalRelevanceWithTrace([a, b, c], 2, 0.75, {
      onTrace: (e) => trace.push(e),
    });
    // Paraphrases of the SAME fact still get penalized — not all fit.
    expect(selected).toHaveLength(2);
    const laterParaphrase = trace.find((e) => e.candidateId === "c");
    expect(laterParaphrase?.structuralRelation).toBe("same_member");
    expect(laterParaphrase?.mmrPenalty).toBeGreaterThan(0);
    expect(laterParaphrase?.preservedBySetCompleteness).toBe(false);
  });
});

// ─── Adaptive cutoff must not remove siblings ─────────────────────

describe("adaptiveCutoff with set records", () => {
  it("keeps all three high-relevance siblings", () => {
    const kept = adaptiveCutoff({
      hits: [KOTLIN, ELIXIR, ZIG],
      mode: "broad",
    });
    expect(kept.map((h) => h.id).sort()).toEqual(["elixir", "kotlin", "zig"]);
  });

  it("still gates low-relevance members", () => {
    const low = memoryHit("low", "用户喜欢的编程语言包括 Rust。", 0.01, {
      memberFactKey: member("rust"),
      setMemberKey: "rust",
    });
    const kept = adaptiveCutoff({
      hits: [KOTLIN, low],
      mode: "broad",
    });
    expect(kept.map((h) => h.id)).toEqual(["kotlin"]);
  });
});

// ─── Service-level pipeline ───────────────────────────────────────

function makeSearchHit(record: Omit<MemoryRecord, "embedding">, index: number): SearchHit {
  return {
    id: record.id,
    kind: "memory",
    text: record.content,
    score: 1 - index * 0.1,
    tokenCount: Math.ceil(record.content.length / 4),
    authority: EvidenceAuthority.UserCurrentInstruction,
    namespace: `local:local:pi:pi-mentis::${record.scope.kind}:${record.scope.id}`,
    contentHash: record.contentHash,
    metadata: record as unknown as SearchHit["metadata"],
  };
}

function record(
  id: string,
  content: string,
  identity: {
    factKey?: string;
    cardinality?: string;
    memberFactKey?: string;
    setMemberKey?: string;
  },
): Omit<MemoryRecord, "embedding"> {
  return {
    id,
    content,
    normalizedContent: content,
    contentHash: id,
    type: "preference",
    domain: "user",
    scope: { kind: "user", id: "u1" },
    scopeContext: {
      tenantId: "local",
      userId: "u1",
      appId: "pi",
      agentId: "pi-mentis",
    },
    ownership: { tenantId: "local", userId: "u1", appId: "pi", agentId: "pi-mentis" },
    sensitivity: "public",
    confidence: 0.9,
    importance: 0.8,
    authority: EvidenceAuthority.UserCurrentInstruction,
    evidenceRefs: [],
    supersedesIds: [],
    conflictsWithIds: [],
    status: "active",
    embeddingSpaceId: "test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    observedAt: Date.now(),
    lastAccessedAt: Date.now(),
    reinforceCount: 0,
    revision: 1,
    factKey: identity.factKey,
    cardinality: identity.cardinality as MemoryRecord["cardinality"],
    memberFactKey: identity.memberFactKey,
    setMemberKey: identity.setMemberKey,
    temporalState: "current",
  };
}

function mockMemoryService(records: Omit<MemoryRecord, "embedding">[]): MemoryService {
  const svc = {
    async commit() {
      return { outcome: "created" as const, record: undefined, relatedIds: [] };
    },
    async get(id: string) {
      return records.find((r) => r.id === id);
    },
    async search(query: MemoryQuery) {
      const hits = records.map((r, index) => makeSearchHit(r, index));
      const hitIds = hits.map((h) => h.id);
      return {
        hits: hits.slice(0, query.limit ?? 20),
        diagnostics: {
          durationMs: 0,
          timedOut: false,
          degraded: [],
          stages: {},
          rankings: { rrf: hitIds, rerank: hitIds, mmr: hitIds },
        },
      };
    },
    async tombstone() {
      return false;
    },
    async markConflicted() {
      return undefined;
    },
  };
  return svc as unknown as MemoryService;
}

function mockRetrievalService(memory: MemoryService): RetrievalService {
  const svc = {
    async search(retrievalQuery: Parameters<RetrievalService["search"]>[0]) {
      const memoryResult = await memory.search({
        text: retrievalQuery.text,
        limit: retrievalQuery.limit ?? 20,
        ...(retrievalQuery.memoryScopes === undefined
          ? {}
          : { scopes: retrievalQuery.memoryScopes }),
        ...(retrievalQuery.memoryScopeContext === undefined
          ? {}
          : { scopeContext: retrievalQuery.memoryScopeContext }),
      });
      return {
        hits: memoryResult.hits,
        diagnostics: {
          durationMs: 1,
          timedOut: false,
          degraded: [],
          stages: {},
          rankings: {
            rrf: memoryResult.hits.map((h) => h.id),
            rerank: memoryResult.hits.map((h) => h.id),
            mmr: memoryResult.hits.map((h) => h.id),
          },
        },
      };
    },
  };
  return svc as unknown as RetrievalService;
}

const scopeContext: PiScopeContext = {
  tenantId: "local",
  userId: "u1",
  appId: "pi",
  agentId: "pi-mentis",
};

const LANGUAGE_RECORDS = [
  record("kotlin", "用户喜欢的编程语言包括 Kotlin。", {
    factKey: GROUP_KEY,
    cardinality: "set",
    memberFactKey: member("kotlin"),
    setMemberKey: "kotlin",
  }),
  record("elixir", "用户喜欢的编程语言还包括 Elixir。", {
    factKey: GROUP_KEY,
    cardinality: "set",
    memberFactKey: member("elixir"),
    setMemberKey: "elixir",
  }),
  record("zig", "用户喜欢的编程语言还包括 Zig。", {
    factKey: GROUP_KEY,
    cardinality: "set",
    memberFactKey: member("zig"),
    setMemberKey: "zig",
  }),
  record("unrelated", "我把自己的本地实验区取名为玄青用于性能基准测试。", {
    factKey: "user:u1/experiment_subject",
    cardinality: "single",
  }),
];

describe("service-level set completeness (DefaultRetrievalService)", () => {
  it("final hits keep all three set members", async () => {
    const memory = mockMemoryService(LANGUAGE_RECORDS);
    const retrieval = createRetrievalService({ memory, rerankModel: "none", rerankContextTokens: 0 });

    const result = await retrieval.search(
      {
        text: "我最近补充到编程语言偏好里的三种语言是什么？",
        limit: 3,
        sources: ["memory"],
        memoryScopes: [{ kind: "user", id: "u1" }],
        memoryScopeContext: scopeContext,
      },
      { allowRerank: false },
    );
    const ids = result.hits.map((h) => h.id);
    expect(ids).toContain("kotlin");
    expect(ids).toContain("elixir");
    expect(ids).toContain("zig");
    expect(result.hits).toHaveLength(3);

    const zig = result.diagnostics.diversity?.find((e) => e.candidateId === "zig");
    expect(zig?.structuralRelation).toBe("set_sibling");
    expect(zig?.preservedBySetCompleteness).toBe(true);
    expect(zig?.selected).toBe(true);
  }, 30_000);
});

describe("coordinator-level set completeness", () => {
  it("DefaultRecallCoordinator final hits contain all three members", async () => {
    const memory = mockMemoryService(LANGUAGE_RECORDS);
    const coordinator = new DefaultRecallCoordinator({
      getMemory: () => memory,
      getRetrieval: () => mockRetrievalService(memory),
      getEvidence: () => undefined,
    });

    const result = await coordinator.recall(
      { query: "我偏好的编程语言有哪些？" },
      { scopeContext } as RecallExecutionContext,
    );
    expect(result.found).toBe(true);
    const ids = result.hits.map((h) => h.id);
    expect(ids).toContain("kotlin");
    expect(ids).toContain("elixir");
    expect(ids).toContain("zig");
  }, 30_000);
});
