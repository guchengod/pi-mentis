import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import path from "node:path";

import {
  loadConfig,
  validateConfig,
  type PiMentisConfig,
  type SiliconFlowConfig,
} from "@pi-mentis/pi-mentis-core";
import { getVerifiedEmbeddingModel, getVerifiedRerankModel } from "@pi-mentis/pi-mentis-inference";

export interface MentisProviderDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly credential: {
    readonly secretId: string;
    readonly envNames: readonly string[];
  };
  readonly defaults: {
    readonly endpoint: string;
    readonly embeddingModel: string;
    readonly rerankModel: string;
  };
  readonly capabilities: { readonly embeddings: boolean; readonly rerank: boolean };
}

export const SILICONFLOW_PROVIDER: MentisProviderDefinition = {
  id: "siliconflow",
  displayName: "SiliconFlow",
  credential: {
    secretId: "provider:siliconflow:default",
    envNames: ["SILICONFLOW_API_KEY"],
  },
  defaults: {
    endpoint: "https://api.siliconflow.cn/v1",
    embeddingModel: "Qwen/Qwen3-Embedding-8B",
    rerankModel: "Qwen/Qwen3-Reranker-8B",
  },
  capabilities: { embeddings: true, rerank: true },
};

export class ProviderRegistry {
  readonly #definitions: ReadonlyMap<string, MentisProviderDefinition>;

  constructor(definitions: readonly MentisProviderDefinition[] = [SILICONFLOW_PROVIDER]) {
    this.#definitions = new Map(definitions.map((definition) => [definition.id, definition]));
  }

  get(id: string): MentisProviderDefinition | undefined {
    return this.#definitions.get(id);
  }

  list(): readonly MentisProviderDefinition[] {
    return [...this.#definitions.values()];
  }
}

export interface SecretStore {
  readonly available: boolean;
  has(id: string): Promise<boolean>;
  get(id: string): Promise<string | undefined>;
  set(id: string, value: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export class UnsupportedSecretStore implements SecretStore {
  readonly available = false;
  has(): Promise<boolean> {
    return Promise.resolve(false);
  }
  get(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
  set(): Promise<void> {
    return Promise.reject(new Error("Secure storage is not available on this platform"));
  }
  delete(): Promise<void> {
    return Promise.resolve();
  }
}

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
  deletePassword(): boolean;
}

export type KeyringEntryFactory = (service: string, account: string) => Promise<KeyringEntry>;

const createKeyringEntry: KeyringEntryFactory = async (service, account) => {
  const { Entry } = await import("@napi-rs/keyring");
  return new Entry(service, account);
};

export class MacOSKeychainSecretStore implements SecretStore {
  readonly available = true;
  readonly #service: string;
  readonly #entryFactory: KeyringEntryFactory;

  constructor(service = "pi-mentis", entryFactory: KeyringEntryFactory = createKeyringEntry) {
    this.#service = service;
    this.#entryFactory = entryFactory;
  }

  async has(id: string): Promise<boolean> {
    try {
      const value = (await this.#entryFactory(this.#service, id)).getPassword();
      return value !== null && value.trim() !== "";
    } catch {
      return false;
    }
  }

  async get(id: string): Promise<string | undefined> {
    try {
      const value = (await this.#entryFactory(this.#service, id)).getPassword();
      return value === null || value.trim() === "" ? undefined : value;
    } catch {
      return undefined;
    }
  }

  async set(id: string, value: string): Promise<void> {
    if (value.trim() === "") throw new Error("Credential cannot be empty");
    try {
      (await this.#entryFactory(this.#service, id)).setPassword(value);
    } catch (error) {
      throw new Error("Unable to store credential in macOS Keychain", { cause: error });
    }
  }

  async delete(id: string): Promise<void> {
    // The native API returns false for an already-missing entry and throws for
    // real backend failures, which the settings UI must surface.
    (await this.#entryFactory(this.#service, id)).deletePassword();
  }
}

export function createPlatformSecretStore(): SecretStore {
  return platform() === "darwin" ? new MacOSKeychainSecretStore() : new UnsupportedSecretStore();
}

export type CredentialSource = "secure" | "environment" | "missing";

export interface CredentialResolution {
  readonly value?: string;
  readonly source: CredentialSource;
  readonly configured: boolean;
  readonly securePresent: boolean;
  readonly environmentPresent: boolean;
  readonly secureStorageAvailable: boolean;
}

function environmentCredential(
  definition: MentisProviderDefinition,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  for (const name of definition.credential.envNames) {
    const value = environment[name];
    if (value !== undefined && value.trim() !== "") return value;
  }
  return undefined;
}

export async function resolveCredential(
  definition: MentisProviderDefinition,
  store: SecretStore,
  environment: NodeJS.ProcessEnv = process.env,
  includeValue = true,
): Promise<CredentialResolution> {
  const environmentValue = environmentCredential(definition, environment);
  let securePresent = false;
  try {
    securePresent = store.available && (await store.has(definition.credential.secretId));
    if (securePresent) {
      const value = includeValue ? await store.get(definition.credential.secretId) : undefined;
      if (!includeValue || (value !== undefined && value.trim() !== "")) {
        return {
          ...(includeValue && value !== undefined ? { value } : {}),
          source: "secure",
          configured: true,
          securePresent: true,
          environmentPresent: environmentValue !== undefined,
          secureStorageAvailable: store.available,
        };
      }
      securePresent = false;
    }
  } catch {
    // Keychain unavailability is fail-open: preserve the legacy environment path.
  }
  if (environmentValue !== undefined) {
    return {
      ...(includeValue ? { value: environmentValue } : {}),
      source: "environment",
      configured: true,
      securePresent,
      environmentPresent: true,
      secureStorageAvailable: store.available,
    };
  }
  return {
    source: "missing",
    configured: false,
    securePresent,
    environmentPresent: false,
    secureStorageAvailable: store.available,
  };
}

export interface ProviderConfigDraft {
  readonly endpoint: string;
  readonly embeddingModel: string;
  readonly rerankModel: string;
}

export function providerDraft(config: PiMentisConfig): ProviderConfigDraft {
  return {
    endpoint: config.inference.siliconflow.baseUrl,
    embeddingModel: config.inference.siliconflow.embedding.model,
    rerankModel: config.inference.siliconflow.rerank.model,
  };
}

function applyDraft(config: PiMentisConfig, draft: ProviderConfigDraft): PiMentisConfig {
  const endpoint = draft.endpoint.trim().replace(/\/+$/u, "");
  const embeddingModel = draft.embeddingModel.trim();
  const rerankModel = draft.rerankModel.trim();
  if (endpoint === "" || embeddingModel === "" || rerankModel === "") {
    throw new Error("Endpoint and model identifiers must be non-empty");
  }
  const embeddingCapability = getVerifiedEmbeddingModel(embeddingModel);
  const embeddingDimensions = embeddingCapability.supportedDimensions.includes(
    config.inference.siliconflow.embedding.dimensions,
  )
    ? config.inference.siliconflow.embedding.dimensions
    : embeddingCapability.defaultDimensions;
  const rerankCapability = getVerifiedRerankModel(rerankModel);
  const rerankMaxInputTokens = Math.max(
    8_192,
    Math.min(config.inference.siliconflow.rerank.maxInputTokens, rerankCapability.maxInputTokens),
  );
  const {
    maxChunksPerDoc: configuredMaxChunksPerDoc,
    overlapTokens: configuredOverlapTokens,
    ...rerankBase
  } = config.inference.siliconflow.rerank;
  return validateConfig({
    ...config,
    inference: {
      ...config.inference,
      siliconflow: {
        ...config.inference.siliconflow,
        baseUrl: endpoint,
        embedding: {
          ...config.inference.siliconflow.embedding,
          model: embeddingModel,
          dimensions: embeddingDimensions,
        },
        rerank: {
          ...rerankBase,
          model: rerankModel,
          maxInputTokens: rerankMaxInputTokens,
          ...(rerankCapability.supportsDocumentChunking && configuredMaxChunksPerDoc !== undefined
            ? { maxChunksPerDoc: configuredMaxChunksPerDoc }
            : {}),
          ...(rerankCapability.supportsOverlapTokens && configuredOverlapTokens !== undefined
            ? { overlapTokens: configuredOverlapTokens }
            : {}),
        },
      },
    },
  });
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export class ProviderConfigStore {
  readonly #filename: string;

  constructor(filename: string) {
    this.#filename = filename;
  }

  async load(cwd: string, environment: NodeJS.ProcessEnv = process.env): Promise<PiMentisConfig> {
    return loadConfig(cwd, this.#filename, environment);
  }

  async save(
    cwd: string,
    draft: ProviderConfigDraft,
    environment: NodeJS.ProcessEnv = process.env,
  ): Promise<{ readonly config: PiMentisConfig; readonly revision: number }> {
    const current = await this.load(cwd, environment);
    const next = applyDraft(current, draft);
    let raw: Record<string, unknown> = {};
    try {
      raw = record(JSON.parse(await readFile(this.#filename, "utf8")) as unknown);
    } catch (error) {
      const code = record(error)["code"];
      if (code !== "ENOENT")
        throw new Error("Unable to read Mentis configuration", { cause: error });
    }
    const settings = record(raw["mentisSettings"]);
    const previousRevision =
      Number.isSafeInteger(settings["revision"]) && Number(settings["revision"]) >= 0
        ? Number(settings["revision"])
        : 0;
    const inference = record(raw["inference"]);
    const siliconflow = record(inference["siliconflow"]);
    const {
      apiKey: _legacyApiKey,
      authorization: _legacyAuthorization,
      credential: _legacyCredential,
      ...safeSiliconflow
    } = siliconflow;
    void _legacyApiKey;
    void _legacyAuthorization;
    void _legacyCredential;
    const embedding = record(siliconflow["embedding"]);
    const rerank = record(siliconflow["rerank"]);
    const {
      maxChunksPerDoc: _rawMaxChunksPerDoc,
      overlapTokens: _rawOverlapTokens,
      ...safeRerank
    } = rerank;
    void _rawMaxChunksPerDoc;
    void _rawOverlapTokens;
    const serialized = {
      ...raw,
      mentisSettings: { ...settings, version: 1, revision: previousRevision + 1 },
      inference: {
        ...inference,
        provider: "siliconflow",
        siliconflow: {
          ...safeSiliconflow,
          embedding: {
            ...embedding,
            model: next.inference.siliconflow.embedding.model,
            dimensions: next.inference.siliconflow.embedding.dimensions,
          },
          rerank: {
            ...safeRerank,
            model: next.inference.siliconflow.rerank.model,
            maxInputTokens: next.inference.siliconflow.rerank.maxInputTokens,
            ...(next.inference.siliconflow.rerank.maxChunksPerDoc === undefined
              ? {}
              : { maxChunksPerDoc: next.inference.siliconflow.rerank.maxChunksPerDoc }),
            ...(next.inference.siliconflow.rerank.overlapTokens === undefined
              ? {}
              : { overlapTokens: next.inference.siliconflow.rerank.overlapTokens }),
          },
        },
      },
    };
    const serializedText = `${JSON.stringify(serialized, null, 2)}\n`;
    const temporary = `${this.#filename}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(path.dirname(this.#filename), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, serializedText, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.#filename);
    } catch {
      await unlink(temporary).catch(() => undefined);
      throw new Error("Unable to save Mentis configuration");
    }
    return { config: next, revision: previousRevision + 1 };
  }
}

export function providerEnvironment(
  config: Pick<SiliconFlowConfig, "apiKeyEnv">,
  resolution: CredentialResolution,
): NodeJS.ProcessEnv {
  return resolution.value === undefined ? {} : { [config.apiKeyEnv]: resolution.value };
}

export interface SafeProviderError {
  readonly category:
    "authentication" | "permission" | "model" | "timeout" | "network" | "configuration" | "unknown";
  readonly message: string;
  readonly httpStatus?: number;
}

export function safeProviderError(error: unknown): SafeProviderError {
  const root = record(error);
  const context = record(root["context"]);
  const details = record(context["details"]);
  const code = typeof root["code"] === "string" ? root["code"] : "";
  const httpStatus = Number.isInteger(details["statusCode"])
    ? Number(details["statusCode"])
    : undefined;
  if (code === "PROVIDER_AUTHENTICATION" || httpStatus === 401)
    return {
      category: "authentication",
      message: "HTTP 401: credential rejected",
      httpStatus: 401,
    };
  if (code === "PROVIDER_PERMISSION" || httpStatus === 403)
    return {
      category: "permission",
      message: "HTTP 403: provider permission denied",
      httpStatus: 403,
    };
  if (code === "MODEL_NOT_FOUND" || httpStatus === 404)
    return {
      category: "model",
      message: "HTTP 404: configured model was not found",
      httpStatus: 404,
    };
  if (code === "PROVIDER_TIMEOUT")
    return { category: "timeout", message: "Provider request timed out" };
  if (["PROVIDER_UNAVAILABLE", "PROVIDER_OVERLOADED", "PROVIDER_RATE_LIMIT"].includes(code))
    return {
      category: "network",
      message: "Provider is temporarily unavailable",
      ...(httpStatus === undefined ? {} : { httpStatus }),
    };
  if (["CONFIGURATION_ERROR", "MODEL_CAPABILITY_MISMATCH"].includes(code))
    return { category: "configuration", message: "Provider configuration is invalid" };
  return { category: "unknown", message: "Provider operation failed" };
}
