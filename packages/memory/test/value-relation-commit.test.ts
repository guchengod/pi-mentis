/**
 * ValueRelation — service-level commit regression tests.
 *
 * Exercises the memory write path end-to-end with a real Zvec store:
 * same factKey + semantically equivalent value → reinforce (ID stable, no
 * temporal version), changed value → supersede, set member → coexist,
 * contradictory → conflict, unknown → conflicted candidate (no destructive
 * supersede).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EvidenceAuthority, type Clock } from "@pi-mentis/pi-mentis-core";
import type {
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResponse,
} from "@pi-mentis/pi-mentis-inference";
import { InMemoryTelemetry } from "@pi-mentis/pi-mentis-observability";
import { ZvecStore, decodeStoredPayload } from "@pi-mentis/pi-mentis-zvec";

import {
  createMemoryService,
  type CommitMemoryCommand,
  type MemoryScope,
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
  readonly id = "value-relation-test";
  async capabilities() {
    return { models: [] };
  }
  async health() {
    return { status: "healthy" as const, checkedAt: Date.now() };
  }
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    return {
      model: { providerId: this.id, modelId: "value-relation-test", capabilityVersion: "1" },
      vectors: request.inputs.map(() => ({
        values: unitVector(1),
        dimensions: request.dimensions,
        normalized: true,
      })),
      usage: { inputTokens: request.inputs.reduce((sum, text) => sum + text.length, 0) },
    };
  }
}

class FixedClock implements Clock {
  value = Date.UTC(2026, 0, 1);
  now(): number {
    return this.value;
  }
  advance(ms: number): void {
    this.value += ms;
  }
}

let rootDir: string;
let store: ZvecStore;
let memory: ReturnType<typeof createMemoryService>;
let telemetry: InMemoryTelemetry;
let clock: FixedClock;

async function temporalHead(
  factKey: string,
  scopeContextArg: PiScopeContext,
): Promise<TemporalHead | undefined> {
  const svc = memory as unknown as {
    temporalHead: (
      factKey: string,
      scope: MemoryScope,
      scopeContext?: PiScopeContext,
    ) => Promise<TemporalHead | undefined>;
  };
  return svc.temporalHead(factKey, { kind: "user", id: "user" }, scopeContextArg);
}

const scopeContext: PiScopeContext = {
  tenantId: "tenant",
  userId: "user",
  appId: "pi",
  agentId: "mentis",
};

function commitCommand(overrides: {
  readonly content: string;
  readonly embedding: Float32Array;
  readonly factKey: string;
  readonly polarity?: "positive" | "negative";
  readonly semanticIntent?: "create" | "reinforce" | "correct" | "replace" | "retract";
  readonly cardinality?: "single" | "set";
  readonly normalizedValue?: string;
  readonly observedAt?: number;
}): CommitMemoryCommand {
  return {
    content: overrides.content,
    type: "fact",
    domain: "user",
    scope: { kind: "user", id: "user" },
    scopeContext,
    confidence: 0.9,
    authority: EvidenceAuthority.VerifiedToolObservation,
    factKey: overrides.factKey,
    cardinality: overrides.cardinality ?? "single",
    observedAt: overrides.observedAt ?? clock.now(),
    contentOrigin: "user",
    embedding: { values: overrides.embedding, dimensions: DIM, normalized: true },
    polarity: overrides.polarity ?? "positive",
    ...(overrides.semanticIntent === undefined ? {} : { semanticIntent: overrides.semanticIntent }),
    ...(overrides.normalizedValue === undefined ? {} : { normalizedValue: overrides.normalizedValue }),
  };
}

beforeAll(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "pi-mentis-value-relation-"));
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
  telemetry = new InMemoryTelemetry();
  clock = new FixedClock();
  memory = createMemoryService({
    store,
    embedding: new TestEmbeddingProvider(),
    embeddingSpace: { providerId: "test", modelId: "test", dimensions: DIM, normalization: "none", preprocessingVersion: "v1", inputKindVersion: "v1" },
    dimensions: DIM,
    viewsEnabled: false,
    telemetry,
    clock,
  });
});

afterAll(async () => {
  await store.close();
  await rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("Same-fact / same-value reinforcement (service)", () => {
  it("REAL regression: paraphrase of the same preference → reinforced, ID stable, no supersede version", async () => {
    const first = commitCommand({
      content: "我个人给实验性分支起名字时，更喜欢使用天文相关的名称，不喜欢纯数字编号。",
      embedding: unitVector(101),
      factKey: "user:user/user_name",
    });
    const firstResult = await memory.commit(first);
    expect(firstResult.outcome).toBe("created");
    const firstId = firstResult.record?.id as string;

    clock.advance(60_000);
    const second = commitCommand({
      content: "我对实验分支的命名偏好是使用星体、星座等天文主题名称，避免单纯的数字名称。",
      embedding: withCosine(unitVector(101), 0.95, 202),
      factKey: "user:user/user_name",
    });
    const secondResult = await memory.commit(second);

    expect(secondResult.outcome).toBe("reinforced");
    expect(secondResult.record?.id).toBe(firstId);

    const stored = await memory.get(firstId, { scopeContext, accessIntent: "explicit_id" });
    expect(stored?.status).toBe("active");
    expect(stored?.supersededById).toBeUndefined();
    expect(stored?.content).toContain("天文");
    expect(stored?.reinforceCount).toBe(1);
    expect(stored?.lastReinforcedAt).toBeDefined();

    const head = await temporalHead("user:user/user_name", scopeContext);
    expect(head?.currentClaims.map((claim) => claim.memoryId)).toEqual([firstId]);
    expect(head?.state).toBe("resolved");

    const relations = await store.filterScalar("relationships_v1", "kind != ''", 1000);
    expect(
      relations.filter((r) => decodeStoredPayload(r).kind === "supersedes"),
    ).toHaveLength(0);

    const trace = telemetry
      .traces()
      .find((t) => t.name === "memory_value_relation" && t.attributes.existingId === firstId);
    expect(trace?.attributes.finalStorageAction).toBe("reinforce");
    expect(trace?.attributes.valueRelation).toBe("equivalent");
    expect(trace?.attributes.existingId).toBe(firstId);
  }, 30_000);

  it("Case C: same structured value in new wording → reinforced, ID stable", async () => {
    const first = commitCommand({
      content: "默认 shell 是 zsh。",
      embedding: unitVector(301),
      factKey: "user:user/shell_runtime",
    });
    const firstResult = await memory.commit(first);
    const firstId = firstResult.record?.id as string;

    clock.advance(60_000);
    const second = commitCommand({
      content: "我的默认 shell 使用 zsh。",
      embedding: withCosine(unitVector(301), 0.99, 302),
      factKey: "user:user/shell_runtime",
    });
    const secondResult = await memory.commit(second);
    expect(secondResult.outcome).toBe("reinforced");
    expect(secondResult.record?.id).toBe(firstId);
  }, 30_000);

  it("Case D: shell changed zsh → fish → superseded (structured value wins over wording similarity)", async () => {
    const first = commitCommand({
      content: "默认 shell 是 zsh。",
      embedding: unitVector(401),
      factKey: "user:user/shell_runtime",
    });
    const firstResult = await memory.commit(first);
    const firstId = firstResult.record?.id as string;

    clock.advance(60_000);
    const second = commitCommand({
      content: "默认 shell 现在是 fish。",
      embedding: withCosine(unitVector(401), 0.99, 402),
      factKey: "user:user/shell_runtime",
    });
    const secondResult = await memory.commit(second);
    expect(secondResult.outcome).toBe("superseded");
    expect(secondResult.record?.id).not.toBe(firstId);

    const oldRecord = await memory.get(firstId, { scopeContext, accessIntent: "explicit_id" });
    expect(oldRecord?.status).toBe("superseded");
    expect(oldRecord?.supersededById).toBe(secondResult.record?.id);

    const head = await temporalHead("user:user/shell_runtime", scopeContext);
    expect(head?.currentClaims.map((claim) => claim.memoryId)).toEqual([secondResult.record?.id]);
  }, 30_000);

  it("Case E: different language set member → coexist, not reinforce", async () => {
    const first = commitCommand({
      content: "我喜欢 Go。",
      embedding: unitVector(501),
      factKey: "user:user/lang_set",
      cardinality: "set",
      normalizedValue: "go",
    });
    const firstResult = await memory.commit(first);
    const firstId = firstResult.record?.id as string;

    clock.advance(60_000);
    const second = commitCommand({
      content: "TypeScript 也是我喜欢的语言。",
      embedding: withCosine(unitVector(501), 0.3, 502),
      factKey: "user:user/lang_set",
      cardinality: "set",
      normalizedValue: "typescript",
    });
    const secondResult = await memory.commit(second);
    expect(secondResult.outcome).toBe("created");
    expect(secondResult.record?.id).not.toBe(firstId);
    expect(secondResult.record?.status).toBe("active");
    expect(secondResult.record?.conflictsWithIds).not.toContain(firstId);

    const head = await temporalHead("user:user/lang_set", scopeContext);
    expect(head?.currentClaims.map((claim) => claim.memoryId).sort()).toEqual(
      [firstId, secondResult.record?.id].sort(),
    );
  }, 30_000);

  it("Case F: opposite polarity on same statement → conflict, not reinforce", async () => {
    const first = commitCommand({
      content: "我不喜欢自动生成分支名。",
      embedding: unitVector(601),
      factKey: "user:user/branch_name_polarity",
      polarity: "negative",
    });
    const firstResult = await memory.commit(first);
    const firstId = firstResult.record?.id as string;

    clock.advance(60_000);
    const second = commitCommand({
      content: "我喜欢自动生成分支名。",
      embedding: withCosine(unitVector(601), 0.95, 602),
      factKey: "user:user/branch_name_polarity",
      polarity: "positive",
    });
    const secondResult = await memory.commit(second);
    expect(secondResult.outcome).toBe("conflict");
    expect(secondResult.record?.id).not.toBe(firstId);
    expect(secondResult.record?.status).toBe("conflicted");

    const oldRecord = await memory.get(firstId, { scopeContext, accessIntent: "explicit_id" });
    expect(oldRecord?.status).toBe("conflicted");
  }, 30_000);

  it("unknown relation → conflicted candidate, existing current fact untouched (no destructive supersede)", async () => {
    const first = commitCommand({
      content: "实验分支使用天文命名。",
      embedding: unitVector(701),
      factKey: "user:user/experiment_subject",
    });
    const firstResult = await memory.commit(first);
    const firstId = firstResult.record?.id as string;

    clock.advance(60_000);
    const second = commitCommand({
      content: "生产分支使用天文命名。",
      embedding: withCosine(unitVector(701), 0.7, 702),
      factKey: "user:user/experiment_subject",
    });
    const secondResult = await memory.commit(second);

    expect(secondResult.outcome).toBe("conflict");
    expect(secondResult.record?.status).toBe("conflicted");
    expect(secondResult.record?.conflictsWithIds).toContain(firstId);

    const oldRecord = await memory.get(firstId, { scopeContext, accessIntent: "explicit_id" });
    expect(oldRecord?.status).toBe("active");
    expect(oldRecord?.supersededById).toBeUndefined();

    const head = await temporalHead("user:user/experiment_subject", scopeContext);
    expect(head?.currentClaims.map((claim) => claim.memoryId)).toEqual([firstId]);

    const trace = telemetry.traces().find(
      (t) =>
        t.name === "memory_value_relation" &&
        t.attributes.existingId === firstId &&
        t.attributes.finalStorageAction === "conflicted-candidate",
    );
    expect(trace).toBeDefined();
  }, 30_000);

  it("reinforce keeps the canonical content (no paraphrase version chain)", async () => {
    const first = commitCommand({
      content: "写实现时我倾向直白、少层级。",
      embedding: unitVector(801),
      factKey: "user:user/code_style_set",
      cardinality: "set",
    });
    const firstResult = await memory.commit(first);
    const firstId = firstResult.record?.id as string;

    clock.advance(60_000);
    const second = commitCommand({
      content: "我喜欢简单直接的代码。",
      embedding: withCosine(unitVector(801), 0.95, 802),
      factKey: "user:user/code_style_set",
      cardinality: "set",
    });
    const secondResult = await memory.commit(second);

    expect(secondResult.outcome).toBe("reinforced");
    const stored = await memory.get(firstId, { scopeContext, accessIntent: "explicit_id" });
    expect(stored?.content).toBe("写实现时我倾向直白、少层级。");
    expect(stored?.reinforceCount).toBe(1);
  }, 30_000);
});
