import { describe, expect, it } from "vitest";
import { EvidenceAuthority } from "@pi-mentis/pi-mentis-core";
import type {
  MemoryQuery,
  MemoryRecord,
  MemoryService,
  PiScopeContext,
} from "@pi-mentis/pi-mentis-memory-core";

import { DefaultRecallCoordinator } from "../src/recall-coordinator.js";
import type {
  RecallCoordinator,
  RecallRequest,
  RecallExecutionContext,
} from "../src/recall-coordinator.js";
import type { RetrievalService, RetrievalQuery, RetrievalOptions } from "../src/service.js";
import type { SearchHit, SearchResult } from "@pi-mentis/pi-mentis-core";

function uniqueContent(): string {
  const token = `TOKEN_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return `${token} 的含义是维护成本最低的方案优先选择。`;
}

function extractUniqueToken(content: string): string {
  return content.split(" ")[0] ?? content;
}

function makeSearchHit(
  record: Omit<MemoryRecord, "embedding">,
  index: number,
): SearchHit {
  const nsParts = [
    record.scopeContext?.tenantId ?? "local",
    record.scopeContext?.userId ?? "local",
    record.scopeContext?.appId ?? "pi",
    record.scopeContext?.agentId ?? "pi-mentis",
  ].map(encodeURIComponent).join(":");
  return {
    id: record.id,
    kind: "memory" as const,
    text: record.content,
    score: 1 - index * 0.1,
    tokenCount: Math.ceil(record.content.length / 4),
    authority: EvidenceAuthority.UserCurrentInstruction,
    namespace: `${nsParts}::${record.scope.kind}:${record.scope.id}`,
    contentHash: record.contentHash,
    metadata: record as unknown as SearchHit["metadata"],
  };
}

function mockMemoryService(
  records: Map<string, Omit<MemoryRecord, "embedding">>,
): MemoryService {
  const svc = {
    async commit() {
      return { outcome: "created" as const, record: undefined, relatedIds: [] };
    },

    async get(id: string) {
      return records.get(id);
    },

    async search(query: MemoryQuery): Promise<SearchResult> {
      const scopes = query.scopes;
      const hits = [...records.values()]
        .filter((record) => {
          if (scopes === undefined || scopes.length === 0) return true;
          return scopes.some(
            (scope) => record.scope.kind === scope.kind && record.scope.id === scope.id,
          );
        })
        .filter((record) => {
          const text = record.content.toLowerCase();
          return query.text
            .toLowerCase()
            .split(/\s+/)
            .some((term) => text.includes(term));
        })
        .map((record, index) => makeSearchHit(record, index));
      const hitIds = hits.map((h) => h.id);
      return {
        hits: hits.slice(0, query.limit ?? 20),
        diagnostics: {
          durationMs: 0,
          timedOut: false,
          degraded: [],
          stages: {},
          rankings: {
            rrf: hitIds,
            rerank: hitIds,
            mmr: hitIds,
          },
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
    async search(retrievalQuery: RetrievalQuery, _retrievalOpts?: RetrievalOptions): Promise<SearchResult> {
      void _retrievalOpts;
      const memoryResult = await memory.search(
        {
          text: retrievalQuery.text,
          limit: retrievalQuery.limit ?? 20,
          ...(retrievalQuery.memoryScopes === undefined
            ? {}
            : { scopes: retrievalQuery.memoryScopes }),
          ...(retrievalQuery.memoryScopeContext === undefined
            ? {}
            : { scopeContext: retrievalQuery.memoryScopeContext }),
        },
        {},
      );

      return {
        hits: memoryResult.hits,
        diagnostics: {
          durationMs: 1,
          timedOut: false,
          degraded: [],
          stages: {},
          traceOrder: ["memory", "rrf", "applicability-gates", "adaptive-cutoff", "mmr"],
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

function makeScopeContext(overrides: Partial<PiScopeContext> = {}): PiScopeContext {
  return {
    tenantId: "local",
    userId: "local",
    appId: "pi",
    agentId: "pi-mentis",
    ...overrides,
  };
}

function makeTopicRecord(id: string, content: string, topicId: string): Omit<MemoryRecord, "embedding"> {
  const scopeContext = makeScopeContext({ topicIds: [topicId] });
  return {
    id,
    content,
    normalizedContent: content,
    contentHash: `hash:${id}`,
    type: "fact" as const,
    domain: "topic" as const,
    scope: { kind: "topic" as const, id: topicId },
    scopeContext,
    ownership: {
      tenantId: "local",
      userId: "local",
      appId: "pi",
      agentId: "pi-mentis",
    },
    sensitivity: "public" as const,
    confidence: 0.9,
    importance: 0.8,
    authority: EvidenceAuthority.UserCurrentInstruction,
    evidenceRefs: [],
    supersedesIds: [],
    conflictsWithIds: [],
    status: "active" as const,
    embeddingSpaceId: "test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    observedAt: Date.now(),
    validFrom: Date.now(),
    lastAccessedAt: Date.now(),
    reinforceCount: 1,
    revision: 1,
    factKey: "user/local/response_style",
    cardinality: "single" as const,
    temporalState: "current" as const,
    evidenceIntegrity: "missing" as const,
  };
}

function makeUserRecord(id: string, content: string): Omit<MemoryRecord, "embedding"> {
  const scopeContext = makeScopeContext();
  return {
    ...makeTopicRecord(id, content, "user-scope"),
    domain: "user" as const,
    scope: { kind: "user" as const, id: "local" },
    scopeContext,
  };
}

describe("query-vs-ID consistency invariant", () => {
  const topicId = "topic_t1";
  const content = uniqueContent();
  const token = extractUniqueToken(content);
  const recordId = `mem-${token.slice(0, 12)}`;

  const scopeContext = makeScopeContext({ topicIds: [topicId] });

  it("exact ID lookup finds a topic-scoped record", async () => {
    const record = makeTopicRecord(recordId, content, topicId);
    const records = new Map<string, Omit<MemoryRecord, "embedding">>();
    records.set(recordId, record);

    const memory = mockMemoryService(records);
    const result = await memory.get(recordId, { accessIntent: "explicit_id" });
    expect(result).toBeDefined();
    expect(result?.id).toBe(recordId);
  });

  it("query search with topic scopes finds a topic-scoped record", async () => {
    const record = makeTopicRecord(recordId, content, topicId);
    const records = new Map<string, Omit<MemoryRecord, "embedding">>();
    records.set(recordId, record);

    const memory = mockMemoryService(records);
    const query = `${token} 维护成本最低`;
    const result = await memory.search({
      text: query,
      limit: 10,
      scopeContext,
      scopes: [{ kind: "topic" as const, id: topicId }, { kind: "user" as const, id: "local" }],
    });

    const found = result.hits.some((hit) => hit.id === recordId);
    expect(found).toBe(true);
  });

  it("query search WITHOUT topic scopes does NOT find a topic-scoped record — this is why the recall coordinator must include topic scopes", async () => {
    const record = makeTopicRecord(recordId, content, topicId);
    const records = new Map<string, Omit<MemoryRecord, "embedding">>();
    records.set(recordId, record);

    const memory = mockMemoryService(records);
    const query = `${token} 维护成本最低`;
    const result = await memory.search({
      text: query,
      limit: 10,
      scopeContext,
      scopes: [{ kind: "user" as const, id: "local" }],
    });

    const found = result.hits.some((hit) => hit.id === recordId);
    expect(found).toBe(false);
  });

  it("recall coordinator includes topic scopes in memoryScopes when topicIds are available", async () => {
    const record = makeTopicRecord(recordId, content, topicId);
    const records = new Map<string, Omit<MemoryRecord, "embedding">>();
    records.set(recordId, record);

    const memory = mockMemoryService(records);
    const retrieval = mockRetrievalService(memory);

    const coordinator: RecallCoordinator = new DefaultRecallCoordinator({
      getMemory: () => memory,
      getRetrieval: () => retrieval,
      getEvidence: () => undefined,
    });

    const request: RecallRequest = { query: `${token} 维护成本最低` };
    const context: RecallExecutionContext = { scopeContext };

    const result = await coordinator.recall(request, context);
    expect(result.found).toBe(true);
    const found = result.hits.some((hit) => hit.id === recordId);
    expect(found).toBe(true);
  });

  it("user-scoped record is always findable via query (control)", async () => {
    const content2 = uniqueContent();
    const token2 = extractUniqueToken(content2);
    const recordId2 = `mem-${token2.slice(0, 12)}`;

    const record = makeUserRecord(recordId2, content2);
    const records = new Map<string, Omit<MemoryRecord, "embedding">>();
    records.set(recordId2, record);

    const memory = mockMemoryService(records);
    const retrieval = mockRetrievalService(memory);

    const coordinator: RecallCoordinator = new DefaultRecallCoordinator({
      getMemory: () => memory,
      getRetrieval: () => retrieval,
      getEvidence: () => undefined,
    });

    const scopeCtx = makeScopeContext();
    const request: RecallRequest = { query: `${token2} 维护成本` };
    const context: RecallExecutionContext = { scopeContext: scopeCtx };

    const result = await coordinator.recall(request, context);
    expect(result.found).toBe(true);
    const found = result.hits.some((hit) => hit.id === recordId2);
    expect(found).toBe(true);
  });

  it("strong lexical match must retrieve the record regardless of kind=topic metadata", async () => {
    const topicId3 = "topic_default_plan";
    const content3 =
      `用户说"默认方案"时，意思是：优先选择维护成本最低的方案（lowest maintenance cost first），而不是默认实现方式或最常见的方案。`;
    const recordId3 = "test-TARGET-59938b43";

    const record = makeTopicRecord(recordId3, content3, topicId3);
    const records = new Map<string, Omit<MemoryRecord, "embedding">>();
    records.set(recordId3, record);

    const memory = mockMemoryService(records);
    const retrieval = mockRetrievalService(memory);

    const coordinator: RecallCoordinator = new DefaultRecallCoordinator({
      getMemory: () => memory,
      getRetrieval: () => retrieval,
      getEvidence: () => undefined,
    });

    const scopeCtx = makeScopeContext({ topicIds: [topicId3] });
    const request: RecallRequest = { query: "默认方案 维护成本最低" };
    const context: RecallExecutionContext = { scopeContext: scopeCtx };

    const idResult = await memory.get(recordId3, { accessIntent: "explicit_id" });
    expect(idResult).toBeDefined();

    const result = await coordinator.recall(request, context);
    expect(result.found).toBe(true);
    const found = result.hits.some((hit) => hit.id === recordId3);
    expect(found).toBe(true);
  });
});
