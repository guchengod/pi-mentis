import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ConfigurationError } from "./errors.js";
import { assertStorageRootReady, resolveStorageRoot, globalConfigPath } from "./mentis-home.js";
import { PI_VERSION, isPiVersionSupported } from "./compatibility.js";

export interface EmbeddingBatchPolicy {
  readonly maxItems: number;
  readonly maxTokens: number;
  readonly maxWaitMs: number;
  readonly maxConcurrentBatches: number;
}

export interface SiliconFlowConfig {
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly embedding: {
    readonly model: string;
    readonly dimensions: number;
    readonly encodingFormat: "float" | "base64";
    readonly truncate: "left" | "right" | "reject";
  };
  readonly rerank: {
    readonly model: string;
    readonly maxInputTokens: number;
    readonly instruction?: string;
    readonly returnDocuments: false;
    readonly maxChunksPerDoc?: number;
    readonly overlapTokens?: number;
  };
  readonly timeout: {
    readonly embeddingMs: number;
    readonly rerankMs: number;
  };
  readonly retry: {
    readonly maxAttempts: number;
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
  };
  readonly rateLimits: {
    readonly concurrentRequests: number;
    readonly requestsPerSecond?: number;
    readonly tokensPerMinute?: number;
    readonly circuitFailureThreshold: number;
    readonly circuitOpenMs: number;
  };
}

export interface RuntimeConfig {
  readonly piVersion: string;
}

export interface KnowledgeConfig {
  readonly enabled: boolean;
  readonly defaultNamespace: string;
  readonly autoSync: boolean;
}

export interface MemoryConfig {
  readonly enabled: boolean;
  readonly captureEnabled: boolean;
  readonly turnEventLimit: number;
  readonly offload: {
    readonly inlineMaxBytes: number;
    readonly truncateMaxBytes: number;
    readonly previewBytes: number;
  };
}

export interface RetrievalConfig {
  readonly automaticRecall: boolean;
  readonly autoRecallSoftTimeoutMs: number;
  readonly autoRecallHardTimeoutMs: number;
  readonly manualSearchTimeoutMs: number;
  readonly maxManualSearchTimeoutMs: number;
  readonly contextTokens: number;
  readonly knowledgeTokens: number;
  readonly memoryTokens: number;
}

export interface InferenceConfig {
  readonly provider: "siliconflow";
  readonly siliconflow: SiliconFlowConfig;
  readonly embedding: {
    readonly required: true;
    readonly queryCacheEntries: number;
    readonly queryCacheTtlMs: number;
    readonly batch: EmbeddingBatchPolicy;
  };
  readonly rerank: {
    readonly enabled: boolean;
    readonly required: boolean;
    readonly candidateLimit: number;
    readonly fallbackEnabled: boolean;
    readonly cacheEntries: number;
    readonly cacheTtlMs: number;
  };
}

export interface ResourceLimits {
  readonly maxFileBytes: number;
  readonly maxWebPages: number;
  readonly maxWebBytes: number;
  readonly maxArchiveBytes: number;
  readonly maxArchiveEntries: number;
  readonly maxExpandedBytes: number;
  readonly maxDocumentTokens: number;
  readonly maxConcurrentParsers: number;
  readonly maxPendingEmbeddingTokens: number;
  readonly maxPendingRerankTokens: number;
  readonly maxRerankDocuments: number;
}

export interface StorageConfig {
  readonly rootDir: string;
  readonly readOnly: boolean;
  readonly lockTimeoutMs: number;
  readonly generationRetentionMs: number;
  readonly writeBatch: {
    readonly maxOperations: number;
    readonly maxBytes: number;
    readonly maxWaitMs: number;
  };
}

export interface PerformanceConfig {
  readonly cpuWorkers: number;
  readonly ioConcurrency: number;
  readonly providerConcurrency: number;
  readonly queue: {
    readonly maxQueuedTasks: number;
    readonly maxQueuedBytes: number;
    readonly maxActiveTasks: number;
    readonly maxQueuedTaskAgeMs: number;
    readonly maxPendingEmbeddingTokens: number;
    readonly maxPendingRerankTokens: number;
  };
  readonly resources: ResourceLimits;
}

export interface ObservabilityConfig {
  readonly enabled: boolean;
  readonly includeContentHashes: boolean;
  readonly logLevel: "silent" | "error" | "warn" | "info" | "debug";
}

export interface IntelligenceConfig {
  readonly context: {
    readonly persistSnapshots: boolean;
    readonly capabilityMaxAgeMs: number;
  };
  readonly temporal: {
    readonly enabled: true;
  };
  readonly views: {
    readonly enabled: boolean;
    readonly ttlMs: number;
  };
  readonly effectiveness: {
    readonly enabled: boolean;
    readonly flushIntervalMs: number;
    readonly maxBatch: number;
  };
  readonly adaptivePolicy: {
    readonly enabled: boolean;
    readonly cooldownMs: number;
  };
}

export interface PiMentisConfig {
  readonly runtime: RuntimeConfig;
  readonly knowledge: KnowledgeConfig;
  readonly memory: MemoryConfig;
  readonly retrieval: RetrievalConfig;
  readonly inference: InferenceConfig;
  readonly storage: StorageConfig;
  readonly performance: PerformanceConfig;
  readonly observability: ObservabilityConfig;
  readonly intelligence: IntelligenceConfig;
}

export interface EmbeddingRuntimeResolution {
  readonly configured: Readonly<{
    model: string;
    dimensions: number;
  }>;
  readonly effective: Readonly<{
    providerId: "siliconflow";
    model: string;
    dimensions: number;
  }>;
  /** Where the effective embedding model was selected. */
  readonly source: "config" | "environment" | "default";
  /** True only when an environment fallback actually selected the effective model. */
  readonly environmentOverrideActive: boolean;
}

const embeddingRuntimeResolutions = new WeakMap<PiMentisConfig, EmbeddingRuntimeResolution>();

export function getEmbeddingRuntimeResolution(config: PiMentisConfig): EmbeddingRuntimeResolution {
  return (
    embeddingRuntimeResolutions.get(config) ?? {
      configured: {
        model: config.inference.siliconflow.embedding.model,
        dimensions: config.inference.siliconflow.embedding.dimensions,
      },
      effective: {
        providerId: "siliconflow",
        model: config.inference.siliconflow.embedding.model,
        dimensions: config.inference.siliconflow.embedding.dimensions,
      },
      source: "default",
      environmentOverrideActive: false,
    }
  );
}

export function createDefaultConfig(
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): PiMentisConfig {
  void cwd;
  const storageRoot = resolveStorageRoot({ environment });
  const availableProcessors = globalThis.navigator?.hardwareConcurrency ?? 2;
  return {
    runtime: { piVersion: PI_VERSION },
    knowledge: {
      enabled: true,
      defaultNamespace: "user",
      autoSync: false,
    },
    memory: {
      enabled: true,
      captureEnabled: true,
      turnEventLimit: 256,
      offload: {
        inlineMaxBytes: 8 * 1024,
        truncateMaxBytes: 64 * 1024,
        previewBytes: 4 * 1024,
      },
    },
    retrieval: {
      automaticRecall: true,
      autoRecallSoftTimeoutMs: 300,
      autoRecallHardTimeoutMs: 800,
      manualSearchTimeoutMs: 3_000,
      maxManualSearchTimeoutMs: 10_000,
      contextTokens: 1_600,
      knowledgeTokens: 1_100,
      memoryTokens: 500,
    },
    inference: {
      provider: "siliconflow",
      siliconflow: {
        baseUrl: "https://api.siliconflow.cn/v1",
        apiKeyEnv: "SILICONFLOW_API_KEY",
        embedding: {
          model: "Qwen/Qwen3-Embedding-8B",
          dimensions: 1_024,
          encodingFormat: "float",
          truncate: "reject",
        },
        rerank: {
          model: "Qwen/Qwen3-Reranker-8B",
          maxInputTokens: 32_768,
          returnDocuments: false,
        },
        timeout: {
          embeddingMs: 15_000,
          rerankMs: 15_000,
        },
        retry: {
          maxAttempts: 3,
          baseDelayMs: 200,
          maxDelayMs: 3_000,
        },
        rateLimits: {
          concurrentRequests: 2,
          requestsPerSecond: 10,
          tokensPerMinute: 1_000_000,
          circuitFailureThreshold: 2,
          circuitOpenMs: 3_000,
        },
      },
      embedding: {
        required: true,
        queryCacheEntries: 512,
        queryCacheTtlMs: 300_000,
        batch: {
          maxItems: 32,
          maxTokens: 20_000,
          maxWaitMs: 50,
          maxConcurrentBatches: 2,
        },
      },
      rerank: {
        enabled: true,
        required: false,
        candidateLimit: 40,
        fallbackEnabled: true,
        cacheEntries: 256,
        cacheTtlMs: 60_000,
      },
    },
    storage: {
      rootDir: path.join(storageRoot.zvecRoot),
      readOnly: false,
      lockTimeoutMs: 5_000,
      generationRetentionMs: 7 * 24 * 60 * 60 * 1_000,
      writeBatch: {
        maxOperations: 256,
        maxBytes: 8 * 1024 * 1024,
        maxWaitMs: 20,
      },
    },
    performance: {
      cpuWorkers: Math.max(1, Math.min(4, availableProcessors - 1)),
      ioConcurrency: 8,
      providerConcurrency: 2,
      queue: {
        maxQueuedTasks: 2_000,
        maxQueuedBytes: 128 * 1024 * 1024,
        maxActiveTasks: 8,
        maxQueuedTaskAgeMs: 30 * 60_000,
        maxPendingEmbeddingTokens: 2_000_000,
        maxPendingRerankTokens: 1_000_000,
      },
      resources: {
        maxFileBytes: 128 * 1024 * 1024,
        maxWebPages: 1_000,
        maxWebBytes: 512 * 1024 * 1024,
        maxArchiveBytes: 512 * 1024 * 1024,
        maxArchiveEntries: 10_000,
        maxExpandedBytes: 2 * 1024 * 1024 * 1024,
        maxDocumentTokens: 2_000_000,
        maxConcurrentParsers: 4,
        maxPendingEmbeddingTokens: 2_000_000,
        maxPendingRerankTokens: 1_000_000,
        maxRerankDocuments: 100,
      },
    },
    observability: {
      enabled: true,
      includeContentHashes: true,
      logLevel: "warn",
    },
    intelligence: {
      context: { persistSnapshots: true, capabilityMaxAgeMs: 60_000 },
      temporal: { enabled: true },
      views: { enabled: true, ttlMs: 5 * 60_000 },
      effectiveness: { enabled: true, flushIntervalMs: 250, maxBatch: 64 },
      adaptivePolicy: { enabled: true, cooldownMs: 30 * 60_000 },
    },
  };
}

function requireRange(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(
      `${name} must be a finite number between ${minimum} and ${maximum}; received ${value}`,
      { operation: "configuration-validate", retryable: false },
    );
  }
}

export function validateConfig(config: PiMentisConfig): PiMentisConfig {
  if (!isPiVersionSupported(config.runtime.piVersion, PI_VERSION)) {
    throw new ConfigurationError(
      `runtime.piVersion must be at least ${PI_VERSION}; found ${config.runtime.piVersion}`,
      {
        operation: "configuration-validate",
        retryable: false,
      },
    );
  }
  if (config.intelligence.temporal.enabled !== true) {
    throw new ConfigurationError(
      "intelligence.temporal.enabled is a protected truth-safety invariant and must be true",
      { operation: "configuration-validate", retryable: false },
    );
  }
  requireRange(
    "inference.siliconflow.embedding.dimensions",
    config.inference.siliconflow.embedding.dimensions,
    768,
    4_096,
  );
  requireRange(
    "intelligence.context.capabilityMaxAgeMs",
    config.intelligence.context.capabilityMaxAgeMs,
    1_000,
    86_400_000,
  );
  requireRange("intelligence.views.ttlMs", config.intelligence.views.ttlMs, 1_000, 86_400_000);
  requireRange(
    "intelligence.effectiveness.flushIntervalMs",
    config.intelligence.effectiveness.flushIntervalMs,
    10,
    60_000,
  );
  requireRange(
    "intelligence.effectiveness.maxBatch",
    config.intelligence.effectiveness.maxBatch,
    1,
    1_024,
  );
  requireRange(
    "intelligence.adaptivePolicy.cooldownMs",
    config.intelligence.adaptivePolicy.cooldownMs,
    1_000,
    7 * 86_400_000,
  );
  requireRange(
    "inference.siliconflow.rerank.maxInputTokens",
    config.inference.siliconflow.rerank.maxInputTokens,
    8_192,
    32_768,
  );
  requireRange(
    "inference.siliconflow.rateLimits.concurrentRequests",
    config.inference.siliconflow.rateLimits.concurrentRequests,
    1,
    64,
  );
  requireRange(
    "retrieval.autoRecallSoftTimeoutMs",
    config.retrieval.autoRecallSoftTimeoutMs,
    1,
    config.retrieval.autoRecallHardTimeoutMs,
  );
  requireRange(
    "retrieval.manualSearchTimeoutMs",
    config.retrieval.manualSearchTimeoutMs,
    1,
    config.retrieval.maxManualSearchTimeoutMs,
  );
  requireRange("memory.offload.inlineMaxBytes", config.memory.offload.inlineMaxBytes, 256, 1e9);
  requireRange(
    "memory.offload.truncateMaxBytes",
    config.memory.offload.truncateMaxBytes,
    config.memory.offload.inlineMaxBytes,
    1e9,
  );
  requireRange("memory.offload.previewBytes", config.memory.offload.previewBytes, 128, 1e7);
  requireRange(
    "performance.queue.maxQueuedTaskAgeMs",
    config.performance.queue.maxQueuedTaskAgeMs,
    1_000,
    7 * 86_400_000,
  );
  requireRange(
    "performance.resources.maxWebPages",
    config.performance.resources.maxWebPages,
    1,
    10_000,
  );
  requireRange(
    "performance.resources.maxWebBytes",
    config.performance.resources.maxWebBytes,
    config.performance.resources.maxFileBytes,
    config.performance.resources.maxExpandedBytes,
  );
  if (
    config.retrieval.knowledgeTokens + config.retrieval.memoryTokens >
    config.retrieval.contextTokens
  ) {
    throw new ConfigurationError(
      "Knowledge and memory token budgets exceed the total retrieval context budget",
      { operation: "configuration-validate", retryable: false },
    );
  }
  if (!/^[A-Z_][A-Z0-9_]*$/.test(config.inference.siliconflow.apiKeyEnv)) {
    throw new ConfigurationError("siliconflow.apiKeyEnv must name an environment variable", {
      operation: "configuration-validate",
      retryable: false,
    });
  }
  const baseUrl = new URL(config.inference.siliconflow.baseUrl);
  if (baseUrl.protocol !== "https:" && baseUrl.hostname !== "localhost") {
    throw new ConfigurationError("SiliconFlow base URL must use HTTPS except for localhost", {
      operation: "configuration-validate",
      retryable: false,
    });
  }
  return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeConfiguration(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key];
    merged[key] =
      isRecord(existing) && isRecord(value) ? mergeConfiguration(existing, value) : value;
  }
  return merged;
}

function optionalEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  ...names: readonly string[]
): string | undefined {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

function optionalEnvironmentInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
): number | undefined {
  const value = optionalEnvironmentValue(environment, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ConfigurationError(`${name} must be an integer; received ${value}`, {
      operation: "configuration-environment",
      retryable: false,
    });
  }
  return parsed;
}

function hasConfiguredPath(value: Record<string, unknown>, path: readonly string[]): boolean {
  let current: unknown = value;
  for (const segment of path) {
    if (!isRecord(current) || !(segment in current)) return false;
    current = current[segment];
  }
  return true;
}

function applySiliconFlowEnvironmentFallback(
  config: PiMentisConfig,
  override: Record<string, unknown> | undefined,
  environment: NodeJS.ProcessEnv,
): PiMentisConfig {
  const hasConfigured = (path: readonly string[]) =>
    override !== undefined && hasConfiguredPath(override, path);
  const configuredBaseUrl = hasConfigured(["inference", "siliconflow", "baseUrl"]);
  const configuredEmbeddingModel = hasConfigured([
    "inference",
    "siliconflow",
    "embedding",
    "model",
  ]);
  const configuredEmbeddingDimensions = hasConfigured([
    "inference",
    "siliconflow",
    "embedding",
    "dimensions",
  ]);
  const configuredRerankModel = hasConfigured(["inference", "siliconflow", "rerank", "model"]);
  const hasConfiguredRerankContext = hasConfigured([
    "inference",
    "siliconflow",
    "rerank",
    "maxInputTokens",
  ]);
  const baseUrl =
    (configuredBaseUrl
      ? undefined
      : optionalEnvironmentValue(environment, "SILICONFLOW_BASE_URL")) ??
    config.inference.siliconflow.baseUrl;
  const environmentEmbeddingModel = configuredEmbeddingModel
    ? undefined
    : optionalEnvironmentValue(environment, "SILICONFLOW_EMBEDDING_MODEL");
  const embeddingModel = environmentEmbeddingModel ?? config.inference.siliconflow.embedding.model;
  const configuredDimensions = optionalEnvironmentInteger(
    environment,
    "SILICONFLOW_EMBEDDING_DIMENSIONS",
  );
  const embeddingDimensions =
    (configuredEmbeddingDimensions ? undefined : configuredDimensions) ??
    (!configuredEmbeddingModel && environmentEmbeddingModel === "BAAI/bge-m3" ? 1_024 : undefined);
  const rerankModel =
    (configuredRerankModel
      ? undefined
      : optionalEnvironmentValue(
          environment,
          "SILICONFLOW_RERANK_MODEL",
          "SILICONFLOW_RERANKER_MODEL",
        )) ?? config.inference.siliconflow.rerank.model;
  const environmentRerankContext = optionalEnvironmentInteger(
    environment,
    "SILICONFLOW_RERANK_MAX_INPUT_TOKENS",
  );
  const rerankMaxInputTokens =
    (hasConfiguredRerankContext ? undefined : environmentRerankContext) ??
    (!configuredRerankModel && rerankModel === "BAAI/bge-reranker-v2-m3" ? 8_192 : undefined);
  return {
    ...config,
    inference: {
      ...config.inference,
      siliconflow: {
        ...config.inference.siliconflow,
        baseUrl,
        embedding: {
          ...config.inference.siliconflow.embedding,
          model: embeddingModel,
          ...(embeddingDimensions === undefined ? {} : { dimensions: embeddingDimensions }),
        },
        rerank: {
          ...config.inference.siliconflow.rerank,
          model: rerankModel,
          ...(rerankMaxInputTokens === undefined ? {} : { maxInputTokens: rerankMaxInputTokens }),
        },
      },
    },
  };
}

function resolveEmbeddingRuntime(
  configured: PiMentisConfig,
  effective: PiMentisConfig,
  override: Record<string, unknown> | undefined,
): EmbeddingRuntimeResolution {
  const configuredModel = hasConfiguredPath(override ?? {}, [
    "inference",
    "siliconflow",
    "embedding",
    "model",
  ]);
  const model = effective.inference.siliconflow.embedding.model;
  const dimensions = effective.inference.siliconflow.embedding.dimensions;
  const environmentSelected =
    !configuredModel &&
    (model !== configured.inference.siliconflow.embedding.model ||
      dimensions !== configured.inference.siliconflow.embedding.dimensions);
  return {
    configured: {
      model: configured.inference.siliconflow.embedding.model,
      dimensions: configured.inference.siliconflow.embedding.dimensions,
    },
    effective: {
      providerId: "siliconflow",
      model,
      dimensions,
    },
    source: configuredModel ? "config" : environmentSelected ? "environment" : "default",
    environmentOverrideActive: environmentSelected,
  };
}

function freezeConfig<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeConfig(child);
  }
  return value;
}

function finalizeConfig(
  configured: PiMentisConfig,
  override: Record<string, unknown> | undefined,
  environment: NodeJS.ProcessEnv,
): PiMentisConfig {
  const effective = validateConfig(
    applySiliconFlowEnvironmentFallback(configured, override, environment),
  );
  const frozen = freezeConfig(effective);
  embeddingRuntimeResolutions.set(frozen, resolveEmbeddingRuntime(configured, frozen, override));
  return frozen;
}

export async function loadConfig(
  _cwd: string,
  filename?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PiMentisConfig> {
  const storageRoot = resolveStorageRoot({ environment });
  if (filename === undefined) assertStorageRootReady(storageRoot);
  const resolvedFilename = filename ?? globalConfigPath({ environment });
  const defaults = createDefaultConfig(_cwd, environment);
  let override: unknown;
  try {
    override = JSON.parse(await readFile(resolvedFilename, "utf8")) as unknown;
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    if (code === "ENOENT") {
      const resolved = finalizeConfig(defaults, undefined, environment);
      await mkdir(path.dirname(resolvedFilename), { recursive: true, mode: 0o700 });
      await writeFile(resolvedFilename, JSON.stringify(resolved, null, 2), { mode: 0o600 });
      return resolved;
    }
    throw new ConfigurationError(`Unable to read Pi Mentis config ${resolvedFilename}`, {
      operation: "configuration-load",
      retryable: false,
      cause: error,
    });
  }
  if (!isRecord(override)) {
    throw new ConfigurationError("Pi Mentis configuration root must be an object", {
      operation: "configuration-load",
      retryable: false,
    });
  }
  const merged = mergeConfiguration(
    defaults as unknown as Record<string, unknown>,
    override,
  ) as unknown as PiMentisConfig;
  return finalizeConfig(merged, override, environment);
}
