import {
  EmbeddingVectorValidationError,
  ProviderResponseValidationError,
} from "@pi-mentis/pi-mentis-core";
import { validateEmbeddingVector } from "@pi-mentis/pi-mentis-inference";
import type { EmbeddingVector, RerankDocument, RerankItem } from "@pi-mentis/pi-mentis-inference";

export interface SiliconFlowEmbeddingRequest {
  readonly model: string;
  readonly input: string | readonly string[];
  readonly encoding_format: "float" | "base64";
  readonly dimensions?: number;
  readonly truncate?: "left" | "right";
  readonly user?: string;
}

export interface SiliconFlowEmbeddingData {
  readonly index: number;
  readonly embedding: readonly number[] | string;
  readonly object?: string;
}

export interface SiliconFlowEmbeddingResponse {
  readonly object: "list";
  readonly model: string;
  readonly data: readonly SiliconFlowEmbeddingData[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly total_tokens?: number;
  };
}

export interface SiliconFlowRerankRequest {
  readonly model: string;
  readonly query: string;
  readonly documents: readonly string[];
  readonly top_n: number;
  readonly return_documents: false;
  readonly instruction?: string;
  readonly max_chunks_per_doc?: number;
  readonly overlap_tokens?: number;
}

export interface SiliconFlowRerankResult {
  readonly index: number;
  readonly relevance_score: number;
}

export interface SiliconFlowRerankResponse {
  readonly id: string;
  readonly results: readonly SiliconFlowRerankResult[];
  readonly meta?: unknown;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderResponseValidationError(`${label} must be an object`, {
      operation: "provider-response-validate",
      retryable: false,
    });
  }
  return value as Record<string, unknown>;
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProviderResponseValidationError(`${label} must be a non-negative integer`, {
      operation: "provider-response-validate",
      retryable: false,
    });
  }
  return value as number;
}

export function parseEmbeddingResponse(value: unknown): SiliconFlowEmbeddingResponse {
  const root = object(value, "Embedding response");
  if (
    root["object"] !== "list" ||
    typeof root["model"] !== "string" ||
    !Array.isArray(root["data"])
  ) {
    throw new ProviderResponseValidationError(
      "Embedding response requires object=list, model, and data",
      { operation: "provider-response-validate", retryable: false },
    );
  }
  const data = root["data"].map((raw, position) => {
    const item = object(raw, `Embedding data[${position}]`);
    if (!Number.isSafeInteger(item["index"]) || (item["index"] as number) < 0) {
      throw new ProviderResponseValidationError(
        `Embedding data[${position}].index must be a non-negative integer`,
        { operation: "provider-response-validate", retryable: false },
      );
    }
    const embedding = item["embedding"];
    if (
      typeof embedding !== "string" &&
      (!Array.isArray(embedding) ||
        embedding.some((element) => typeof element !== "number" || !Number.isFinite(element)))
    ) {
      throw new ProviderResponseValidationError(
        `Embedding data[${position}].embedding is invalid`,
        { operation: "provider-response-validate", retryable: false },
      );
    }
    return {
      index: item["index"] as number,
      embedding: embedding as readonly number[] | string,
      ...(typeof item["object"] === "string" ? { object: item["object"] } : {}),
    };
  });
  let usage: SiliconFlowEmbeddingResponse["usage"];
  if (root["usage"] !== undefined) {
    const rawUsage = object(root["usage"], "Embedding usage");
    const promptTokens = optionalNonNegativeInteger(
      rawUsage["prompt_tokens"],
      "usage.prompt_tokens",
    );
    const totalTokens = optionalNonNegativeInteger(rawUsage["total_tokens"], "usage.total_tokens");
    usage = {
      ...(promptTokens === undefined ? {} : { prompt_tokens: promptTokens }),
      ...(totalTokens === undefined ? {} : { total_tokens: totalTokens }),
    };
  }
  return {
    object: "list",
    model: root["model"],
    data,
    ...(usage === undefined ? {} : { usage }),
  };
}

function decodeBase64Float32(encoded: string, dimensions: number): Float32Array {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== dimensions * Float32Array.BYTES_PER_ELEMENT) {
    throw new EmbeddingVectorValidationError(
      `Base64 Embedding has ${bytes.length} bytes; expected ${dimensions * 4}`,
      { operation: "embedding-base64-decode", retryable: false },
    );
  }
  const values = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index++) {
    values[index] = bytes.readFloatLE(index * 4);
  }
  return values;
}

export function mapEmbeddingVectors(
  response: SiliconFlowEmbeddingResponse,
  inputCount: number,
  dimensions: number,
): readonly EmbeddingVector[] {
  if (response.data.length !== inputCount) {
    throw new ProviderResponseValidationError(
      `Embedding response returned ${response.data.length} vectors for ${inputCount} inputs`,
      { operation: "embedding-response-map", retryable: false },
    );
  }
  const vectors = new Array<EmbeddingVector | undefined>(inputCount);
  for (const item of response.data) {
    if (item["index"] >= inputCount || vectors[item["index"]] !== undefined) {
      throw new ProviderResponseValidationError(
        `Embedding response index ${item["index"]} is out of range or duplicated`,
        { operation: "embedding-response-map", retryable: false },
      );
    }
    const values =
      typeof item["embedding"] === "string"
        ? decodeBase64Float32(item["embedding"], dimensions)
        : item["embedding"];
    vectors[item["index"]] = validateEmbeddingVector(values, dimensions, false);
  }
  if (vectors.some((vector) => vector === undefined)) {
    throw new ProviderResponseValidationError("Embedding response indexes are incomplete", {
      operation: "embedding-response-map",
      retryable: false,
    });
  }
  return vectors as EmbeddingVector[];
}

export function parseRerankResponse(value: unknown): SiliconFlowRerankResponse {
  const root = object(value, "Rerank response");
  if (typeof root["id"] !== "string" || !Array.isArray(root["results"])) {
    throw new ProviderResponseValidationError("Rerank response requires id and results", {
      operation: "provider-response-validate",
      retryable: false,
    });
  }
  const results = root["results"].map((raw, position) => {
    const item = object(raw, `Rerank results[${position}]`);
    if (!Number.isSafeInteger(item["index"]) || (item["index"] as number) < 0) {
      throw new ProviderResponseValidationError(
        `Rerank results[${position}].index must be a non-negative integer`,
        { operation: "provider-response-validate", retryable: false },
      );
    }
    if (typeof item["relevance_score"] !== "number" || !Number.isFinite(item["relevance_score"])) {
      throw new ProviderResponseValidationError(
        `Rerank results[${position}].relevance_score must be finite`,
        { operation: "provider-response-validate", retryable: false },
      );
    }
    return {
      index: item["index"] as number,
      relevance_score: item["relevance_score"],
    };
  });
  return {
    id: root["id"],
    results,
    ...(root["meta"] === undefined ? {} : { meta: root["meta"] }),
  };
}

export function mapRerankItems(
  response: SiliconFlowRerankResponse,
  documents: readonly RerankDocument[],
): readonly RerankItem[] {
  const seen = new Set<number>();
  return response.results.map((item) => {
    const document = documents[item["index"]];
    if (document === undefined || seen.has(item["index"])) {
      throw new ProviderResponseValidationError(
        `Rerank response index ${item["index"]} is out of range or duplicated`,
        { operation: "rerank-response-map", retryable: false },
      );
    }
    seen.add(item["index"]);
    return {
      documentId: document.id,
      originalIndex: item["index"],
      relevanceScore: item["relevance_score"],
    };
  });
}
