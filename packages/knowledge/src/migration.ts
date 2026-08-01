import {
  EmbeddingMigrationError,
  operationId,
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
  options: OperationOptions = {},
): Promise<MigrationResult> {
  const oldGeneration = store.manifest.knowledgeGeneration;
  const oldRecords = await store.filterVectors(
    "knowledge",
    'status = "active"',
    100_000,
    oldGeneration,
  );
  const generationId = operationId("generation").replace("generation_", "").replaceAll("-", "");
  await store.createGeneration("knowledge", generationId, targetSpace);
  await store.setGenerationState(generationId, "backfilling");
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
          createdAt: numberField(rawFields, "created_at", Date.now()),
          updatedAt: Date.now(),
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
    await store.setGenerationState(generationId, "validating");
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
    await store.activateGeneration("knowledge", generationId);
    return { generationId, migrated, activated: true };
  } catch (error: unknown) {
    await store.setGenerationState(
      generationId,
      "failed",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

function responseSample<T>(records: readonly T[]): T | undefined {
  return records.length === 0 ? undefined : records[Math.floor(records.length / 2)];
}
