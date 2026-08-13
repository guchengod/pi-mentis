import { describe, expect, it, vi } from "vitest";

import type {
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResponse,
} from "@pi-mentis/pi-mentis-inference";
import type { ZvecStore } from "@pi-mentis/pi-mentis-zvec";

import { createMemoryService } from "../src/index.js";

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
    this.calls += 1;
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

describe("local-only memory search", () => {
  it("uses FTS without remote embedding or dense vector search", async () => {
    const embedding = new CountingEmbedding();
    const ftsSearch = vi.fn(async () => []);
    const vectorSearch = vi.fn(async () => []);
    const store = { ftsSearch, vectorSearch } as unknown as ZvecStore;
    const memory = createMemoryService({
      store,
      embedding,
      embeddingSpace: {
        providerId: embedding.id,
        modelId: "test",
        dimensions: 8,
        normalization: "none",
        preprocessingVersion: "test-v1",
        inputKindVersion: "test-v1",
      },
      dimensions: 8,
      viewsEnabled: false,
    });

    const result = await memory.search(
      {
        text: "默认端口",
        scopeContext: { tenantId: "local", userId: "local", appId: "pi", agentId: "pi-mentis" },
      },
      { allowRemoteEmbedding: false },
    );

    expect(result.hits).toEqual([]);
    expect(embedding.calls).toBe(0);
    expect(ftsSearch).toHaveBeenCalledOnce();
    expect(vectorSearch).not.toHaveBeenCalled();
  });
});
