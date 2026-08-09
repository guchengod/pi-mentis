import { describe, expect, it } from "vitest";

import { EvidenceAuthority } from "@pi-mentis/pi-mentis-core";
import type {
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResponse,
} from "@pi-mentis/pi-mentis-inference";

import {
  DefaultRememberCoordinator,
  ScopeSemanticPlanner,
  type CommitMemoryCommand,
  type MemoryRecord,
  type MemoryService,
} from "../src/index.js";

class CountingEmbedding implements EmbeddingProvider {
  readonly id = "counting";
  calls = 0;
  async capabilities() {
    return { models: [] };
  }
  async health() {
    return { status: "healthy" as const, checkedAt: Date.now() };
  }
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    this.calls++;
    return {
      model: { providerId: this.id, modelId: "test", capabilityVersion: "1" },
      vectors: request.inputs.map(() => ({
        values: new Float32Array(request.dimensions).fill(0.1),
        dimensions: request.dimensions,
        normalized: true,
      })),
      usage: { inputTokens: 1 },
    };
  }
}

function record(command: CommitMemoryCommand): Omit<MemoryRecord, "embedding"> {
  return {
    schemaVersion: 2,
    id: "memory-v2",
    content: command.content,
    normalizedContent: command.content,
    contentHash: "hash",
    scope: command.scope,
    scopeContext: command.scopeContext,
    confidence: 1,
    importance: 0.5,
    authority: EvidenceAuthority.UserCurrentInstruction,
    evidenceRefs: [],
    relationships: {
      reinforcesIds: [],
      supersedesIds: [],
      retractsIds: [],
      conflictsWithIds: [],
      coexistsWithIds: [],
    },
    status: "active",
    embeddingSpaceId: "space",
    createdAt: 1,
    updatedAt: 1,
    observedAt: 1,
    lastAccessedAt: 1,
    reinforceCount: 0,
    revision: 1,
    provenance: command.provenance ?? { origin: "user", epistemicState: "asserted" },
  };
}

describe("classless formation call budget", () => {
  it("uses one content embedding, zero prototype embeddings, and emits no classification fields", async () => {
    const embedding = new CountingEmbedding();
    let committed: CommitMemoryCommand | undefined;
    const service: MemoryService = {
      async commit(command) {
        committed = command;
        return {
          outcome: "created",
          record: record(command),
          relatedIds: [],
          relationDecision: "unrelated",
          traceId: "trace",
        };
      },
      async get(id) {
        return id === "memory-v2" && committed !== undefined ? record(committed) : undefined;
      },
      async search() {
        return {
          hits: [],
          diagnostics: { durationMs: 0, timedOut: false, degraded: [], stages: {} },
        };
      },
      async tombstone() {
        return true;
      },
    };
    const planner = new ScopeSemanticPlanner({ embedding, dimensions: 8 });
    const coordinator = new DefaultRememberCoordinator(service, planner);
    let observedCommitId: string | undefined;
    const result = await coordinator.remember(
      { content: "我的临时编辑器主题代号是 Nivora。" },
      {
        scopeContext: { tenantId: "t", userId: "u", appId: "pi", agentId: "mentis" },
        onCommitted: (commitResult) => {
          observedCommitId = commitResult.record?.id;
        },
      },
    );
    expect(result).toMatchObject({
      outcome: "remembered",
      recallable: true,
      relationDecision: "unrelated",
    });
    expect(embedding.calls).toBe(1);
    expect(observedCommitId).toBe("memory-v2");
    const payload = committed as unknown as Record<string, unknown>;
    for (const removed of [
      "predicate",
      "type",
      "domain",
      "cardinality",
      "factKey",
      "semanticKey",
    ]) {
      expect(payload).not.toHaveProperty(removed);
    }
  });
});
