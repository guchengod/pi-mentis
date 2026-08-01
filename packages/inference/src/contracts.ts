import type { OperationOptions } from "@pi-mentis/pi-mentis-core";

export type { EmbeddingSpaceIdentity } from "@pi-mentis/pi-mentis-core";

export type EmbeddingInputKind = "query" | "document" | "code" | "capability" | "memory";
export type EmbeddingDimension = number;

export interface ModelIdentity {
  readonly providerId: string;
  readonly modelId: string;
  readonly capabilityVersion: string;
}

export interface TokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface ProviderHealth {
  readonly status: "healthy" | "degraded" | "unavailable";
  readonly checkedAt: number;
  readonly latencyMs?: number;
  readonly reason?: string;
}

export interface InferenceOperationOptions extends OperationOptions {
  readonly timeoutMs?: number;
  readonly priority?: "interactive" | "background";
}

export interface EmbeddingRequest {
  readonly inputs: readonly string[];
  readonly inputKind: EmbeddingInputKind;
  readonly dimensions: EmbeddingDimension;
  readonly truncate?: "left" | "right" | "reject";
}

export interface EmbeddingVector {
  readonly values: Float32Array;
  readonly dimensions: EmbeddingDimension;
  readonly normalized: boolean;
}

export interface EmbeddingResponse {
  readonly model: ModelIdentity;
  readonly vectors: readonly EmbeddingVector[];
  readonly usage?: TokenUsage;
  readonly traceId?: string;
}

export interface EmbeddingModelCapabilities {
  readonly model: ModelIdentity;
  readonly supportedDimensions: readonly number[];
  readonly defaultDimensions: number;
  readonly supportsDimensionSelection: boolean;
  readonly maxInputTokens: number;
  readonly maxBatchItems?: number;
  readonly maxBatchTokens?: number;
  readonly supportsBase64Encoding: boolean;
  readonly supportsTruncation: boolean;
  readonly inputKinds: readonly EmbeddingInputKind[];
}

export interface EmbeddingProviderCapabilities {
  readonly models: readonly EmbeddingModelCapabilities[];
}

export interface EmbeddingProvider {
  readonly id: string;
  capabilities(): Promise<EmbeddingProviderCapabilities>;
  embed(request: EmbeddingRequest, options?: InferenceOperationOptions): Promise<EmbeddingResponse>;
  health(options?: InferenceOperationOptions): Promise<ProviderHealth>;
}

export interface EmbeddingService {
  embedQuery(
    text: string,
    dimensions: EmbeddingDimension,
    options?: InferenceOperationOptions,
  ): Promise<EmbeddingVector>;
  embedDocuments(
    texts: readonly string[],
    dimensions: EmbeddingDimension,
    options?: InferenceOperationOptions,
  ): Promise<readonly EmbeddingVector[]>;
}

export interface RerankDocument {
  readonly id: string;
  readonly text: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly tokenCount?: number;
}

export interface RerankRequest {
  readonly query: string;
  readonly documents: readonly RerankDocument[];
  readonly topN: number;
  readonly instruction?: string;
  readonly maxInputTokens?: number;
}

export interface RerankItem {
  readonly documentId: string;
  readonly originalIndex: number;
  readonly relevanceScore: number;
}

export interface RerankResponse {
  readonly model: ModelIdentity;
  readonly items: readonly RerankItem[];
  readonly usage?: TokenUsage;
  readonly traceId?: string;
}

export interface RerankModelCapabilities {
  readonly model: ModelIdentity;
  readonly maxInputTokens: number;
  readonly maxDocuments?: number;
  readonly supportsInstruction: boolean;
  readonly supportsDocumentChunking: boolean;
  readonly supportsOverlapTokens: boolean;
  readonly maxOverlapTokens?: number;
  readonly contentKinds: readonly ("text" | "image")[];
}

export interface RerankProviderCapabilities {
  readonly models: readonly RerankModelCapabilities[];
}

export interface RerankProvider {
  readonly id: string;
  capabilities(): Promise<RerankProviderCapabilities>;
  rerank(request: RerankRequest, options?: InferenceOperationOptions): Promise<RerankResponse>;
  health(options?: InferenceOperationOptions): Promise<ProviderHealth>;
}

export interface InferenceDiagnostics {
  readonly providerId: string;
  readonly modelId: string;
  readonly operation: "embedding" | "rerank";
  readonly durationMs: number;
  readonly traceId?: string;
  readonly degraded?: string;
}
