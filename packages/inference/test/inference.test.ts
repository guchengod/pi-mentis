import { describe, expect, it } from "vitest";

import {
  ApproximateModelTokenEstimator,
  ConservativeUtf8TokenEstimator,
  assertSupportedEmbeddingDimension,
  createRerankBudget,
  embeddingCacheKey,
  embeddingSpaceId,
  getVerifiedEmbeddingModel,
  normalizeBatchScores,
  planRerankBatches,
  rerankCacheKey,
  validateEmbeddingVector,
} from "../src/index.js";

describe("Embedding identity and validation", () => {
  it("supports the production dimension range but enforces model capability", () => {
    const model = getVerifiedEmbeddingModel("Qwen/Qwen3-Embedding-8B");
    expect(model.supportsDimensionSelection).toBe(true);
    for (const dimensions of [768, 1024, 1536, 2048, 2560, 4096]) {
      expect(() => assertSupportedEmbeddingDimension(model, dimensions)).not.toThrow();
    }
    expect(() => assertSupportedEmbeddingDimension(model, 3072)).toThrow();
    expect(() => assertSupportedEmbeddingDimension(model, 767)).toThrow();
    expect(() => validateEmbeddingVector([0, Number.NaN], 2, false)).toThrow();
  });

  it("treats bge-m3 as a fixed 1024-dimension Embedding model", () => {
    const model = getVerifiedEmbeddingModel("BAAI/bge-m3");
    expect(model).toMatchObject({
      supportedDimensions: [1_024],
      defaultDimensions: 1_024,
      supportsDimensionSelection: false,
      maxInputTokens: 8_192,
    });
    expect(() => assertSupportedEmbeddingDimension(model, 1_024)).not.toThrow();
    expect(() => assertSupportedEmbeddingDimension(model, 768)).toThrow();
  });

  it("invalidates IDs and caches on every semantic identity field", () => {
    const identity = {
      providerId: "siliconflow",
      modelId: "model",
      dimensions: 1024,
      normalization: "none" as const,
      preprocessingVersion: "p1",
      inputKindVersion: "i1",
    };
    expect(embeddingSpaceId(identity)).not.toBe(
      embeddingSpaceId({ ...identity, dimensions: 1536 }),
    );
    const base = {
      ...identity,
      inputKind: "query" as const,
      contentHash: "abc",
    };
    expect(embeddingCacheKey(base)).not.toBe(embeddingCacheKey({ ...base, inputKind: "document" }));
    const rerank = {
      providerId: "siliconflow",
      modelId: "r",
      queryHash: "q",
      orderedDocumentContentHashes: ["a", "b"],
      instructionHash: "i",
      topN: 2,
      modelCapabilityVersion: "1",
    };
    expect(rerankCacheKey(rerank)).not.toBe(
      rerankCacheKey({ ...rerank, orderedDocumentContentHashes: ["b", "a"] }),
    );
  });
});

describe("Rerank planning", () => {
  it("keeps approximate model tokens separate from the UTF-8 safety bound", () => {
    const approximate = new ApproximateModelTokenEstimator();
    const conservative = new ConservativeUtf8TokenEstimator();
    const text = "alpha beta gamma delta ".repeat(40);

    expect(approximate.count(text)).toBeLessThan(conservative.count(text));
    expect(conservative.count("数据库")).toBe(Buffer.byteLength("数据库", "utf8"));
  });

  it.each([8192, 16384, 32768])("keeps batches inside a %i-token context", (context) => {
    const estimator = new ConservativeUtf8TokenEstimator();
    const budget = createRerankBudget("query", "instruction", estimator, {
      modelContextTokens: context,
    });
    const batches = planRerankBatches(
      Array.from({ length: 30 }, (_, index) => ({
        id: String(index),
        text: `document ${index} `.repeat(100),
      })),
      budget,
      estimator,
    );
    expect(batches.length).toBeGreaterThan(0);
    expect(batches.every((batch) => batch.estimatedInputTokens < context)).toBe(true);
  });

  it("normalizes scores independently across hierarchical batches", () => {
    expect(
      Object.fromEntries(
        normalizeBatchScores([
          [
            { documentId: "a", relevanceScore: 2 },
            { documentId: "b", relevanceScore: 4 },
          ],
          [{ documentId: "c", relevanceScore: 99 }],
        ]),
      ),
    ).toEqual({ a: 0, b: 1, c: 1 });
  });
});
