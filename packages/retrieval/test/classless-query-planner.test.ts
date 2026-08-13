import { describe, expect, it } from "vitest";

import type {
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResponse,
} from "@pi-mentis/pi-mentis-inference";

import { SemanticQueryPlanner } from "../src/index.js";

class CountingEmbedding implements EmbeddingProvider {
  readonly id = "query-counting";
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
        values: new Float32Array(request.dimensions),
        dimensions: request.dimensions,
        normalized: true,
      })),
      usage: { inputTokens: 1 },
    };
  }
}

describe("classless query planning", () => {
  it("does no startup work and prepares one reusable query vector", async () => {
    const embedding = new CountingEmbedding();
    const planner = new SemanticQueryPlanner({ embedding, modelId: "test", dimensions: 8 });
    planner.warmup();
    expect(embedding.calls).toBe(0);
    const prepared = await planner.prepare("我的默认端口是什么？");
    expect(embedding.calls).toBe(1);
    expect(prepared.plan).toMatchObject({
      temporalIntent: "any",
      memoryNeed: { required: true },
      diagnostics: { sourceDependencySignal: "classless_retrieval" },
    });
    expect(prepared.plan).not.toHaveProperty("predicateCandidates");
  });

  it("keeps automatic local-only recall off the remote embedding path", async () => {
    const embedding = new CountingEmbedding();
    const planner = new SemanticQueryPlanner({ embedding, modelId: "test", dimensions: 8 });

    const prepared = await planner.prepare("记忆里的默认端口是什么？", {
      allowRemoteEmbedding: false,
    });

    expect(embedding.calls).toBe(0);
    expect(prepared.queryEmbedding).toBeUndefined();
    expect(prepared.plan).toMatchObject({
      memoryNeed: { required: true },
      diagnostics: { sourceDependencySignal: "local_only_retrieval" },
    });
  });
});
