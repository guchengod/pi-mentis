import { ProviderAuthenticationError } from "@pi-mentis/pi-mentis-core";

import type {
  EmbeddingProvider,
  EmbeddingProviderCapabilities,
  EmbeddingRequest,
  EmbeddingResponse,
  InferenceOperationOptions,
  ProviderHealth,
  RerankProvider,
  RerankProviderCapabilities,
  RerankRequest,
  RerankResponse,
} from "./contracts.js";

function unavailable(): Error {
  return new ProviderAuthenticationError("Provider credential is not configured", {
    operation: "provider-runtime",
    provider: "siliconflow",
    retryable: false,
  });
}

export class ReloadableEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  #delegate: EmbeddingProvider | undefined;

  constructor(id: string) {
    this.id = id;
  }

  swap(delegate: EmbeddingProvider | undefined): void {
    this.#delegate = delegate;
  }

  capabilities(): Promise<EmbeddingProviderCapabilities> {
    if (this.#delegate === undefined) return Promise.reject(unavailable());
    return this.#delegate.capabilities();
  }

  embed(
    request: EmbeddingRequest,
    options?: InferenceOperationOptions,
  ): Promise<EmbeddingResponse> {
    if (this.#delegate === undefined) return Promise.reject(unavailable());
    return this.#delegate.embed(request, options);
  }

  health(options?: InferenceOperationOptions): Promise<ProviderHealth> {
    if (this.#delegate === undefined)
      return Promise.resolve({
        status: "unavailable",
        checkedAt: Date.now(),
        reason: "Credential is not configured",
      });
    return this.#delegate.health(options);
  }
}

export class ReloadableRerankProvider implements RerankProvider {
  readonly id: string;
  #delegate: RerankProvider | undefined;

  constructor(id: string) {
    this.id = id;
  }

  swap(delegate: RerankProvider | undefined): void {
    this.#delegate = delegate;
  }

  capabilities(): Promise<RerankProviderCapabilities> {
    if (this.#delegate === undefined) return Promise.reject(unavailable());
    return this.#delegate.capabilities();
  }

  rerank(request: RerankRequest, options?: InferenceOperationOptions): Promise<RerankResponse> {
    if (this.#delegate === undefined) return Promise.reject(unavailable());
    return this.#delegate.rerank(request, options);
  }

  health(options?: InferenceOperationOptions): Promise<ProviderHealth> {
    if (this.#delegate === undefined)
      return Promise.resolve({
        status: "unavailable",
        checkedAt: Date.now(),
        reason: "Credential is not configured",
      });
    return this.#delegate.health(options);
  }
}
