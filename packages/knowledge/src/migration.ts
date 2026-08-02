import {
  BackgroundScheduler,
  EmbeddingMigrationError,
  TaskPriority,
  stableHash,
  systemClock,
  operationId,
  throwIfAborted,
  type Clock,
  type JobReceipt,
  type OperationOptions,
} from "@pi-mentis/pi-mentis-core";
import {
  embeddingSpaceId,
  type EmbeddingProvider,
  type EmbeddingSpaceIdentity,
} from "@pi-mentis/pi-mentis-inference";
import { ZvecStore, decodeStoredPayload, type StoredVectorRecord } from "@pi-mentis/pi-mentis-zvec";

export interface MigrationResult {
  readonly generationId: string;
  readonly migrated: number;
  readonly activated: boolean;
}

type MigrationJobState = "queued" | "leased" | "running" | "succeeded" | "failed" | "dead";

interface MigrationJob {
  readonly jobId: string;
  readonly state: MigrationJobState;
  readonly targetSpace: EmbeddingSpaceIdentity;
  readonly generationId: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: number;
  readonly result?: MigrationResult;
  readonly error?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface MigrationRecoveryResult {
  readonly inspected: number;
  readonly recovered: number;
  readonly dead: number;
}

export interface MigrateKnowledgeEmbeddingOptions extends OperationOptions {
  readonly generationId?: string;
  readonly clock?: Clock;
}

interface MigrationJobOptions extends OperationOptions {
  readonly clock?: Clock;
}

function withoutLease(job: MigrationJob): Omit<MigrationJob, "leaseOwner" | "leaseExpiresAt"> {
  const { leaseOwner: _owner, leaseExpiresAt: _expiry, ...rest } = job;
  void _owner;
  void _expiry;
  return rest;
}

function retryableMigrationError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("context" in error)) return true;
  const context = (error as { readonly context?: unknown }).context;
  if (typeof context !== "object" || context === null || !("retryable" in context)) return true;
  return (context as { readonly retryable?: unknown }).retryable !== false;
}

function decodeMigrationJob(payload: Readonly<Record<string, unknown>>): MigrationJob | undefined {
  if (
    typeof payload["jobId"] !== "string" ||
    typeof payload["state"] !== "string" ||
    !["queued", "leased", "running", "succeeded", "failed", "dead"].includes(payload["state"]) ||
    typeof payload["targetSpace"] !== "object" ||
    payload["targetSpace"] === null ||
    typeof payload["generationId"] !== "string" ||
    typeof payload["attempts"] !== "number" ||
    typeof payload["maxAttempts"] !== "number" ||
    typeof payload["createdAt"] !== "number" ||
    typeof payload["updatedAt"] !== "number"
  ) {
    return undefined;
  }
  return payload as unknown as MigrationJob;
}

async function persistMigrationJob(store: ZvecStore, job: MigrationJob): Promise<void> {
  await store.upsertScalar("jobs_v1", [
    {
      id: job.jobId,
      kind: "embedding-migration",
      namespace: "system:embedding-migration",
      status: job.state,
      payload: job as unknown as Readonly<Record<string, unknown>>,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    },
  ]);
}

function scheduleMigrationJob(
  store: ZvecStore,
  scheduler: BackgroundScheduler,
  embedding: EmbeddingProvider,
  initial: MigrationJob,
  clock: Clock,
  signal?: AbortSignal,
) {
  const workerId = `migration-worker:${operationId("operation")}`;
  return scheduler.schedule({
    id: initial.jobId,
    deduplicationKey: `embedding-migration:${embeddingSpaceId(initial.targetSpace)}`,
    priority: TaskPriority.Migration,
    estimatedBytes: 1,
    ...(signal === undefined ? {} : { signal }),
    run: async (runSignal) => {
      let job = initial;
      let lastError: unknown;
      while (job.attempts < job.maxAttempts) {
        throwIfAborted(runSignal, "embedding-migration-job");
        const leasedAt = clock.now();
        job = {
          ...withoutLease(job),
          state: "leased",
          attempts: job.attempts + 1,
          leaseOwner: workerId,
          leaseExpiresAt: leasedAt + 5 * 60_000,
          updatedAt: leasedAt,
        };
        await persistMigrationJob(store, job);
        job = { ...job, state: "running", updatedAt: clock.now() };
        await persistMigrationJob(store, job);
        try {
          const result = await migrateKnowledgeEmbedding(store, embedding, job.targetSpace, {
            signal: runSignal,
            generationId: job.generationId,
            clock,
          });
          await persistMigrationJob(store, {
            ...withoutLease(job),
            state: "succeeded",
            result,
            updatedAt: clock.now(),
          });
          return result;
        } catch (error: unknown) {
          lastError = error;
          const failed: MigrationJob = {
            ...withoutLease(job),
            state: "failed",
            error: error instanceof Error ? error.message : String(error),
            updatedAt: clock.now(),
          };
          await persistMigrationJob(store, failed);
          if (
            runSignal.aborted ||
            !retryableMigrationError(error) ||
            failed.attempts >= failed.maxAttempts
          ) {
            if (!runSignal.aborted) {
              await persistMigrationJob(store, {
                ...failed,
                state: "dead",
                updatedAt: clock.now(),
              });
            }
            throw error;
          }
          job = { ...failed, state: "queued", updatedAt: clock.now() };
          await persistMigrationJob(store, job);
        }
      }
      throw lastError instanceof Error ? lastError : new Error("Migration job exhausted retries");
    },
  });
}

export async function enqueueKnowledgeEmbeddingMigration(
  store: ZvecStore,
  scheduler: BackgroundScheduler,
  embedding: EmbeddingProvider,
  targetSpace: EmbeddingSpaceIdentity,
  options: MigrationJobOptions = {},
): Promise<JobReceipt> {
  const clock = options.clock ?? systemClock;
  const identity = embeddingSpaceId(targetSpace);
  const stableId = stableHash("embedding-migration-job:v2", identity);
  const jobId = `job_${stableId}`;
  const generationId = `migration_${stableId.slice(0, 24)}`;
  const createdAt = clock.now();
  const existing = decodeMigrationJob(
    ((await store.fetchScalar("jobs_v1", [jobId])).get(jobId) ?? {}) as Readonly<
      Record<string, unknown>
    >,
  );
  const job: MigrationJob = existing ?? {
    jobId,
    state: "queued",
    targetSpace,
    generationId,
    attempts: 0,
    maxAttempts: 3,
    createdAt,
    updatedAt: createdAt,
  };
  const resumable =
    job.state === "succeeded" || job.state === "dead"
      ? { ...job, state: "queued" as const, attempts: 0, updatedAt: clock.now() }
      : job;
  await persistMigrationJob(store, resumable);
  const scheduled = scheduleMigrationJob(
    store,
    scheduler,
    embedding,
    resumable,
    clock,
    options.signal,
  );
  void scheduled.promise.catch(() => undefined);
  return {
    jobId,
    accepted: true,
    deduplicated: scheduled.deduplicated,
    state: "queued",
  };
}

export async function recoverKnowledgeEmbeddingMigrationJobs(
  store: ZvecStore,
  scheduler: BackgroundScheduler,
  embedding: EmbeddingProvider,
  options: MigrationJobOptions = {},
): Promise<MigrationRecoveryResult> {
  const clock = options.clock ?? systemClock;
  const documents = await store.filterScalar(
    "jobs_v1",
    'kind = "embedding-migration" AND (status = "queued" OR status = "leased" OR status = "running" OR status = "failed")',
    1_000,
  );
  let recovered = 0;
  let dead = 0;
  for (const document of documents) {
    throwIfAborted(options.signal, "embedding-migration-recovery");
    const job = decodeMigrationJob(decodeStoredPayload(document));
    if (job === undefined || job.attempts >= job.maxAttempts) {
      if (job !== undefined) {
        await persistMigrationJob(store, {
          ...withoutLease(job),
          state: "dead",
          error: job.error ?? "Maximum attempts exhausted before recovery",
          updatedAt: clock.now(),
        });
      }
      dead++;
      continue;
    }
    const recoveredJob: MigrationJob = {
      ...withoutLease(job),
      state: "queued",
      ...(job.state === "leased" || job.state === "running"
        ? { error: `Lease taken over from ${job.leaseOwner ?? "unknown worker"}` }
        : {}),
      updatedAt: clock.now(),
    };
    await persistMigrationJob(store, recoveredJob);
    const scheduled = scheduleMigrationJob(
      store,
      scheduler,
      embedding,
      recoveredJob,
      clock,
      options.signal,
    );
    void scheduled.promise.catch(() => undefined);
    recovered++;
  }
  return { inspected: documents.length, recovered, dead };
}

function numberField(fields: Record<string, unknown>, name: string, fallback: number): number {
  const value = fields[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringField(fields: Record<string, unknown>, name: string, fallback: string): string {
  const value = fields[name];
  return typeof value === "string" ? value : fallback;
}

export async function migrateKnowledgeEmbedding(
  store: ZvecStore,
  embedding: EmbeddingProvider,
  targetSpace: EmbeddingSpaceIdentity,
  options: MigrateKnowledgeEmbeddingOptions = {},
): Promise<MigrationResult> {
  const clock = options.clock ?? systemClock;
  const generationId =
    options.generationId ??
    operationId("generation").replace("generation_", "").replaceAll("-", "");
  const existingGeneration = store.manifest.generations.find(
    (generation) => generation.generationId === generationId && generation.kind === "knowledge",
  );
  if (
    store.manifest.knowledgeGeneration === generationId &&
    existingGeneration?.state === "active"
  ) {
    const active = await store.filterVectors(
      "knowledge",
      'status = "active"',
      100_000,
      generationId,
    );
    return { generationId, migrated: active.length, activated: true };
  }
  const oldGeneration = store.manifest.knowledgeGeneration;
  const oldRecords = await store.filterVectors(
    "knowledge",
    'status = "active"',
    100_000,
    oldGeneration,
  );
  if (existingGeneration === undefined) {
    await store.createGeneration("knowledge", generationId, targetSpace, clock.now());
  } else if (
    embeddingSpaceId(existingGeneration.embeddingSpace) !== embeddingSpaceId(targetSpace)
  ) {
    throw new EmbeddingMigrationError(
      `Generation ${generationId} belongs to a different Embedding space`,
      { operation: "embedding-migration-resume", retryable: false },
    );
  }
  await store.setGenerationState(generationId, "backfilling", undefined, clock.now());
  let migrated = 0;
  try {
    for (let offset = 0; offset < oldRecords.length; offset += 32) {
      const batch = oldRecords.slice(offset, offset + 32);
      const payloads = batch.map((record) => decodeStoredPayload(record));
      const response = await embedding.embed(
        {
          inputs: payloads.map((payload) =>
            typeof payload["text"] === "string" ? payload["text"] : "",
          ),
          inputKind: "document",
          dimensions: targetSpace.dimensions,
          truncate: "reject",
        },
        {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
          priority: "background",
        },
      );
      const records: StoredVectorRecord[] = batch.map((record, index) => {
        const payload = payloads[index];
        const vector = response.vectors[index];
        if (payload === undefined || vector === undefined) {
          throw new EmbeddingMigrationError("Embedding migration batch is incomplete", {
            operation: "embedding-migration-backfill",
            retryable: false,
          });
        }
        const rawFields = record.fields as Record<string, unknown>;
        return {
          id: record.id,
          kind: stringField(rawFields, "kind", "knowledge"),
          namespace: stringField(rawFields, "namespace", "user"),
          status: stringField(rawFields, "status", "active"),
          payload: {
            ...payload,
            embeddingSpaceId: embeddingSpaceId(targetSpace),
          },
          searchableText: stringField(
            rawFields,
            "searchable_text",
            typeof payload["text"] === "string" ? payload["text"] : "",
          ),
          contentHash: stringField(rawFields, "content_hash", ""),
          sourceId: stringField(rawFields, "source_id", ""),
          documentId: stringField(rawFields, "document_id", ""),
          authority: numberField(rawFields, "authority", 80),
          tokenCount: numberField(rawFields, "token_count", 1),
          revision: numberField(rawFields, "revision", 1),
          embedding: vector.values,
          createdAt: numberField(rawFields, "created_at", clock.now()),
          updatedAt: clock.now(),
        };
      });
      await store.upsertVectors("knowledge", records, generationId);
      migrated += records.length;
      await options.onProgress?.({
        operation: "embedding-migration",
        phase: "backfilling",
        completed: migrated,
        total: oldRecords.length,
      });
    }
    await store.setGenerationState(generationId, "validating", undefined, clock.now());
    const validation = await store.filterVectors(
      "knowledge",
      'status = "active"',
      Math.max(1, oldRecords.length + 1),
      generationId,
    );
    if (validation.length !== oldRecords.length) {
      throw new EmbeddingMigrationError(
        `Generation validation count ${validation.length} differs from source ${oldRecords.length}`,
        { operation: "embedding-migration-validate", retryable: false },
      );
    }
    const sample = responseSample(validation);
    if (sample !== undefined) {
      const payload = decodeStoredPayload(sample);
      const text = typeof payload["text"] === "string" ? payload["text"] : "";
      const query = await embedding.embed(
        {
          inputs: [text],
          inputKind: "query",
          dimensions: targetSpace.dimensions,
          truncate: "reject",
        },
        { ...(options.signal === undefined ? {} : { signal: options.signal }) },
      );
      const queryVector = query.vectors[0];
      if (queryVector === undefined) {
        throw new EmbeddingMigrationError("Migration sample query Embedding is missing", {
          operation: "embedding-migration-validate",
          retryable: false,
        });
      }
      const search = await store.vectorSearch({
        kind: "knowledge",
        generationId,
        vector: queryVector.values,
        topK: 3,
      });
      if (!search.some((item) => item.id === sample.id)) {
        throw new EmbeddingMigrationError("Migration sample retrieval validation failed", {
          operation: "embedding-migration-validate",
          retryable: false,
        });
      }
    }
    await store.activateGeneration("knowledge", generationId, clock.now());
    return { generationId, migrated, activated: true };
  } catch (error: unknown) {
    await store.setGenerationState(
      generationId,
      "failed",
      error instanceof Error ? error.message : String(error),
      clock.now(),
    );
    throw error;
  }
}

function responseSample<T>(records: readonly T[]): T | undefined {
  return records.length === 0 ? undefined : records[Math.floor(records.length / 2)];
}
