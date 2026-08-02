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
import { stableHash } from "@pi-mentis/pi-mentis-core";

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
    id: physicalDocumentId(record.id),
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

// Zvec accepts only a restricted document-id alphabet. Domain ids are intentionally richer
// (for example `temporal-saga:<hash>`), so keep those ids in the payload and use a stable,
// collision-resistant physical id at the storage boundary. Existing compatible ids remain
// unchanged so already-published collections stay readable without an eager migration.
function physicalDocumentId(id: string): string {
  return /^[A-Za-z0-9-]+$/u.test(id) ? id : stableHash("zvec-document-id:v1", id);
}

function logicalDocument(document: ZVecDoc): ZVecDoc {
  const payload = parsePayload(document);
  const logicalId = payload["id"] ?? payload["jobId"] ?? payload["traceId"];
  return typeof logicalId === "string" ? { ...document, id: logicalId } : document;
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
  readonly #openingCollections = new Map<string, Promise<ZVecCollection>>();
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
    await Promise.allSettled(this.#openingCollections.values());
    this.#openingCollections.clear();
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
    const physicalIds = ids.map(physicalDocumentId);
    const documents = collection.fetchSync({
      ids: physicalIds,
      outputFields: ["payload"],
      includeVector: false,
    });
    const result = new Map<string, Readonly<Record<string, unknown>>>();
    for (const [index, id] of ids.entries()) {
      const document = documents[physicalIds[index] ?? ""];
      if (document !== undefined) result.set(id, parsePayload(document));
    }
    return result;
  }

  async filterScalar(
    collectionName: ScalarCollectionName,
    filter: string,
    topK = 10_000,
  ): Promise<readonly ZVecDoc[]> {
    const collection = await this.#scalarCollection(collectionName);
    return (
      await collection.query({
        filter,
        topk: topK,
        includeVector: false,
        outputFields: ["payload", "kind", "namespace", "status", "created_at", "updated_at"],
      })
    ).map(logicalDocument);
  }

  async deleteScalar(collectionName: ScalarCollectionName, ids: readonly string[]): Promise<void> {
    this.#assertWritable();
    if (ids.length === 0) return;
    const collection = await this.#scalarCollection(collectionName);
    assertStatuses(collection.deleteSync(ids.map(physicalDocumentId)), "zvec-scalar-delete");
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
    assertStatuses(collection.deleteSync(ids.map(physicalDocumentId)), "zvec-vector-delete");
  }

  async vectorSearch(options: VectorSearchOptions): Promise<readonly ZVecDoc[]> {
    const generationId = options.generationId ?? activeGenerationFor(this.manifest, options.kind);
    const collection = await this.#vectorCollection(options.kind, generationId);
    return (
      await collection.query({
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
      })
    ).map(logicalDocument);
  }

  async ftsSearch(options: FtsSearchOptions): Promise<readonly ZVecDoc[]> {
    const generationId = activeGenerationFor(this.manifest, options.kind);
    const collection = await this.#vectorCollection(options.kind, generationId);
    return (
      await collection.query({
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
      })
    ).map(logicalDocument);
  }

  async fetchVectors(
    kind: GenerationKind,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, ZVecDoc>> {
    if (ids.length === 0) return new Map();
    const collection = await this.#vectorCollection(kind, activeGenerationFor(this.manifest, kind));
    const physicalIds = ids.map(physicalDocumentId);
    const documents = collection.fetchSync({ ids: physicalIds, includeVector: true });
    const result = new Map<string, ZVecDoc>();
    for (const [index, id] of ids.entries()) {
      const document = documents[physicalIds[index] ?? ""];
      if (document !== undefined) result.set(id, logicalDocument(document));
    }
    return result;
  }

  async filterVectors(
    kind: GenerationKind,
    filter: string,
    topK = 10_000,
    generationId = activeGenerationFor(this.manifest, kind),
  ): Promise<readonly ZVecDoc[]> {
    const collection = await this.#vectorCollection(kind, generationId);
    return (
      await collection.query({
        filter,
        topk: topK,
        includeVector: false,
        outputFields: [
          "payload",
          "source_id",
          "document_id",
          "content_hash",
          "namespace",
          "status",
        ],
      })
    ).map(logicalDocument);
  }

  async createGeneration(
    kind: GenerationKind,
    generationId: string,
    embeddingSpace: EmbeddingSpaceIdentity,
    now = Date.now(),
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
      createdAt: now,
    };
    this.#manifest = {
      ...this.manifest,
      generations: [...this.manifest.generations, generation],
      updatedAt: now,
    };
    await this.#vectorCollection(kind, generationId);
    await writeActiveManifest(this.#config.rootDir, this.#manifest);
    return generation;
  }

  async setGenerationState(
    generationId: string,
    state: Exclude<GenerationState, "active" | "superseded">,
    failure?: string,
    now = Date.now(),
  ): Promise<void> {
    this.#assertWritable();
    this.#manifest = {
      ...this.manifest,
      generations: this.manifest.generations.map((generation) =>
        generation.generationId === generationId
          ? { ...generation, state, ...(failure === undefined ? {} : { failure }) }
          : generation,
      ),
      updatedAt: now,
    };
    await writeActiveManifest(this.#config.rootDir, this.#manifest);
  }

  async activateGeneration(
    kind: GenerationKind,
    generationId: string,
    now = Date.now(),
  ): Promise<void> {
    this.#assertWritable();
    this.#manifest = replaceActiveGeneration(this.manifest, kind, generationId, now);
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

  async collectSupersededGenerations(retentionMs: number, now = Date.now()): Promise<number> {
    this.#assertWritable();
    const active = new Set([
      this.manifest.knowledgeGeneration,
      this.manifest.memoryGeneration,
      this.manifest.capabilityGeneration,
    ]);
    const expired = this.manifest.generations.filter(
      (generation) =>
        generation.state === "superseded" &&
        !active.has(generation.generationId) &&
        generation.supersededAt !== undefined &&
        generation.supersededAt + Math.max(0, retentionMs) <= now,
    );
    for (const generation of expired) {
      const name = generationCollectionName(generation.kind, generation.generationId);
      const target = path.join(this.#config.rootDir, name);
      const cached = this.#collections.get(name);
      if (cached !== undefined) {
        cached.destroySync();
        this.#collections.delete(name);
      } else if (await exists(target)) {
        ZVecOpen(target, { readOnly: false, enableMMAP: true }).destroySync();
      }
    }
    if (expired.length > 0) {
      const expiredIds = new Set(expired.map((generation) => generation.generationId));
      this.#manifest = {
        ...this.manifest,
        generations: this.manifest.generations.filter(
          (generation) => !expiredIds.has(generation.generationId),
        ),
        updatedAt: now,
      };
      await writeActiveManifest(this.#config.rootDir, this.#manifest);
    }
    return expired.length;
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
    return this.#openCollectionOnce(name, () => scalarCollectionSchema(name));
  }

  async #vectorCollection(kind: GenerationKind, generationId: string): Promise<ZVecCollection> {
    const name = generationCollectionName(kind, generationId);
    const existing = this.#collections.get(name);
    if (existing !== undefined) return existing;
    const generation = this.manifest.generations.find(
      (candidate) => candidate.generationId === generationId && candidate.kind === kind,
    );
    if (generation === undefined) throw new Error(`Unknown ${kind} generation ${generationId}`);
    return this.#openCollectionOnce(name, () =>
      vectorCollectionSchema(name, generation.embeddingSpace.dimensions),
    );
  }

  async #openCollectionOnce(
    name: string,
    schema: () => ReturnType<typeof scalarCollectionSchema>,
  ): Promise<ZVecCollection> {
    const pending = this.#openingCollections.get(name);
    if (pending !== undefined) return pending;
    const target = path.join(this.#config.rootDir, name);
    const opening = this.#openCollection(target, schema).then((collection) => {
      this.#collections.set(name, collection);
      return collection;
    });
    this.#openingCollections.set(name, opening);
    try {
      return await opening;
    } finally {
      this.#openingCollections.delete(name);
    }
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
