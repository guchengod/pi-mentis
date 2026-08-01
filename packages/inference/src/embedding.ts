import {
  EmbeddingVectorValidationError,
  UnsupportedEmbeddingDimensionError,
  stableHash,
} from "@pi-mentis/pi-mentis-core";

import type {
  EmbeddingModelCapabilities,
  EmbeddingSpaceIdentity,
  EmbeddingVector,
} from "./contracts.js";

export const PRODUCTION_EMBEDDING_DIMENSIONS = [
  768, 1_024, 1_536, 2_048, 2_560, 3_072, 4_096,
] as const;

export function assertSupportedEmbeddingDimension(
  capabilities: EmbeddingModelCapabilities,
  dimensions: number,
): void {
  if (!Number.isSafeInteger(dimensions) || dimensions < 768 || dimensions > 4_096) {
    throw new UnsupportedEmbeddingDimensionError(
      `Production Embedding dimension ${dimensions} must be an integer from 768 through 4096`,
      {
        operation: "embedding-dimension-validate",
        provider: capabilities.model.providerId,
        model: capabilities.model.modelId,
        retryable: false,
      },
    );
  }
  if (!capabilities.supportedDimensions.includes(dimensions)) {
    throw new UnsupportedEmbeddingDimensionError(
      `${capabilities.model.modelId} does not support ${dimensions} dimensions; supported dimensions: ${capabilities.supportedDimensions.join(", ")}`,
      {
        operation: "embedding-dimension-validate",
        provider: capabilities.model.providerId,
        model: capabilities.model.modelId,
        retryable: false,
      },
    );
  }
}

export function embeddingSpaceId(identity: EmbeddingSpaceIdentity): string {
  return stableHash(
    "embedding-space:v1",
    identity.providerId,
    identity.modelId,
    String(identity.dimensions),
    identity.normalization,
    identity.preprocessingVersion,
    identity.inputKindVersion,
  );
}

export function validateEmbeddingVector(
  values: readonly number[] | Float32Array,
  dimensions: number,
  normalized: boolean,
): EmbeddingVector {
  if (values.length !== dimensions) {
    throw new EmbeddingVectorValidationError(
      `Embedding vector has ${values.length} values; expected ${dimensions}`,
      { operation: "embedding-vector-validate", retryable: false },
    );
  }
  const vector = values instanceof Float32Array ? values.slice() : Float32Array.from(values);
  for (let index = 0; index < vector.length; index++) {
    const value = vector[index];
    if (value === undefined || !Number.isFinite(value)) {
      throw new EmbeddingVectorValidationError(
        `Embedding vector contains a non-finite value at index ${index}`,
        { operation: "embedding-vector-validate", retryable: false },
      );
    }
  }
  return { values: vector, dimensions, normalized };
}

export function normalizeL2(vector: EmbeddingVector): EmbeddingVector {
  let squared = 0;
  for (const value of vector.values) squared += value * value;
  const norm = Math.sqrt(squared);
  if (norm === 0) {
    throw new EmbeddingVectorValidationError("Cannot normalize a zero Embedding vector", {
      operation: "embedding-normalize",
      retryable: false,
    });
  }
  const values = new Float32Array(vector.values.length);
  for (let index = 0; index < vector.values.length; index++) {
    values[index] = (vector.values[index] ?? 0) / norm;
  }
  return { values, dimensions: vector.dimensions, normalized: true };
}
