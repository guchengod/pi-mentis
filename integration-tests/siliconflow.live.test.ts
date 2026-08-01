import { describe, expect, it } from "vitest";

import { createDefaultConfig } from "@pi-mentis/pi-mentis-core";
import { getVerifiedEmbeddingModel, getVerifiedRerankModel } from "@pi-mentis/pi-mentis-inference";
import {
  SiliconFlowEmbeddingProvider,
  SiliconFlowRerankProvider,
} from "@pi-mentis/pi-mentis-siliconflow";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(
      `${name} is required for the real SiliconFlow live test; no fallback model or credential is used`,
    );
  }
  return value;
}

describe.skipIf(process.env["SILICONFLOW_LIVE_TEST"] !== "1")("SiliconFlow live opt-in", () => {
  it("executes real Embedding and Rerank requests", async () => {
    requiredEnvironment("SILICONFLOW_API_KEY");
    const embeddingModel = requiredEnvironment("SILICONFLOW_EMBEDDING_MODEL");
    const rerankModel = requiredEnvironment("SILICONFLOW_RERANKER_MODEL");
    const embeddingCapability = getVerifiedEmbeddingModel(embeddingModel);
    const rerankCapability = getVerifiedRerankModel(rerankModel);
    const defaults = createDefaultConfig(process.cwd()).inference.siliconflow;
    const dimensions = embeddingCapability.supportedDimensions.includes(
      defaults.embedding.dimensions,
    )
      ? defaults.embedding.dimensions
      : embeddingCapability.defaultDimensions;
    const config = {
      ...defaults,
      embedding: {
        ...defaults.embedding,
        model: embeddingModel,
        dimensions,
      },
      rerank: {
        ...defaults.rerank,
        model: rerankModel,
        maxInputTokens: Math.min(defaults.rerank.maxInputTokens, rerankCapability.maxInputTokens),
      },
    };
    const embedding = new SiliconFlowEmbeddingProvider(config);
    const embedded = await embedding.embed({
      inputs: [
        "Pi Mentis stores persistent knowledge and memory.",
        "A tropical storm is moving across the ocean.",
      ],
      inputKind: "query",
      dimensions,
    });
    expect(embedded.model.modelId).toBe(embeddingModel);
    expect(embedded.vectors).toHaveLength(2);
    for (const vector of embedded.vectors) {
      expect(vector.dimensions).toBe(dimensions);
      expect([...vector.values].every((value) => Number.isFinite(value))).toBe(true);
      expect(vector.values.some((value) => value !== 0)).toBe(true);
    }
    expect(embedded.vectors[0]?.values).not.toEqual(embedded.vectors[1]?.values);
    expect(embedded.traceId).toEqual(expect.any(String));
    const reranker = new SiliconFlowRerankProvider(config);
    const reranked = await reranker.rerank({
      query: "persistent intelligence",
      documents: [
        { id: "a", text: "persistent knowledge and memory" },
        { id: "b", text: "unrelated weather" },
      ],
      topN: 2,
    });
    expect(reranked.model.modelId).toBe(rerankModel);
    expect(reranked.items).toHaveLength(2);
    expect(new Set(reranked.items.map((item) => item.documentId))).toEqual(new Set(["a", "b"]));
    expect(reranked.items.every((item) => Number.isFinite(item.relevanceScore))).toBe(true);
    expect(reranked.items[0]?.documentId).toBe("a");
    expect(reranked.items[0]!.relevanceScore).toBeGreaterThan(reranked.items[1]!.relevanceScore);
    expect(reranked.traceId).toEqual(expect.any(String));
  });
});
