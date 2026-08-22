import {
  ConfigurationError,
  ModelCapabilityMismatchError,
  ProviderAuthenticationError,
  ProviderProtocolError,
  type SiliconFlowConfig,
} from "@pi-mentis/pi-mentis-core";
import {
  assertSupportedEmbeddingDimension,
  getVerifiedEmbeddingModel,
  getVerifiedRerankModel,
  type EmbeddingProvider,
  type EmbeddingProviderCapabilities,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type InferenceOperationOptions,
  type ProviderHealth,
  type RerankProvider,
  type RerankProviderCapabilities,
  type RerankRequest,
  type RerankResponse,
} from "@pi-mentis/pi-mentis-inference";

import { getJson, postJson, ProviderRequestGate } from "./http.js";
import {
  mapEmbeddingVectors,
  mapRerankItems,
  parseEmbeddingResponse,
  parseRerankResponse,
  type SiliconFlowEmbeddingRequest,
  type SiliconFlowRerankRequest,
} from "./wire.js";

export class SiliconFlowProvider {
  readonly id = "siliconflow";
  readonly #config: SiliconFlowConfig;
  readonly #apiKey: string;
  readonly #embeddingCapability: ReturnType<typeof getVerifiedEmbeddingModel> | undefined;
  readonly #rerankCapability: ReturnType<typeof getVerifiedRerankModel> | undefined;
  readonly #mode: "both" | "embedding" | "rerank";
  readonly #requestGate: ProviderRequestGate;

  constructor(
    config: SiliconFlowConfig,
    environment: NodeJS.ProcessEnv = process.env,
    mode: "both" | "embedding" | "rerank" = "both",
  ) {
    this.#config = config;
    this.#mode = mode;
    this.#requestGate = new ProviderRequestGate(config.rateLimits);
    const apiKey = environment[config.apiKeyEnv];
    if (apiKey === undefined || apiKey.trim() === "") {
      throw new ProviderAuthenticationError(
        `SiliconFlow credential environment variable ${config.apiKeyEnv} is not set`,
        {
          operation: "provider-initialize",
          provider: this.id,
          retryable: false,
        },
      );
    }
    this.#apiKey = apiKey;
    this.#embeddingCapability =
      mode === "rerank" ? undefined : getVerifiedEmbeddingModel(config.embedding.model);
    this.#rerankCapability =
      mode === "embedding" ? undefined : getVerifiedRerankModel(config.rerank.model);
    if (this.#embeddingCapability !== undefined) {
      assertSupportedEmbeddingDimension(this.#embeddingCapability, config.embedding.dimensions);
    }
    if (
      (this.#rerankCapability !== undefined && config.rerank.maxInputTokens < 8_192) ||
      (this.#rerankCapability !== undefined &&
        config.rerank.maxInputTokens > this.#rerankCapability.maxInputTokens)
    ) {
      throw new ModelCapabilityMismatchError(
        `Configured Rerank context ${config.rerank.maxInputTokens} is outside the verified model limit`,
        {
          operation: "provider-initialize",
          provider: this.id,
          model: config.rerank.model,
          retryable: false,
        },
      );
    }
    if (
      this.#rerankCapability !== undefined &&
      (config.rerank.maxChunksPerDoc !== undefined || config.rerank.overlapTokens !== undefined) &&
      !this.#rerankCapability.supportsDocumentChunking
    ) {
      throw new ModelCapabilityMismatchError(
        `${config.rerank.model} does not support provider-side document chunking`,
        {
          operation: "provider-initialize",
          provider: this.id,
          model: config.rerank.model,
          retryable: false,
        },
      );
    }
  }

  embeddingCapabilities(): EmbeddingProviderCapabilities {
    if (this.#embeddingCapability === undefined) {
      throw new ModelCapabilityMismatchError("Embedding is not enabled for this provider", {
        operation: "provider-capabilities",
        provider: this.id,
        retryable: false,
      });
    }
    return { models: [this.#embeddingCapability] };
  }

  rerankCapabilities(): RerankProviderCapabilities {
    if (this.#rerankCapability === undefined) {
      throw new ModelCapabilityMismatchError("Rerank is not enabled for this provider", {
        operation: "provider-capabilities",
        provider: this.id,
        retryable: false,
      });
    }
    return { models: [this.#rerankCapability] };
  }

  async embed(
    request: EmbeddingRequest,
    options: InferenceOperationOptions = {},
  ): Promise<EmbeddingResponse> {
    const capability = this.#embeddingCapability;
    if (capability === undefined) {
      throw new ModelCapabilityMismatchError("Embedding is not enabled for this provider", {
        operation: "embedding",
        provider: this.id,
        retryable: false,
      });
    }
    if (request.inputs.length === 0 || request.inputs.some((input) => input.length === 0)) {
      throw new ConfigurationError("Embedding inputs must be non-empty", {
        operation: "embedding",
        provider: this.id,
        model: this.#config.embedding.model,
        retryable: false,
      });
    }
    assertSupportedEmbeddingDimension(capability, request.dimensions);
    const truncate = request.truncate ?? this.#config.embedding.truncate;
    const body: SiliconFlowEmbeddingRequest = {
      model: this.#config.embedding.model,
      input: request.inputs,
      encoding_format: this.#config.embedding.encodingFormat,
      ...(capability.supportsDimensionSelection ? { dimensions: request.dimensions } : {}),
      ...(truncate === "reject" ? {} : { truncate }),
    };
    const result = await this.#requestGate.run(
      request.inputs.reduce((sum, input) => sum + Buffer.byteLength(input, "utf8"), 0),
      options.signal,
      () =>
        postJson(
          `${this.#config.baseUrl.replace(/\/$/, "")}/embeddings`,
          this.#apiKey,
          body as unknown as Readonly<Record<string, unknown>>,
          {
            providerId: this.id,
            modelId: this.#config.embedding.model,
            operation: "embedding",
            timeoutMs: options.timeoutMs ?? this.#config.timeout.embeddingMs,
            maxAttempts: this.#config.retry.maxAttempts,
            baseDelayMs: this.#config.retry.baseDelayMs,
            maxDelayMs: this.#config.retry.maxDelayMs,
            dimensions: request.dimensions,
            inputCount: request.inputs.length,
            estimatedTokens: request.inputs.reduce(
              (sum, input) => sum + Buffer.byteLength(input.normalize("NFKC"), "utf8"),
              0,
            ),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
        ),
    );
    const response = parseEmbeddingResponse(result.value);
    if (response.model !== this.#config.embedding.model) {
      throw new ModelCapabilityMismatchError(
        `SiliconFlow returned Embedding model ${response.model}; expected ${this.#config.embedding.model}`,
        {
          operation: "embedding-response-validate",
          provider: this.id,
          model: response.model,
          retryable: false,
        },
      );
    }
    const vectors = mapEmbeddingVectors(response, request.inputs.length, request.dimensions);
    return {
      model: capability.model,
      vectors,
      ...(response.usage === undefined
        ? {}
        : {
            usage: {
              ...(response.usage.prompt_tokens === undefined
                ? {}
                : { inputTokens: response.usage.prompt_tokens }),
              ...(response.usage.total_tokens === undefined
                ? {}
                : { totalTokens: response.usage.total_tokens }),
            },
          }),
      ...(result.traceId === undefined ? {} : { traceId: result.traceId }),
    };
  }

  async rerank(
    request: RerankRequest,
    options: InferenceOperationOptions = {},
  ): Promise<RerankResponse> {
    const capability = this.#rerankCapability;
    if (capability === undefined) {
      throw new ModelCapabilityMismatchError("Rerank is not enabled for this provider", {
        operation: "rerank",
        provider: this.id,
        retryable: false,
      });
    }
    if (
      request.query.length === 0 ||
      request.documents.length === 0 ||
      request.topN < 1 ||
      request.topN > request.documents.length
    ) {
      throw new ConfigurationError("Rerank request has invalid query, documents, or topN", {
        operation: "rerank",
        provider: this.id,
        model: this.#config.rerank.model,
        retryable: false,
      });
    }
    if (request.instruction !== undefined && !capability.supportsInstruction) {
      throw new ModelCapabilityMismatchError(
        `${this.#config.rerank.model} does not support Rerank instructions`,
        {
          operation: "rerank",
          provider: this.id,
          model: this.#config.rerank.model,
          retryable: false,
        },
      );
    }
    const body: SiliconFlowRerankRequest = {
      model: this.#config.rerank.model,
      query: request.query,
      documents: request.documents.map((document) => document.text),
      top_n: request.topN,
      return_documents: false,
      ...(request.instruction === undefined ? {} : { instruction: request.instruction }),
      ...(this.#config.rerank.maxChunksPerDoc === undefined
        ? {}
        : { max_chunks_per_doc: this.#config.rerank.maxChunksPerDoc }),
      ...(this.#config.rerank.overlapTokens === undefined
        ? {}
        : { overlap_tokens: this.#config.rerank.overlapTokens }),
    };
    const result = await this.#requestGate.run(
      Buffer.byteLength(request.query, "utf8") +
        request.documents.reduce(
          (sum, document) => sum + Buffer.byteLength(document.text, "utf8"),
          0,
        ),
      options.signal,
      () =>
        postJson(
          `${this.#config.baseUrl.replace(/\/$/, "")}/rerank`,
          this.#apiKey,
          body as unknown as Readonly<Record<string, unknown>>,
          {
            providerId: this.id,
            modelId: this.#config.rerank.model,
            operation: "rerank",
            timeoutMs: options.timeoutMs ?? this.#config.timeout.rerankMs,
            maxAttempts: this.#config.retry.maxAttempts,
            baseDelayMs: this.#config.retry.baseDelayMs,
            maxDelayMs: this.#config.retry.maxDelayMs,
            documentCount: request.documents.length,
            estimatedTokens:
              Buffer.byteLength(request.query.normalize("NFKC"), "utf8") +
              (request.instruction === undefined
                ? 0
                : Buffer.byteLength(request.instruction.normalize("NFKC"), "utf8")) +
              request.documents.reduce(
                (sum, document) => sum + Buffer.byteLength(document.text.normalize("NFKC"), "utf8"),
                0,
              ),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
        ),
    );
    const response = parseRerankResponse(result.value);
    return {
      model: capability.model,
      items: mapRerankItems(response, request.documents),
      ...(result.traceId === undefined ? {} : { traceId: result.traceId }),
    };
  }

  async health(options: InferenceOperationOptions = {}): Promise<ProviderHealth> {
    const started = performance.now();
    try {
      if (this.#mode === "rerank") {
        await this.rerank(
          {
            query: "health",
            documents: [{ id: "health", text: "health" }],
            topN: 1,
          },
          { ...options, timeoutMs: Math.min(options.timeoutMs ?? 5_000, 5_000) },
        );
      } else {
        await this.embed(
          {
            inputs: ["health"],
            inputKind: "query",
            dimensions: this.#config.embedding.dimensions,
            truncate: "reject",
          },
          { ...options, timeoutMs: Math.min(options.timeoutMs ?? 5_000, 5_000) },
        );
      }
      return {
        status: "healthy",
        checkedAt: Date.now(),
        latencyMs: performance.now() - started,
      };
    } catch (error: unknown) {
      return {
        status: "unavailable",
        checkedAt: Date.now(),
        latencyMs: performance.now() - started,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export class SiliconFlowEmbeddingProvider implements EmbeddingProvider {
  readonly id = "siliconflow";
  readonly #client: SiliconFlowProvider;

  constructor(config: SiliconFlowConfig, environment: NodeJS.ProcessEnv = process.env) {
    this.#client = new SiliconFlowProvider(config, environment, "embedding");
  }

  capabilities(): Promise<EmbeddingProviderCapabilities> {
    return Promise.resolve(this.#client.embeddingCapabilities());
  }

  embed(
    request: EmbeddingRequest,
    options?: InferenceOperationOptions,
  ): Promise<EmbeddingResponse> {
    return this.#client.embed(request, options);
  }

  health(options?: InferenceOperationOptions): Promise<ProviderHealth> {
    return this.#client.health(options);
  }
}

export class SiliconFlowRerankProvider implements RerankProvider {
  readonly id = "siliconflow";
  readonly #client: SiliconFlowProvider;

  constructor(config: SiliconFlowConfig, environment: NodeJS.ProcessEnv = process.env) {
    this.#client = new SiliconFlowProvider(config, environment, "rerank");
  }

  capabilities(): Promise<RerankProviderCapabilities> {
    return Promise.resolve(this.#client.rerankCapabilities());
  }

  rerank(request: RerankRequest, options?: InferenceOperationOptions): Promise<RerankResponse> {
    return this.#client.rerank(request, options);
  }

  health(options?: InferenceOperationOptions): Promise<ProviderHealth> {
    return this.#client.health(options);
  }
}

/** Control-plane health checks kept inside the provider package, outside Pi capture. */
export class SiliconFlowConnectionTester {
  readonly #embedding: SiliconFlowEmbeddingProvider;
  readonly #reranker: SiliconFlowRerankProvider;
  readonly #config: SiliconFlowConfig;

  constructor(config: SiliconFlowConfig, environment: NodeJS.ProcessEnv = process.env) {
    this.#config = config;
    this.#embedding = new SiliconFlowEmbeddingProvider(config, environment);
    this.#reranker = new SiliconFlowRerankProvider(config, environment);
  }

  async testEmbedding(): Promise<void> {
    await this.#embedding.embed({
      inputs: ["pi-mentis provider health check"],
      inputKind: "query",
      dimensions: this.#config.embedding.dimensions,
      truncate: "reject",
    });
  }

  async testRerank(): Promise<void> {
    await this.#reranker.rerank({
      query: "health",
      documents: [{ id: "health", text: "health" }],
      topN: 1,
    });
  }
}

export type SiliconFlowModelSubtype = "embedding" | "reranker";

/** Fetches the account-visible model catalog without exposing the credential to IPC or TUI code. */
export class SiliconFlowModelCatalog {
  readonly #config: SiliconFlowConfig;
  readonly #apiKey: string;

  constructor(config: SiliconFlowConfig, environment: NodeJS.ProcessEnv = process.env) {
    this.#config = config;
    const apiKey = environment[config.apiKeyEnv];
    if (apiKey === undefined || apiKey.trim() === "") {
      throw new ProviderAuthenticationError("SiliconFlow credential is not configured", {
        operation: "models",
        provider: "siliconflow",
        retryable: false,
      });
    }
    this.#apiKey = apiKey;
  }

  async list(subtype: SiliconFlowModelSubtype): Promise<readonly string[]> {
    const url = new URL(`${this.#config.baseUrl.replace(/\/$/u, "")}/models`);
    url.searchParams.set("sub_type", subtype);
    const value = await getJson(url.toString(), this.#apiKey, {
      providerId: "siliconflow",
      operation: "models",
      timeoutMs: Math.max(this.#config.timeout.embeddingMs, this.#config.timeout.rerankMs),
    });
    if (typeof value !== "object" || value === null || !("data" in value)) {
      throw new ProviderProtocolError("SiliconFlow models response is missing data", {
        operation: "models",
        provider: "siliconflow",
        retryable: false,
      });
    }
    const data = (value as { readonly data?: unknown }).data;
    if (!Array.isArray(data)) {
      throw new ProviderProtocolError("SiliconFlow models data is not an array", {
        operation: "models",
        provider: "siliconflow",
        retryable: false,
      });
    }
    return [
      ...new Set(
        data
          .slice(0, 2_000)
          .map((item) =>
            typeof item === "object" && item !== null && "id" in item
              ? (item as { readonly id?: unknown }).id
              : undefined,
          )
          .filter(
            (id): id is string => typeof id === "string" && id.trim() !== "" && id.length <= 512,
          )
          .map((id) => id.trim()),
      ),
    ].sort((left, right) => left.localeCompare(right));
  }
}
