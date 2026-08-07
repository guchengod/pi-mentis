import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { EvidenceAuthority } from "@pi-mentis/pi-mentis-core";
import {
  PredicateRegistry,
  type MemoryService,
  type PredicateDefinition,
} from "@pi-mentis/pi-mentis-memory-core";
import type {
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResponse,
  ProviderHealth,
  RerankProvider,
  RerankProviderCapabilities,
  RerankRequest,
  RerankResponse,
} from "@pi-mentis/pi-mentis-inference";

import { adaptiveCutoff } from "../src/adaptive-cutoff.js";
import {
  FilePredicateVectorCache,
  InMemoryPredicateSemanticIndex,
  SemanticQueryPlanner,
  inferRetrievalMode,
} from "../src/semantic-query-planner.js";
import { DefaultRecallCoordinator } from "../src/recall-coordinator.js";
import { applyPredicateSoftPrior, createRetrievalService } from "../src/service.js";

const definitions: readonly PredicateDefinition[] = [
  {
    id: "code_style_preference",
    description: "Simple direct code and avoidance of needless abstraction.",
    retrievalDescription:
      "Use for coding habits, interfaces, abstraction, module design, and implementation style.",
    subjectTypes: ["user"],
    valueType: "preference",
    cardinality: "set",
    temporalBehavior: "evolving",
    memoryDomains: ["user"],
  },
  {
    id: "architecture_preference",
    description: "Preferences about software architecture and layers.",
    retrievalDescription: "Use for architecture boundaries, components, and provider layers.",
    subjectTypes: ["user"],
    valueType: "preference",
    cardinality: "set",
    temporalBehavior: "evolving",
    memoryDomains: ["user"],
  },
  {
    id: "package_manager_preference",
    description: "Preferred package management tooling such as pnpm.",
    retrievalDescription: "Use when package management affects the current work.",
    subjectTypes: ["user"],
    valueType: "preference",
    cardinality: "set",
    temporalBehavior: "evolving",
    memoryDomains: ["user"],
  },
  {
    id: "response_style",
    description: "Preferred response presentation and ordering.",
    retrievalDescription: "Use when choosing how to present an answer.",
    subjectTypes: ["user"],
    valueType: "preference",
    cardinality: "set",
    temporalBehavior: "evolving",
    memoryDomains: ["user"],
  },
];

const vectors = {
  code: [1, 0.15, 0, 0],
  architecture: [0.86, 0.38, 0, 0],
  package: [0.08, 1, 0, 0],
  response: [0, 0, 1, 0],
  broad: [0.72, 0.72, 0.72, 0],
  unrelated: [0, 0, 0, 1],
} as const;

function vectorFor(text: string): Float32Array {
  if (text.includes("code_style_preference")) return Float32Array.from(vectors.code);
  if (text.includes("architecture_preference")) return Float32Array.from(vectors.architecture);
  if (text.includes("package_manager_preference")) return Float32Array.from(vectors.package);
  if (text.includes("response_style")) return Float32Array.from(vectors.response);
  if (text.includes("12 乘以 8") || text.includes("HTTP 304")) {
    return Float32Array.from(vectors.unrelated);
  }
  if (text.includes("总结一下我的技术偏好")) return Float32Array.from(vectors.broad);
  if (text.includes("pnpm")) return Float32Array.from([0.7, 1, 0, 0]);
  return Float32Array.from(vectors.code);
}

class SemanticEmbeddingProvider implements EmbeddingProvider {
  readonly id = "semantic-test";
  documentRequests = 0;
  queryRequests = 0;
  fail = false;

  async capabilities() {
    return { models: [] };
  }

  async health() {
    return { healthy: !this.fail, checkedAt: Date.now() };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    if (this.fail) throw new Error("provider unavailable");
    if (request.inputKind === "document") this.documentRequests++;
    else this.queryRequests++;
    return {
      model: { providerId: this.id, modelId: "semantic-test", revision: "1" },
      vectors: request.inputs.map((input) => ({
        values: vectorFor(input),
        dimensions: 4,
        normalized: false,
      })),
    };
  }
}

function planner(provider: SemanticEmbeddingProvider, cache?: FilePredicateVectorCache) {
  return new SemanticQueryPlanner({
    embedding: provider,
    modelId: "semantic-test",
    dimensions: 4,
    registry: new PredicateRegistry("test:v1", definitions),
    ...(cache === undefined ? {} : { cache }),
  });
}

describe("Predicate semantic index", () => {
  it("ranks cosine similarity and honors top-N", () => {
    const index = new InMemoryPredicateSemanticIndex(
      definitions.map((definition) => ({
        predicate: definition.id,
        vector: vectorFor(definition.id),
      })),
    );
    const ranked = index.rank(Float32Array.from(vectors.code), { limit: 2 });
    expect(ranked).toHaveLength(2);
    expect(ranked[0]?.predicate).toBe("code_style_preference");
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
  });

  it("does not turn an orthogonal query into a significant predicate", () => {
    const index = new InMemoryPredicateSemanticIndex(
      definitions.map((definition) => ({
        predicate: definition.id,
        vector: vectorFor(definition.id),
      })),
    );
    expect(index.rank(Float32Array.from(vectors.unrelated))[0]?.score).toBe(0);
  });
});

describe("Semantic Query Planner", () => {
  it.each([
    "我对代码设计有什么偏好？",
    "按照我平时的习惯，这个模块应该尽量怎么设计？",
    "我是不是比较反感过度工程化？",
    "按我以前的编码习惯，这里是不是没必要再抽一层？",
    "这种场景按我的风格应该直接做还是先搭完整架构？",
  ])("routes open expression without query text rules: %s", async (query) => {
    const result = await planner(new SemanticEmbeddingProvider()).prepare(query);
    expect(result.plan.memoryNeed.required).toBe(true);
    expect(result.plan.predicateCandidates[0]?.predicate).toBe("code_style_preference");
  });

  it("keeps code style and package manager candidates for a combined query", async () => {
    const result = await planner(new SemanticEmbeddingProvider()).prepare(
      "按照我的代码习惯，pnpm 这一层有必要再封装一个 Provider 接口吗？",
    );
    expect(result.plan.predicateCandidates.map((candidate) => candidate.predicate)).toEqual(
      expect.arrayContaining(["code_style_preference", "package_manager_preference"]),
    );
    expect(result.plan.predicateCandidates.map((candidate) => candidate.predicate)).not.toContain(
      "response_style",
    );
  });

  it("infers broad mode from a distributed semantic ranking", async () => {
    const result = await planner(new SemanticEmbeddingProvider()).prepare("总结一下我的技术偏好。");
    expect(result.plan.retrievalMode).toBe("broad");
    expect(result.plan.predicateCandidates.length).toBeGreaterThan(2);
  });

  it.each(["12 乘以 8 是多少？", "HTTP 304 是什么意思？"])(
    "emits no-memory-needed for an unrelated query: %s",
    async (query) => {
      const result = await planner(new SemanticEmbeddingProvider()).prepare(query);
      expect(result.plan.memoryNeed.required).toBe(false);
      expect(result.plan.predicateCandidates).toEqual([]);
    },
  );

  it("uses temporal language only as a structural feature", async () => {
    const result = await planner(new SemanticEmbeddingProvider()).prepare(
      "按我以前的编码习惯，这里是不是没必要再抽一层？",
    );
    expect(result.plan.temporalIntent).toBe("historical");
  });

  it("returns a degraded plan when the embedding provider is unavailable", async () => {
    const provider = new SemanticEmbeddingProvider();
    provider.fail = true;
    const result = await planner(provider).prepare("按照我的习惯怎么设计？");
    expect(result.queryEmbedding).toBeUndefined();
    expect(result.plan.diagnostics?.plannerDegraded).toBe(true);
    expect(result.plan.memoryNeed.required).toBe(true);
  });

  it("persists predicate vectors and only embeds the query after restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "predicate-cache-"));
    const cache = new FilePredicateVectorCache(path.join(root, "index.json"));
    const first = new SemanticEmbeddingProvider();
    await planner(first, cache).prepare("我对代码设计有什么偏好？");
    expect(first.documentRequests).toBe(1);
    expect(first.queryRequests).toBe(1);

    const second = new SemanticEmbeddingProvider();
    await planner(second, cache).prepare("我是不是比较反感过度工程化？");
    expect(second.documentRequests).toBe(0);
    expect(second.queryRequests).toBe(1);
  });
});

describe("semantic distribution and adaptive cutoff", () => {
  it("infers focused and broad modes from score distributions", () => {
    expect(
      inferRetrievalMode([
        { predicate: "a", score: 0.94 },
        { predicate: "b", score: 0.49 },
        { predicate: "c", score: 0.41 },
      ]),
    ).toBe("focused");
    expect(
      inferRetrievalMode([
        { predicate: "a", score: 0.82 },
        { predicate: "b", score: 0.8 },
        { predicate: "c", score: 0.77 },
        { predicate: "d", score: 0.75 },
      ]),
    ).toBe("broad");
  });

  const hit = (id: string, score: number) => ({
    id,
    score,
    kind: "memory" as const,
    text: id,
    tokenCount: 1,
    authority: 80 as const,
    namespace: "local",
    contentHash: id,
  });

  it("cuts a focused distribution at the large score gap", () => {
    expect(
      adaptiveCutoff({
        mode: "focused",
        hits: [hit("a", 0.94), hit("b", 0.52), hit("c", 0.49), hit("d", 0.46)],
      }).map((item) => item.id),
    ).toEqual(["a"]);
  });

  it("keeps the broad cluster before its score gap", () => {
    expect(
      adaptiveCutoff({
        mode: "broad",
        hits: [hit("a", 0.89), hit("b", 0.86), hit("c", 0.84), hit("d", 0.5)],
      }).map((item) => item.id),
    ).toEqual(["a", "b", "c"]);
  });

  it("uses predicate routing as a soft prior and never a semantic hard filter", () => {
    const plan = {
      predicateCandidates: [
        { predicate: "code_style_preference", confidence: 0.94 },
        { predicate: "package_manager_preference", confidence: 0.72 },
      ],
      subjectCandidates: [{ subject: "user" as const, confidence: 0.94 }],
      temporalIntent: "any" as const,
      retrievalMode: "focused" as const,
      confidence: 0.9,
      memoryNeed: { required: true, confidence: 0.9 },
    };
    const candidates = [
      { ...hit("response", 0.5), metadata: { factKey: "user:u/response_style" } },
      { ...hit("code", 0.5), metadata: { factKey: "user:u/code_style_preference" } },
      { ...hit("package", 0.5), metadata: { factKey: "user:u/package_manager_preference" } },
    ]
      .map((candidate) => applyPredicateSoftPrior(candidate, plan, Date.now(), 0.1))
      .sort((left, right) => right.score - left.score);
    expect(candidates.map((candidate) => candidate.id)).toEqual(["code", "package", "response"]);
    expect(candidates).toHaveLength(3);
  });
});

class PrecisionReranker implements RerankProvider {
  readonly id = "precision-reranker";
  requests = 0;

  capabilities(): Promise<RerankProviderCapabilities> {
    return Promise.resolve({
      models: [
        {
          model: { providerId: this.id, modelId: this.id, capabilityVersion: "1" },
          maxInputTokens: 8192,
          supportsInstruction: true,
          supportsDocumentChunking: false,
          supportsOverlapTokens: false,
          contentKinds: ["text"],
        },
      ],
    });
  }

  rerank(request: RerankRequest): Promise<RerankResponse> {
    this.requests++;
    const scores: Record<string, number> = { code: 0.95, package: 0.55, response: 0.08 };
    return Promise.resolve({
      model: { providerId: this.id, modelId: this.id, capabilityVersion: "1" },
      items: request.documents
        .map((document, originalIndex) => ({
          documentId: document.id,
          originalIndex,
          relevanceScore: scores[document.id] ?? 0,
        }))
        .sort((left, right) => right.relevanceScore - left.relevanceScore),
    });
  }

  health(): Promise<ProviderHealth> {
    return Promise.resolve({ status: "available", checkedAt: Date.now() });
  }
}

function memoryMetadata(id: string, content: string, predicate: string) {
  const now = Date.now();
  return {
    id,
    content,
    normalizedContent: content,
    contentHash: id,
    type: "preference" as const,
    domain: "user" as const,
    scope: { kind: "user" as const, id: "user" },
    scopeContext: { tenantId: "local", userId: "user", appId: "pi", agentId: "pi-mentis" },
    ownership: { tenantId: "local", userId: "user", appId: "pi", agentId: "pi-mentis" },
    sensitivity: "public" as const,
    confidence: 0.9,
    importance: 0.8,
    authority: EvidenceAuthority.UserKnowledge,
    evidenceRefs: [{ kind: "event" as const, id: `${id}:evidence`, observedAt: now }],
    supersedesIds: [],
    conflictsWithIds: [],
    status: "active" as const,
    embeddingSpaceId: "semantic-test",
    createdAt: now,
    updatedAt: now,
    observedAt: now,
    lastAccessedAt: now,
    reinforceCount: 0,
    revision: 1,
    factKey: `user:user/${predicate}`,
    cardinality: "set" as const,
    temporalState: "current" as const,
    contentOrigin: "user" as const,
  };
}

describe("Recall semantic pipeline", () => {
  it("reuses one query embedding, keeps reranking, and summarizes only final hits", async () => {
    const embedding = new SemanticEmbeddingProvider();
    const reranker = new PrecisionReranker();
    let reusedQueryEmbedding = false;
    const records = [
      memoryMetadata("response", "用户偏好回答先给结论，再解释原因。", "response_style"),
      memoryMetadata(
        "code",
        "用户喜欢简单直接的代码实现，避免为了抽象而增加不必要的接口层。",
        "code_style_preference",
      ),
      memoryMetadata("package", "用户偏好 pnpm。", "package_manager_preference"),
    ];
    const memory = {
      async search(query) {
        reusedQueryEmbedding = query.queryEmbedding !== undefined;
        return {
          hits: records.map((record) => ({
            id: record.id,
            kind: "memory" as const,
            text: record.content,
            score: 0.5,
            tokenCount: 12,
            authority: record.authority,
            namespace: "local:user:pi:pi-mentis",
            contentHash: record.contentHash,
            metadata: record,
          })),
          diagnostics: { durationMs: 1, timedOut: false, degraded: [], stages: {} },
        };
      },
    } as Pick<MemoryService, "search"> as MemoryService;
    const retrieval = createRetrievalService({
      memory,
      reranker,
      rerankModel: reranker.id,
      rerankContextTokens: 8192,
      semanticPlanner: planner(embedding),
    });
    const coordinator = new DefaultRecallCoordinator({
      getMemory: () => memory,
      getRetrieval: () => retrieval,
      getEvidence: () => undefined,
    });
    const result = await coordinator.recall(
      { query: "我对代码设计有什么偏好？" },
      {
        scopeContext: {
          tenantId: "local",
          userId: "user",
          appId: "pi",
          agentId: "pi-mentis",
        },
      },
    );
    expect(reusedQueryEmbedding).toBe(true);
    expect(embedding.queryRequests).toBe(1);
    expect(reranker.requests).toBe(1);
    expect(result.hits.map((hit) => hit.id)).toEqual(["code"]);
    expect(result.summary).toBe(records[1]?.content);
    expect(result.summary).not.toContain("pnpm");
    expect(result.summary).not.toContain("结论");
  });
});
