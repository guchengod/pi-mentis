import { mkdir, open, stat } from "node:fs/promises";
import path from "node:path";

import {
  ZVecCreateAndOpen,
  ZVecIndexType,
  ZVecOpen,
  isZVecError,
  type ZVecCollection,
  type ZVecDoc,
  type ZVecDocInput,
  type ZVecStatus,
} from "@zvec/zvec";
import lockfile from "proper-lockfile";
import {
  StorageBusyError,
  StorageCorruptionError,
  type EmbeddingSpaceIdentity,
  type StorageConfig,
} from "@pi-mentis/pi-mentis-core";

import {
  activeGenerationFor,
  readActiveManifest,
  replaceActiveGeneration,
  writeActiveManifest,
  type ActiveIndexManifest,
  type EmbeddingIndexGeneration,
  type GenerationState,
} from "./manifest.js";
import {
  generationCollectionName,
  scalarCollectionSchema,
  vectorCollectionSchema,
  type GenerationKind,
  type ScalarCollectionName,
} from "./schema.js";

export interface StoredRecord {
  readonly id: string;
  readonly kind: string;
  readonly namespace: string;
  readonly status: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface StoredVectorRecord extends StoredRecord {
  readonly searchableText: string;
  readonly contentHash: string;
  readonly sourceId: string;
  readonly documentId: string;
  readonly authority: number;
  readonly tokenCount: number;
  readonly revision: number;
  readonly embedding: Float32Array;
}

export interface VectorSearchOptions {
  readonly kind: GenerationKind;
  readonly vector: Float32Array;
  readonly topK: number;
  readonly filter?: string;
  readonly generationId?: string;
}

export interface FtsSearchOptions {
  readonly kind: GenerationKind;
  readonly query: string;
  readonly topK: number;
  readonly filter?: string;
}

function assertStatuses(statuses: ZVecStatus | readonly ZVecStatus[], operation: string): void {
  const list = Array.isArray(statuses) ? statuses : [statuses];
  const failure = list.find((status) => !status.ok);
  if (failure !== undefined) {
    throw new StorageCorruptionError(`${operation} failed: ${failure.code} ${failure.message}`, {
      operation,
      retryable: false,
    });
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    if (code === "ENOENT") return false;
    throw error;
  }
}

function scalarInput(record: StoredRecord): ZVecDocInput {
  return {
    id: record.id,
    fields: {
      kind: record.kind,
      namespace: record.namespace,
      status: record.status,
      payload: JSON.stringify(record.payload),
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    },
  };
}

function vectorInput(record: StoredVectorRecord): ZVecDocInput {
  return {
    ...scalarInput(record),
    vectors: { embedding: record.embedding },
    fields: {
      ...scalarInput(record).fields,
      searchable_text: record.searchableText,
      content_hash: record.contentHash,
      source_id: record.sourceId,
      document_id: record.documentId,
      authority: record.authority,
      token_count: record.tokenCount,
      revision: record.revision,
    },
  };
}

function parsePayload(document: ZVecDoc): Readonly<Record<string, unknown>> {
  const raw = document.fields["payload"];
  if (typeof raw !== "string") {
    throw new StorageCorruptionError(`Zvec document ${document.id} has no payload`, {
      operation: "zvec-document-decode",
      documentId: document.id,
      retryable: false,
    });
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StorageCorruptionError(`Zvec document ${document.id} payload is not an object`, {
      operation: "zvec-document-decode",
      documentId: document.id,
      retryable: false,
    });
  }
  return parsed as Readonly<Record<string, unknown>>;
}

export class ZvecStore {
  readonly #config: StorageConfig;
  readonly #collections = new Map<string, ZVecCollection>();
  #releaseLock: (() => Promise<void>) | undefined;
  #manifest?: ActiveIndexManifest;

  constructor(config: StorageConfig) {
    this.#config = config;
  }

  get rootDir(): string {
    return this.#config.rootDir;
  }

  get manifest(): ActiveIndexManifest {
    if (this.#manifest === undefined) {
      throw new Error("ZvecStore has not been started");
    }
    return this.#manifest;
  }

  async start(
    initialSpaces: Readonly<Record<GenerationKind, EmbeddingSpaceIdentity>>,
  ): Promise<void> {
    await mkdir(this.#config.rootDir, { recursive: true, mode: 0o700 });
    if (!this.#config.readOnly) {
      const lockTarget = path.join(this.#config.rootDir, ".writer");
      const handle = await open(lockTarget, "a", 0o600);
      await handle.close();
      try {
        this.#releaseLock = await lockfile.lock(lockTarget, {
          realpath: false,
          stale: Math.max(10_000, this.#config.lockTimeoutMs * 2),
          retries: {
            retries: Math.max(0, Math.ceil(this.#config.lockTimeoutMs / 100)),
            minTimeout: 100,
            maxTimeout: 100,
          },
        });
      } catch (error: unknown) {
        throw new StorageBusyError(
          `Another writer owns Pi Mentis storage at ${this.#config.rootDir}`,
          { operation: "storage-lock", retryable: true, cause: error },
        );
      }
    }
    const existing = await readActiveManifest(this.#config.rootDir);
    if (existing !== undefined) {
      this.#manifest = existing;
      return;
    }
    if (this.#config.readOnly) {
      throw new StorageCorruptionError("Read-only store has no active index manifest", {
        operation: "manifest-initialize",
        retryable: false,
      });
    }
    const createdAt = Date.now();
    const generations = (["knowledge", "memory", "capability"] as const).map((kind) => ({
      generationId: `initial_${kind}`,
      kind,
      embeddingSpace: initialSpaces[kind],
      state: "active" as const,
      createdAt,
      activatedAt: createdAt,
    }));
    this.#manifest = {
      schemaVersion: 1,
      knowledgeGeneration: "initial_knowledge",
      memoryGeneration: "initial_memory",
      capabilityGeneration: "initial_capability",
      generations,
      updatedAt: createdAt,
    };
    await writeActiveManifest(this.#config.rootDir, this.#manifest);
  }

  async close(): Promise<void> {
    for (const collection of this.#collections.values()) collection.closeSync();
    this.#collections.clear();
    await this.#releaseLock?.();
    this.#releaseLock = undefined;
  }

  async upsertScalar(
    collectionName: ScalarCollectionName,
    records: readonly StoredRecord[],
  ): Promise<void> {
    this.#assertWritable();
    if (records.length === 0) return;
    const collection = await this.#scalarCollection(collectionName);
    assertStatuses(collection.upsertSync(records.map(scalarInput)), "zvec-scalar-upsert");
  }

  async fetchScalar(
    collectionName: ScalarCollectionName,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>>>> {
    if (ids.length === 0) return new Map();
    const collection = await this.#scalarCollection(collectionName);
    const documents = collection.fetchSync({
      ids: [...ids],
      outputFields: ["payload"],
      includeVector: false,
    });
    return new Map(Object.entries(documents).map(([id, document]) => [id, parsePayload(document)]));
  }

  async upsertVectors(
    kind: GenerationKind,
    records: readonly StoredVectorRecord[],
    generationId = activeGenerationFor(this.manifest, kind),
  ): Promise<void> {
    this.#assertWritable();
    if (records.length === 0) return;
    const collection = await this.#vectorCollection(kind, generationId);
    assertStatuses(collection.upsertSync(records.map(vectorInput)), "zvec-vector-upsert");
  }

  async deleteVectors(
    kind: GenerationKind,
    ids: readonly string[],
    generationId = activeGenerationFor(this.manifest, kind),
  ): Promise<void> {
    this.#assertWritable();
    if (ids.length === 0) return;
    const collection = await this.#vectorCollection(kind, generationId);
    assertStatuses(collection.deleteSync([...ids]), "zvec-vector-delete");
  }

  async vectorSearch(options: VectorSearchOptions): Promise<readonly ZVecDoc[]> {
    const generationId = options.generationId ?? activeGenerationFor(this.manifest, options.kind);
    const collection = await this.#vectorCollection(options.kind, generationId);
    return collection.query({
      fieldName: "embedding",
      vector: options.vector,
      topk: options.topK,
      includeVector: false,
      outputFields: [
        "payload",
        "searchable_text",
        "content_hash",
        "authority",
        "token_count",
        "namespace",
        "updated_at",
      ],
      ...(options.filter === undefined ? {} : { filter: options.filter }),
      params: { indexType: ZVecIndexType.HNSW, ef: Math.max(100, options.topK * 4) },
    });
  }

  async ftsSearch(options: FtsSearchOptions): Promise<readonly ZVecDoc[]> {
    const generationId = activeGenerationFor(this.manifest, options.kind);
    const collection = await this.#vectorCollection(options.kind, generationId);
    return collection.query({
      fieldName: "searchable_text",
      fts: { matchString: options.query },
      topk: options.topK,
      includeVector: false,
      outputFields: [
        "payload",
        "searchable_text",
        "content_hash",
        "authority",
        "token_count",
        "namespace",
        "updated_at",
      ],
      ...(options.filter === undefined ? {} : { filter: options.filter }),
      params: { indexType: ZVecIndexType.FTS, defaultOperator: "OR" },
    });
  }

  async fetchVectors(
    kind: GenerationKind,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, ZVecDoc>> {
    if (ids.length === 0) return new Map();
    const collection = await this.#vectorCollection(kind, activeGenerationFor(this.manifest, kind));
    const documents = collection.fetchSync({ ids: [...ids], includeVector: true });
    return new Map(Object.entries(documents));
  }

  async filterVectors(
    kind: GenerationKind,
    filter: string,
    topK = 10_000,
    generationId = activeGenerationFor(this.manifest, kind),
  ): Promise<readonly ZVecDoc[]> {
    const collection = await this.#vectorCollection(kind, generationId);
    return collection.query({
      filter,
      topk: topK,
      includeVector: false,
      outputFields: ["payload", "source_id", "document_id", "content_hash", "namespace", "status"],
    });
  }

  async createGeneration(
    kind: GenerationKind,
    generationId: string,
    embeddingSpace: EmbeddingSpaceIdentity,
  ): Promise<EmbeddingIndexGeneration> {
    this.#assertWritable();
    if (this.manifest.generations.some((generation) => generation.generationId === generationId)) {
      throw new Error(`Generation ${generationId} already exists`);
    }
    const generation: EmbeddingIndexGeneration = {
      generationId,
      kind,
      embeddingSpace,
      state: "preparing",
      createdAt: Date.now(),
    };
    this.#manifest = {
      ...this.manifest,
      generations: [...this.manifest.generations, generation],
      updatedAt: Date.now(),
    };
    await this.#vectorCollection(kind, generationId);
    await writeActiveManifest(this.#config.rootDir, this.#manifest);
    return generation;
  }

  async setGenerationState(
    generationId: string,
    state: Exclude<GenerationState, "active" | "superseded">,
    failure?: string,
  ): Promise<void> {
    this.#assertWritable();
    this.#manifest = {
      ...this.manifest,
      generations: this.manifest.generations.map((generation) =>
        generation.generationId === generationId
          ? { ...generation, state, ...(failure === undefined ? {} : { failure }) }
          : generation,
      ),
      updatedAt: Date.now(),
    };
    await writeActiveManifest(this.#config.rootDir, this.#manifest);
  }

  async activateGeneration(kind: GenerationKind, generationId: string): Promise<void> {
    this.#assertWritable();
    this.#manifest = replaceActiveGeneration(this.manifest, kind, generationId);
    await writeActiveManifest(this.#config.rootDir, this.#manifest);
  }

  async rollbackGeneration(kind: GenerationKind, generationId: string): Promise<void> {
    this.#assertWritable();
    const target = this.manifest.generations.find(
      (generation) => generation.generationId === generationId && generation.kind === kind,
    );
    if (target?.state !== "superseded") {
      throw new Error(`Generation ${generationId} is not available for rollback`);
    }
    this.#manifest = {
      ...this.manifest,
      generations: this.manifest.generations.map((generation) =>
        generation.generationId === generationId
          ? { ...generation, state: "validating" as const }
          : generation,
      ),
      updatedAt: Date.now(),
    };
    this.#manifest = replaceActiveGeneration(this.#manifest, kind, generationId);
    await writeActiveManifest(this.#config.rootDir, this.#manifest);
  }

  #assertWritable(): void {
    if (this.#config.readOnly) {
      throw new StorageBusyError("Pi Mentis storage is open read-only", {
        operation: "storage-write",
        retryable: false,
      });
    }
  }

  async #scalarCollection(name: ScalarCollectionName): Promise<ZVecCollection> {
    const existing = this.#collections.get(name);
    if (existing !== undefined) return existing;
    const target = path.join(this.#config.rootDir, name);
    const collection = await this.#openCollection(target, () => scalarCollectionSchema(name));
    this.#collections.set(name, collection);
    return collection;
  }

  async #vectorCollection(kind: GenerationKind, generationId: string): Promise<ZVecCollection> {
    const name = generationCollectionName(kind, generationId);
    const existing = this.#collections.get(name);
    if (existing !== undefined) return existing;
    const generation = this.manifest.generations.find(
      (candidate) => candidate.generationId === generationId && candidate.kind === kind,
    );
    if (generation === undefined) throw new Error(`Unknown ${kind} generation ${generationId}`);
    const target = path.join(this.#config.rootDir, name);
    const collection = await this.#openCollection(target, () =>
      vectorCollectionSchema(name, generation.embeddingSpace.dimensions),
    );
    this.#collections.set(name, collection);
    return collection;
  }

  async #openCollection(
    target: string,
    schema: () => ReturnType<typeof scalarCollectionSchema>,
  ): Promise<ZVecCollection> {
    try {
      if (await exists(target)) {
        return ZVecOpen(target, { readOnly: this.#config.readOnly, enableMMAP: true });
      }
      if (this.#config.readOnly) {
        throw new StorageCorruptionError(`Required Zvec collection does not exist: ${target}`, {
          operation: "zvec-open",
          retryable: false,
        });
      }
      return ZVecCreateAndOpen(target, schema(), { readOnly: false, enableMMAP: true });
    } catch (error: unknown) {
      if (error instanceof StorageCorruptionError) throw error;
      const detail = isZVecError(error) ? `${error.code}: ${error.message}` : String(error);
      throw new StorageCorruptionError(`Unable to open Zvec collection ${target}: ${detail}`, {
        operation: "zvec-open",
        retryable: false,
        cause: error,
      });
    }
  }
}

export function decodeStoredPayload(document: ZVecDoc): Readonly<Record<string, unknown>> {
  return parsePayload(document);
}
