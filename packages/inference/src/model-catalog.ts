import { ModelCapabilityMismatchError } from "@pi-mentis/pi-mentis-core";

import type { EmbeddingModelCapabilities, RerankModelCapabilities } from "./contracts.js";
import { assertSupportedEmbeddingDimension } from "./embedding.js";

const embeddingModels = new Map<string, EmbeddingModelCapabilities>([
  [
    "Qwen/Qwen3-Embedding-8B",
    {
      model: {
        providerId: "siliconflow",
        modelId: "Qwen/Qwen3-Embedding-8B",
        capabilityVersion: "siliconflow-docs-2026-07-29",
      },
      supportedDimensions: [64, 128, 256, 512, 768, 1_024, 1_536, 2_048, 2_560, 4_096],
      defaultDimensions: 1_024,
      supportsDimensionSelection: true,
      maxInputTokens: 32_768,
      supportsBase64Encoding: true,
      supportsTruncation: true,
      inputKinds: ["query", "document", "code", "capability", "memory"],
    },
  ],
  [
    "BAAI/bge-m3",
    {
      model: {
        providerId: "siliconflow",
        modelId: "BAAI/bge-m3",
        capabilityVersion: "siliconflow-docs-2026-07-29",
      },
      supportedDimensions: [1_024],
      defaultDimensions: 1_024,
      supportsDimensionSelection: false,
      maxInputTokens: 8_192,
      supportsBase64Encoding: true,
      supportsTruncation: true,
      inputKinds: ["query", "document", "code", "capability", "memory"],
    },
  ],
]);

const rerankModels = new Map<string, RerankModelCapabilities>([
  [
    "Qwen/Qwen3-Reranker-8B",
    {
      model: {
        providerId: "siliconflow",
        modelId: "Qwen/Qwen3-Reranker-8B",
        capabilityVersion: "siliconflow-docs-2026-07-29",
      },
      maxInputTokens: 32_768,
      supportsInstruction: true,
      supportsDocumentChunking: false,
      supportsOverlapTokens: false,
      contentKinds: ["text"],
    },
  ],
  [
    "BAAI/bge-reranker-v2-m3",
    {
      model: {
        providerId: "siliconflow",
        modelId: "BAAI/bge-reranker-v2-m3",
        capabilityVersion: "siliconflow-docs-2026-07-29",
      },
      maxInputTokens: 8_192,
      supportsInstruction: false,
      supportsDocumentChunking: true,
      supportsOverlapTokens: true,
      maxOverlapTokens: 80,
      contentKinds: ["text"],
    },
  ],
]);

export function listVerifiedEmbeddingModelIds(): readonly string[] {
  return [...embeddingModels.keys()];
}

export function listVerifiedRerankModelIds(): readonly string[] {
  return [...rerankModels.keys()];
}

export function getVerifiedEmbeddingModel(modelId: string): EmbeddingModelCapabilities {
  const capability = embeddingModels.get(modelId);
  if (capability === undefined) {
    throw new ModelCapabilityMismatchError(
      `Embedding model ${modelId} is not in the verified SiliconFlow capability catalog`,
      { operation: "model-capability-lookup", model: modelId, retryable: false },
    );
  }
  return capability;
}

export function getVerifiedRerankModel(modelId: string): RerankModelCapabilities {
  const capability = rerankModels.get(modelId);
  if (capability === undefined) {
    throw new ModelCapabilityMismatchError(
      `Rerank model ${modelId} is not in the verified SiliconFlow capability catalog`,
      { operation: "model-capability-lookup", model: modelId, retryable: false },
    );
  }
  return capability;
}

export function validateConfiguredModels(
  embeddingModelId: string,
  dimensions: number,
  rerankModelId: string,
  maxInputTokens: number,
): {
  readonly embedding: EmbeddingModelCapabilities;
  readonly rerank: RerankModelCapabilities;
} {
  const embedding = getVerifiedEmbeddingModel(embeddingModelId);
  assertSupportedEmbeddingDimension(embedding, dimensions);
  const rerank = getVerifiedRerankModel(rerankModelId);
  if (maxInputTokens > rerank.maxInputTokens || maxInputTokens < 8_192) {
    throw new ModelCapabilityMismatchError(
      `Configured Rerank context ${maxInputTokens} is incompatible with verified ${rerankModelId} limit ${rerank.maxInputTokens}`,
      { operation: "model-capability-validate", model: rerankModelId, retryable: false },
    );
  }
  return { embedding, rerank };
}
