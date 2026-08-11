import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ZVecCreateAndOpen,
  ZVecIndexType,
  ZVecInitialize,
  ZVecLogLevel,
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
  assertActiveEmbeddingGenerationsCompatible,
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

const ROOT_ACCESS_GATES_SYMBOL = Symbol.for("@pi-mentis/pi-mentis/zvec-root-access-gates/v1");

interface RootAccessGate {
  tail: Promise<void>;
}

type RootAccessGlobal = typeof globalThis & {
  [ROOT_ACCESS_GATES_SYMBOL]?: Map<string, RootAccessGate>;
};

async function acquireLocalRootAccess(rootDir: string): Promise<() => void> {
  const target = globalThis as RootAccessGlobal;
  const gates = target[ROOT_ACCESS_GATES_SYMBOL] ?? new Map<string, RootAccessGate>();
  target[ROOT_ACCESS_GATES_SYMBOL] = gates;
  const gate = gates.get(rootDir) ?? { tail: Promise.resolve() };
  gates.set(rootDir, gate);
  const previous = gate.tail;
  let release!: () => void;
  gate.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  return release;
}

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

export interface ZvecCoordinationStatus {
  readonly rootDir: string;
  readonly lockTarget: string;
  readonly localPid: number;
  readonly localStartedAt: number;
  readonly waitingOperations: number;
  readonly localActiveMode?: "read" | "write";
  readonly lastAcquiredAt?: number;
  readonly lastReleasedAt?: number;
  readonly storeOwnerPid?: number;
  readonly storeOwnerStartedAt?: number;
  readonly storeOwnerMode?: "read" | "write";
  readonly storeOwnerAcquiredAt?: number;
  readonly storeOwnerActive: boolean;
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
  /** Bumped every time collections are closed so in-flight opens can detect
   *  that their handle belongs to a closed era and must not be cached. */
  #collectionEra = 0;
  #manifest?: ActiveIndexManifest;
  #lockTarget = "";
  #ownerTarget = "";
  #inWriteGuard = false;
  #accessGuardGate: Promise<void> = Promise.resolve();
  readonly #startedAt = Date.now();
  #waitingOperations = 0;
  #activeMode: "read" | "write" | undefined;
  #lastAcquiredAt: number | undefined;
  #lastReleasedAt: number | undefined;
  #compromised = false;
  #compromiseError: Error | undefined;

  constructor(config: StorageConfig) {
    this.#config = config;
  }

  get rootDir(): string {
    return this.#config.rootDir;
  }

  get isCompromised(): boolean {
    return this.#compromised;
  }

  get compromiseError(): Error | undefined {
    return this.#compromiseError;
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
    ZVecInitialize({ logLevel: ZVecLogLevel.ERROR });
    await mkdir(this.#config.rootDir, { recursive: true, mode: 0o700 });
    const lockTarget = path.join(this.#config.rootDir, ".writer");
    const handle = await open(lockTarget, "a", 0o600);
    await handle.close();
    this.#lockTarget = lockTarget;
    this.#ownerTarget = path.join(this.#config.rootDir, ".store-owner.json");

    const existing = await this.#withReadGuard(() => readActiveManifest(this.#config.rootDir));
    if (existing !== undefined) {
      assertActiveEmbeddingGenerationsCompatible(existing, initialSpaces);
      this.#manifest = existing;
      return;
    }
    if (this.#config.readOnly) {
      throw new StorageCorruptionError("Read-only store has no active index manifest", {
        operation: "manifest-initialize",
        retryable: false,
      });
    }
    await this.#withWriteGuard(async () => {
      const fresh = await readActiveManifest(this.#config.rootDir);
      if (fresh !== undefined) {
        this.#manifest = fresh;
        return;
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
    });
  }

  async close(): Promise<void> {
    await this.#accessGuardGate;
    await Promise.allSettled(this.#openingCollections.values());
    this.#closeAllCollections();
  }

  async upsertScalar(
    collectionName: ScalarCollectionName,
    records: readonly StoredRecord[],
  ): Promise<void> {
    if (records.length === 0) return;
    return this.#withWriteGuard(async () => {
      const collection = await this.#scalarCollection(collectionName);
      assertStatuses(collection.upsertSync(records.map(scalarInput)), "zvec-scalar-upsert");
    });
  }

  async fetchScalar(
    collectionName: ScalarCollectionName,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>>>> {
    if (ids.length === 0) return new Map();
    return this.#withReadGuard(async () => {
      const collection = await this.#tryScalarCollection(collectionName);
      if (collection === undefined) return new Map();
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
    });
  }

  async filterScalar(
    collectionName: ScalarCollectionName,
    filter: string,
    topK = 10_000,
  ): Promise<readonly ZVecDoc[]> {
    return this.#withReadGuard(async () => {
      const collection = await this.#tryScalarCollection(collectionName);
      if (collection === undefined) return [];
      return (
        await collection.query({
          filter,
          topk: topK,
          includeVector: false,
          outputFields: ["payload", "kind", "namespace", "status", "created_at", "updated_at"],
        })
      ).map(logicalDocument);
    });
  }

  async deleteScalar(collectionName: ScalarCollectionName, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    return this.#withWriteGuard(async () => {
      const collection = await this.#scalarCollection(collectionName);
      assertStatuses(collection.deleteSync(ids.map(physicalDocumentId)), "zvec-scalar-delete");
    });
  }

  async upsertVectors(
    kind: GenerationKind,
    records: readonly StoredVectorRecord[],
    generationId?: string,
  ): Promise<void> {
    if (records.length === 0) return;
    return this.#withWriteGuard(async () => {
      const targetGeneration = generationId ?? activeGenerationFor(this.manifest, kind);
      const collection = await this.#vectorCollection(kind, targetGeneration);
      assertStatuses(collection.upsertSync(records.map(vectorInput)), "zvec-vector-upsert");
      collection.optimizeSync();
    });
  }

  async deleteVectors(
    kind: GenerationKind,
    ids: readonly string[],
    generationId?: string,
  ): Promise<void> {
    if (ids.length === 0) return;
    return this.#withWriteGuard(async () => {
      const targetGeneration = generationId ?? activeGenerationFor(this.manifest, kind);
      const collection = await this.#vectorCollection(kind, targetGeneration);
      assertStatuses(collection.deleteSync(ids.map(physicalDocumentId)), "zvec-vector-delete");
    });
  }

  async vectorSearch(options: VectorSearchOptions): Promise<readonly ZVecDoc[]> {
    return this.#withReadGuard(async () => {
      const generationId = options.generationId ?? activeGenerationFor(this.manifest, options.kind);
      const collection = await this.#tryVectorCollection(options.kind, generationId);
      if (collection === undefined) return [];
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
          params: {
            indexType: ZVecIndexType.HNSW,
            ef: Math.max(200, options.topK * 10),
            isUsingRefiner: true,
          },
        })
      ).map(logicalDocument);
    });
  }

  async ftsSearch(options: FtsSearchOptions): Promise<readonly ZVecDoc[]> {
    return this.#withReadGuard(async () => {
      const generationId = activeGenerationFor(this.manifest, options.kind);
      const collection = await this.#tryVectorCollection(options.kind, generationId);
      if (collection === undefined) return [];
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
          params: { indexType: ZVecIndexType.FTS, defaultOperator: "AND" },
        })
      ).map(logicalDocument);
    });
  }

  async fetchVectors(
    kind: GenerationKind,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, ZVecDoc>> {
    if (ids.length === 0) return new Map();
    return this.#withReadGuard(async () => {
      const collection = await this.#tryVectorCollection(
        kind,
        activeGenerationFor(this.manifest, kind),
      );
      if (collection === undefined) return new Map();
      const physicalIds = ids.map(physicalDocumentId);
      const documents = collection.fetchSync({ ids: physicalIds, includeVector: true });
      const result = new Map<string, ZVecDoc>();
      for (const [index, id] of ids.entries()) {
        const document = documents[physicalIds[index] ?? ""];
        if (document !== undefined) result.set(id, logicalDocument(document));
      }
      return result;
    });
  }

  async filterVectors(
    kind: GenerationKind,
    filter: string,
    topK = 10_000,
    generationId?: string,
  ): Promise<readonly ZVecDoc[]> {
    return this.#withReadGuard(async () => {
      const targetGeneration = generationId ?? activeGenerationFor(this.manifest, kind);
      const collection = await this.#tryVectorCollection(kind, targetGeneration);
      if (collection === undefined) return [];
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
    });
  }

  async createGeneration(
    kind: GenerationKind,
    generationId: string,
    embeddingSpace: EmbeddingSpaceIdentity,
    now = Date.now(),
  ): Promise<EmbeddingIndexGeneration> {
    return this.#withWriteGuard(async () => {
      if (
        this.manifest.generations.some((generation) => generation.generationId === generationId)
      ) {
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
    });
  }

  async setGenerationState(
    generationId: string,
    state: Exclude<GenerationState, "active" | "superseded">,
    failure?: string,
    now = Date.now(),
  ): Promise<void> {
    return this.#withWriteGuard(async () => {
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
    });
  }

  async activateGeneration(
    kind: GenerationKind,
    generationId: string,
    now = Date.now(),
  ): Promise<void> {
    return this.#withWriteGuard(async () => {
      this.#manifest = replaceActiveGeneration(this.manifest, kind, generationId, now);
      await writeActiveManifest(this.#config.rootDir, this.#manifest);
    });
  }

  async rollbackGeneration(kind: GenerationKind, generationId: string): Promise<void> {
    return this.#withWriteGuard(async () => {
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
    });
  }

  async collectSupersededGenerations(retentionMs: number, now = Date.now()): Promise<number> {
    return this.#withWriteGuard(async () => {
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
    });
  }

  async coordinationStatus(): Promise<ZvecCoordinationStatus> {
    let owner:
      | {
          readonly pid?: number;
          readonly startedAt?: number;
          readonly mode?: "read" | "write";
          readonly acquiredAt?: number;
        }
      | undefined;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#ownerTarget, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        owner = parsed as typeof owner;
      }
    } catch {
      owner = undefined;
    }
    const storeOwnerActive =
      this.#lockTarget.length > 0
        ? await lockfile.check(this.#lockTarget, { realpath: false }).catch(() => false)
        : false;
    return {
      rootDir: this.#config.rootDir,
      lockTarget: this.#lockTarget,
      localPid: process.pid,
      localStartedAt: this.#startedAt,
      waitingOperations: this.#waitingOperations,
      ...(this.#activeMode === undefined ? {} : { localActiveMode: this.#activeMode }),
      ...(this.#lastAcquiredAt === undefined ? {} : { lastAcquiredAt: this.#lastAcquiredAt }),
      ...(this.#lastReleasedAt === undefined ? {} : { lastReleasedAt: this.#lastReleasedAt }),
      ...(typeof owner?.pid === "number" ? { storeOwnerPid: owner.pid } : {}),
      ...(typeof owner?.startedAt === "number" ? { storeOwnerStartedAt: owner.startedAt } : {}),
      ...(owner?.mode === "read" || owner?.mode === "write" ? { storeOwnerMode: owner.mode } : {}),
      ...(typeof owner?.acquiredAt === "number" ? { storeOwnerAcquiredAt: owner.acquiredAt } : {}),
      storeOwnerActive,
    };
  }

  async #withReadGuard<T>(fn: () => Promise<T>): Promise<T> {
    return this.#withStoreGuard("read", fn);
  }

  async #withWriteGuard<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#config.readOnly) {
      throw new StorageBusyError("Cannot write to read-only configured store", {
        operation: "storage-write",
        retryable: false,
      });
    }
    return this.#withStoreGuard("write", fn);
  }

  async #withStoreGuard<T>(mode: "read" | "write", fn: () => Promise<T>): Promise<T> {
    if (this.#compromised) {
      throw new StorageBusyError(
        "Store ownership lease has been compromised — access is blocked until recovery",
        { operation: "storage-access", retryable: true },
      );
    }
    const gate = this.#accessGuardGate;
    let releaseGate!: () => void;
    this.#accessGuardGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    this.#waitingOperations += 1;
    await gate;
    this.#waitingOperations -= 1;
    const releaseLocalRoot = await acquireLocalRootAccess(this.#config.rootDir);
    try {
      // A cold Zvec open can legitimately take longer than the normal 5 s
      // storage-operation budget. Waiting is safe because the owner metadata
      // and stale lease still make a crashed owner recoverable after 10 s.
      // Keep these two policies separate: extending contention wait time must
      // not make crash recovery wait proportionally longer.
      const lockWaitMs = Math.max(30_000, this.#config.lockTimeoutMs);
      const release = await lockfile.lock(this.#lockTarget, {
        realpath: false,
        stale: Math.max(10_000, this.#config.lockTimeoutMs * 2),
        retries: {
          retries: Math.max(0, Math.ceil(lockWaitMs / 100)),
          minTimeout: 100,
          maxTimeout: 100,
        },
        onCompromised: (err: Error) => {
          this.#compromised = true;
          this.#compromiseError = err;
        },
      });
      try {
        this.#activeMode = mode;
        this.#inWriteGuard = mode === "write";
        this.#lastAcquiredAt = Date.now();
        this.#closeAllCollections();
        const existing = await readActiveManifest(this.#config.rootDir);
        if (existing !== undefined) {
          this.#manifest = existing;
        }
        await writeFile(
          this.#ownerTarget,
          `${JSON.stringify({
            pid: process.pid,
            startedAt: this.#startedAt,
            acquiredAt: this.#lastAcquiredAt,
            mode,
          })}\n`,
          { mode: 0o600 },
        );
        return await fn();
      } finally {
        this.#inWriteGuard = false;
        this.#activeMode = undefined;
        this.#closeAllCollections();
        await unlink(this.#ownerTarget).catch(() => undefined);
        try {
          await release();
        } catch {
          // Lock release failure must not propagate.
        }
        this.#lastReleasedAt = Date.now();
      }
    } finally {
      releaseLocalRoot();
      releaseGate();
    }
  }

  #closeAllCollections(): void {
    for (const collection of this.#collections.values()) collection.closeSync();
    this.#collections.clear();
    this.#openingCollections.clear();
    this.#collectionEra++;
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

  async #tryScalarCollection(name: ScalarCollectionName): Promise<ZVecCollection | undefined> {
    const existing = this.#collections.get(name);
    if (existing !== undefined) return existing;
    if (!(await exists(path.join(this.#config.rootDir, name)))) return undefined;
    return this.#openCollectionOnce(name, () => scalarCollectionSchema(name));
  }

  async #tryVectorCollection(
    kind: GenerationKind,
    generationId: string,
  ): Promise<ZVecCollection | undefined> {
    const name = generationCollectionName(kind, generationId);
    const existing = this.#collections.get(name);
    if (existing !== undefined) return existing;
    if (!(await exists(path.join(this.#config.rootDir, name)))) return undefined;
    const generation = this.manifest.generations.find(
      (candidate) => candidate.generationId === generationId && candidate.kind === kind,
    );
    if (generation === undefined) return undefined;
    return this.#openCollectionOnce(name, () =>
      vectorCollectionSchema(name, generation.embeddingSpace.dimensions),
    );
  }

  async #openCollectionOnce(
    name: string,
    schema: () => ReturnType<typeof scalarCollectionSchema>,
    retries = 0,
  ): Promise<ZVecCollection> {
    const existing = this.#collections.get(name);
    if (existing !== undefined) return existing;
    const pending = this.#openingCollections.get(name);
    if (pending !== undefined) return pending;
    const target = path.join(this.#config.rootDir, name);
    const eraAtOpen = this.#collectionEra;
    const writableAtOpen = this.#inWriteGuard;
    const opening = this.#openCollection(target, schema).then(async (collection) => {
      if (this.#collectionEra === eraAtOpen && this.#inWriteGuard === writableAtOpen) {
        this.#collections.set(name, collection);
        return collection;
      }
      // A write-guard boundary closed all collections while this open was
      // in flight, or the read-only/read-write mode changed. The handle
      // belongs to a stale era: close it and open a fresh one against the
      // CURRENT mode.
      collection.closeSync();
      if (retries >= 5) {
        throw new StorageCorruptionError(
          `Unable to open Zvec collection ${target}: collection era kept changing`,
          { operation: "zvec-open", retryable: true },
        );
      }
      return this.#openCollectionOnce(name, schema, retries + 1);
    });
    this.#openingCollections.set(name, opening);
    try {
      return await opening;
    } finally {
      if (this.#openingCollections.get(name) === opening) {
        this.#openingCollections.delete(name);
      }
    }
  }

  async #openCollection(
    target: string,
    schema: () => ReturnType<typeof scalarCollectionSchema>,
  ): Promise<ZVecCollection> {
    const effectiveReadOnly = this.#config.readOnly || !this.#inWriteGuard;
    try {
      if (await exists(target)) {
        return ZVecOpen(target, { readOnly: effectiveReadOnly, enableMMAP: true });
      }
      if (effectiveReadOnly) {
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
