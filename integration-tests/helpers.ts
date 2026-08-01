import { createHash } from "node:crypto";

import type { StorageConfig } from "@pi-mentis/pi-mentis-core";
import type {
  EmbeddingProvider,
  EmbeddingProviderCapabilities,
  EmbeddingRequest,
  EmbeddingResponse,
  InferenceOperationOptions,
  ProviderHealth,
  RerankProvider,
  RerankProviderCapabilities,
  RerankResponse,
} from "@pi-mentis/pi-mentis-inference";

export function testStorage(rootDir: string): StorageConfig {
  return {
    rootDir,
    readOnly: false,
    lockTimeoutMs: 500,
    generationRetentionMs: 60_000,
    writeBatch: { maxOperations: 256, maxBytes: 8 * 1024 * 1024, maxWaitMs: 5 },
  };
}

export function embeddingSpace(dimensions = 768) {
  return {
    providerId: "test",
    modelId: `deterministic-${dimensions}`,
    dimensions,
    normalization: "none" as const,
    preprocessingVersion: "test-v1",
    inputKindVersion: "test-v1",
  };
}

function deterministicVector(text: string, dimensions: number): Float32Array {
  const vector = new Float32Array(dimensions);
  const normalized = text.normalize("NFKC").toLowerCase();
  for (let index = 0; index < normalized.length; index++) {
    const digest = createHash("sha256")
      .update(normalized.slice(index, index + 3))
      .digest();
    const slot = digest.readUInt32LE(0) % dimensions;
    vector[slot] = (vector[slot] ?? 0) + 1;
  }
  let squared = 0;
  for (const value of vector) squared += value * value;
  const norm = Math.sqrt(squared) || 1;
  for (let index = 0; index < vector.length; index++) vector[index] = (vector[index] ?? 0) / norm;
  return vector;
}

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly id = "test";
  readonly #dimensions: number;
  calls = 0;

  constructor(dimensions = 768) {
    this.#dimensions = dimensions;
  }

  capabilities(): Promise<EmbeddingProviderCapabilities> {
    return Promise.resolve({
      models: [
        {
          model: {
            providerId: this.id,
            modelId: `deterministic-${this.#dimensions}`,
            capabilityVersion: "1",
          },
          supportedDimensions: [this.#dimensions],
          defaultDimensions: this.#dimensions,
          supportsDimensionSelection: false,
          maxInputTokens: 32_768,
          maxBatchItems: 32,
          maxBatchTokens: 20_000,
          supportsBase64Encoding: false,
          supportsTruncation: false,
          inputKinds: ["query", "document", "code", "capability", "memory"],
        },
      ],
    });
  }

  embed(
    request: EmbeddingRequest,
    options: InferenceOperationOptions = {},
  ): Promise<EmbeddingResponse> {
    if (options.signal?.aborted === true) return Promise.reject(options.signal.reason);
    this.calls++;
    return Promise.resolve({
      model: {
        providerId: this.id,
        modelId: `deterministic-${this.#dimensions}`,
        capabilityVersion: "1",
      },
      vectors: request.inputs.map((text) => ({
        values: deterministicVector(text, request.dimensions),
        dimensions: request.dimensions,
        normalized: true,
      })),
      usage: { inputTokens: request.inputs.reduce((sum, text) => sum + text.length, 0) },
    });
  }

  health(): Promise<ProviderHealth> {
    return Promise.resolve({ status: "healthy", checkedAt: Date.now() });
  }
}

export class FailingReranker implements RerankProvider {
  readonly id = "failure";
  capabilities(): Promise<RerankProviderCapabilities> {
    return Promise.resolve({
      models: [
        {
          model: { providerId: this.id, modelId: "failure", capabilityVersion: "1" },
          maxInputTokens: 32_768,
          supportsInstruction: true,
          supportsDocumentChunking: false,
          supportsOverlapTokens: false,
          contentKinds: ["text"],
        },
      ],
    });
  }
  rerank(): Promise<RerankResponse> {
    return Promise.reject(new Error("recorded provider failure"));
  }
  health(): Promise<ProviderHealth> {
    return Promise.resolve({ status: "unavailable", checkedAt: Date.now() });
  }
}
