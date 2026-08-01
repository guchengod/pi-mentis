import {
  BackgroundScheduler,
  EvidenceAuthority,
  ForegroundExecutor,
  TaskPriority,
  chunkId,
  contentHash,
  documentId,
  operationId,
  stableHash,
  throwIfAborted,
  type JobReceipt,
  type OperationOptions,
  type ResourceLimits,
  type SearchHit,
} from "@pi-mentis/pi-mentis-core";
import {
  BoundedTtlCache,
  embeddingSpaceId,
  type EmbeddingProvider,
  type EmbeddingSpaceIdentity,
  type EmbeddingVector,
} from "@pi-mentis/pi-mentis-inference";
import {
  chunkStructuredDocument,
  createDefaultParserRegistry,
  detectMediaType,
  extensionOf,
  resolveSource,
  type ParserRegistry,
  type StructuredDocument,
} from "@pi-mentis/pi-mentis-file-parsers";
import { InMemoryTelemetry, measure } from "@pi-mentis/pi-mentis-observability";
import {
  ZvecStore,
  decodeStoredPayload,
  type StoredRecord,
  type StoredVectorRecord,
} from "@pi-mentis/pi-mentis-zvec";

import type {
  EnqueueOptions,
  IngestKnowledgeCommand,
  IngestKnowledgeResult,
  InspectKnowledgeQuery,
  KnowledgeCapabilities,
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeDocumentView,
  KnowledgeQuery,
  KnowledgeSearchResult,
  KnowledgeService,
  KnowledgeSource,
  RemoveKnowledgeCommand,
  RemoveKnowledgeResult,
  SearchOptions,
  SyncKnowledgeSourceCommand,
} from "./types.js";

export interface CreateKnowledgeServiceOptions {
  readonly store: ZvecStore;
  readonly embedding: EmbeddingProvider;
  readonly embeddingSpace: EmbeddingSpaceIdentity;
  readonly dimensions: number;
  readonly limits: ResourceLimits;
  readonly scheduler: BackgroundScheduler;
  readonly parserRegistry?: ParserRegistry;
  readonly telemetry?: InMemoryTelemetry;
  readonly defaultNamespace?: string;
  readonly queryCacheEntries?: number;
  readonly queryCacheTtlMs?: number;
}

function quoteFilter(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function fieldsOf(document: { readonly fields: Record<string, unknown> }): Record<string, unknown> {
  return document.fields;
}

function numericField(fields: Record<string, unknown>, name: string, fallback = 0): number {
  const value = fields[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringField(fields: Record<string, unknown>, name: string, fallback = ""): string {
  const value = fields[name];
  return typeof value === "string" ? value : fallback;
}

function asKnowledgeDocument(
  value: Readonly<Record<string, unknown>>,
): KnowledgeDocument | undefined {
  return typeof value["id"] === "string" &&
    typeof value["sourceId"] === "string" &&
    typeof value["canonicalUri"] === "string" &&
    typeof value["title"] === "string"
    ? (value as unknown as KnowledgeDocument)
    : undefined;
}

export class DefaultKnowledgeService implements KnowledgeService {
  readonly #store: ZvecStore;
  readonly #embedding: EmbeddingProvider;
  readonly #embeddingSpace: EmbeddingSpaceIdentity;
  readonly #embeddingSpaceId: string;
  readonly #dimensions: number;
  readonly #limits: ResourceLimits;
  readonly #scheduler: BackgroundScheduler;
  readonly #parsers: ParserRegistry;
  readonly #telemetry: InMemoryTelemetry;
  readonly #defaultNamespace: string;
  readonly #queryCache: BoundedTtlCache<EmbeddingVector>;
  readonly #foreground = new ForegroundExecutor();

  constructor(options: CreateKnowledgeServiceOptions) {
    this.#store = options.store;
    this.#embedding = options.embedding;
    this.#embeddingSpace = options.embeddingSpace;
    this.#embeddingSpaceId = embeddingSpaceId(options.embeddingSpace);
    this.#dimensions = options.dimensions;
    this.#limits = options.limits;
    this.#scheduler = options.scheduler;
    this.#parsers = options.parserRegistry ?? createDefaultParserRegistry();
    this.#telemetry = options.telemetry ?? new InMemoryTelemetry();
    this.#defaultNamespace = options.defaultNamespace ?? "user";
    this.#queryCache = new BoundedTtlCache(
      options.queryCacheEntries ?? 512,
      options.queryCacheTtlMs ?? 300_000,
    );
  }

  async ingest(
    command: IngestKnowledgeCommand,
    options: OperationOptions = {},
  ): Promise<IngestKnowledgeResult> {
    const namespace = command.namespace ?? this.#defaultNamespace;
    const authority = command.authority ?? EvidenceAuthority.UserKnowledge;
    const sourceIds: string[] = [];
    const documentIds: string[] = [];
    const diagnostics: string[] = [];
    let chunkCount = 0;
    let unchanged = 0;
    for await (const resolved of resolveSource(command.source, {
      namespace,
      limits: this.#limits,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })) {
      throwIfAborted(options.signal, "knowledge-ingest");
      sourceIds.push(resolved.source.id);
      const existingSource = (
        await this.#store.fetchScalar("knowledge_sources_v1", [resolved.source.id])
      ).get(resolved.source.id);
      if (
        existingSource?.["fingerprint"] === resolved.fingerprint &&
        existingSource["state"] === "active"
      ) {
        unchanged++;
        continue;
      }
      const now = Date.now();
      const knowledgeSource: KnowledgeSource = {
        id: resolved.source.id,
        kind: command.source.kind,
        canonicalUri: resolved.source.canonicalUri,
        namespace,
        authority,
        state: "syncing",
        createdAt:
          typeof existingSource?.["createdAt"] === "number" ? existingSource["createdAt"] : now,
        updatedAt: now,
        fingerprint: resolved.fingerprint,
        ...(resolved.source.attributes === undefined
          ? {}
          : { attributes: resolved.source.attributes }),
      };
      await this.#store.upsertScalar("knowledge_sources_v1", [this.#sourceRecord(knowledgeSource)]);
      const mediaType = detectMediaType(
        resolved.input.bytes,
        resolved.input.filename,
        resolved.input.mediaType,
      );
      const extension =
        resolved.input.filename === undefined ? undefined : extensionOf(resolved.input.filename);
      const selection = await this.#parsers.select({
        canonicalUri: resolved.source.canonicalUri,
        ...(resolved.input.filename === undefined
          ? {}
          : {
              filename: resolved.input.filename,
              ...(extension === undefined ? {} : { extension }),
            }),
        mediaType,
        magic: resolved.input.bytes.subarray(0, 32),
      });
      const parsed = await this.#consumeParser(
        selection.parser.parse(
          { ...resolved.input, mediaType },
          {
            limits: this.#limits,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
        ),
      );
      const parsedDocument: StructuredDocument | undefined = parsed.document;
      diagnostics.push(...parsed.diagnostics);
      if (parsedDocument === undefined) {
        const failed = { ...knowledgeSource, state: "failed" as const, updatedAt: Date.now() };
        await this.#store.upsertScalar("knowledge_sources_v1", [this.#sourceRecord(failed)]);
        continue;
      }
      const identifier = documentId(
        resolved.source.id,
        resolved.input.filename ?? resolved.source.canonicalUri,
      );
      documentIds.push(identifier);
      const previousDocument = (
        await this.#store.fetchScalar("knowledge_documents_v1", [identifier])
      ).get(identifier);
      const previousRevision =
        typeof previousDocument?.["activeRevision"] === "number"
          ? previousDocument["activeRevision"]
          : 0;
      const revision = previousRevision + 1;
      const drafts = chunkStructuredDocument(parsedDocument, undefined, undefined, 32_768);
      const draftIds = drafts.map((draft) => {
        const hash = contentHash(draft.text);
        return chunkId(identifier, draft.semanticKey, hash);
      });
      const persisted = await this.#store.fetchVectors("knowledge", draftIds);
      const missingIndexes: number[] = [];
      const embedded: Array<EmbeddingVector | undefined> = drafts.map((_draft, index) => {
        const stored = persisted.get(draftIds[index] ?? "");
        const vector = stored?.vectors["embedding"];
        if (vector instanceof Float32Array || Array.isArray(vector)) {
          return {
            values: vector instanceof Float32Array ? vector : Float32Array.from(vector),
            dimensions: this.#dimensions,
            normalized: false,
          };
        }
        missingIndexes.push(index);
        return undefined;
      });
      const missingVectors = await this.#embedDrafts(
        missingIndexes.map((index) => {
          const draft = drafts[index];
          if (draft === undefined) throw new Error("Missing chunk draft");
          return { text: draft.text, tokenCount: draft.tokenCount };
        }),
        options,
      );
      for (const [offset, vector] of missingVectors.entries()) {
        const index = missingIndexes[offset];
        if (index !== undefined) embedded[index] = vector;
      }
      const chunks: KnowledgeChunk[] = drafts.map((draft, index) => {
        const hash = contentHash(draft.text);
        const vector = embedded[index];
        if (vector === undefined) throw new Error("Embedding batch returned incomplete vectors");
        return {
          id: draftIds[index] ?? chunkId(identifier, draft.semanticKey, hash),
          documentId: identifier,
          sourceId: resolved.source.id,
          canonicalUri: resolved.source.canonicalUri,
          semanticKey: draft.semanticKey,
          text: draft.text,
          searchableText: draft.searchableText,
          embeddingSpaceId: this.#embeddingSpaceId,
          embedding: vector.values,
          revision,
          ordinal: draft.ordinal,
          headingPath: draft.headingPath,
          tokenCount: draft.tokenCount,
          contentHash: hash,
          ...(draft.location === undefined ? {} : { location: draft.location }),
          ...(draft.symbol === undefined ? {} : { symbol: draft.symbol }),
          authority,
          namespace,
          createdAt: now,
          updatedAt: now,
          ...(resolved.source.attributes === undefined
            ? {}
            : { sourceAttributes: resolved.source.attributes }),
        };
      });
      const knowledgeDocument: KnowledgeDocument = {
        id: identifier,
        sourceId: resolved.source.id,
        canonicalUri: resolved.source.canonicalUri,
        title: parsedDocument.metadata.title,
        mediaType: parsedDocument.metadata.mediaType,
        contentHash: resolved.fingerprint,
        metadataHash: contentHash(JSON.stringify(parsedDocument.metadata)),
        parser: selection.component,
        chunker: { id: "structured-token-packer", version: "1.0.0" },
        embeddingSpace: this.#embeddingSpace,
        revision,
        activeRevision: previousRevision,
        status: "preparing",
        indexedAt: now,
        ...(parsedDocument.metadata.attributes === undefined
          ? {}
          : { attributes: parsedDocument.metadata.attributes }),
      };
      await this.#store.upsertScalar("knowledge_documents_v1", [
        this.#documentRecord(knowledgeDocument),
      ]);
      await this.#store.upsertVectors(
        "knowledge",
        chunks.map((chunk) => this.#chunkRecord(chunk)),
      );
      const previousChunks =
        previousRevision === 0
          ? []
          : await this.#store.filterVectors(
              "knowledge",
              `document_id = ${quoteFilter(identifier)} AND revision = ${previousRevision}`,
            );
      const nextIds = new Set(chunks.map((chunk) => chunk.id));
      const staleIds = previousChunks
        .map((document) => document.id)
        .filter((id) => !nextIds.has(id));
      await this.#store.deleteVectors("knowledge", staleIds);
      const activeDocument: KnowledgeDocument = {
        ...knowledgeDocument,
        activeRevision: revision,
        status: "active",
      };
      await this.#store.upsertScalar("knowledge_documents_v1", [
        this.#documentRecord(activeDocument),
      ]);
      await this.#store.upsertScalar("knowledge_sources_v1", [
        this.#sourceRecord({ ...knowledgeSource, state: "active", updatedAt: Date.now() }),
      ]);
      chunkCount += chunks.length;
      await options.onProgress?.({
        operation: "knowledge-ingest",
        phase: "indexed",
        completed: documentIds.length,
        message: parsedDocument.metadata.title,
      });
    }
    return { sourceIds, documentIds, chunkCount, unchanged, diagnostics };
  }

  async enqueueIngest(
    command: IngestKnowledgeCommand,
    options: EnqueueOptions = {},
  ): Promise<JobReceipt> {
    const jobId = operationId("job");
    const deduplicationKey = stableHash("knowledge-ingest-job:v1", JSON.stringify(command));
    const now = Date.now();
    await this.#store.upsertScalar("jobs_v1", [
      {
        id: jobId,
        kind: "knowledge-ingest",
        namespace: command.namespace ?? this.#defaultNamespace,
        status: "queued",
        payload: { jobId, command, state: "queued", createdAt: now },
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const scheduled = this.#scheduler.schedule({
      id: jobId,
      deduplicationKey,
      priority:
        options.priority === "background"
          ? TaskPriority.BackgroundSync
          : TaskPriority.UserRequested,
      estimatedBytes: Buffer.byteLength(JSON.stringify(command), "utf8"),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      run: async (signal) => {
        const started = Date.now();
        await this.#store.upsertScalar("jobs_v1", [
          {
            id: jobId,
            kind: "knowledge-ingest",
            namespace: command.namespace ?? this.#defaultNamespace,
            status: "running",
            payload: { jobId, command, state: "running", startedAt: started },
            createdAt: now,
            updatedAt: started,
          },
        ]);
        try {
          const result = await this.ingest(command, { ...options, signal });
          await this.#store.upsertScalar("jobs_v1", [
            {
              id: jobId,
              kind: "knowledge-ingest",
              namespace: command.namespace ?? this.#defaultNamespace,
              status: "completed",
              payload: { jobId, state: "completed", result, completedAt: Date.now() },
              createdAt: now,
              updatedAt: Date.now(),
            },
          ]);
          return result;
        } catch (error: unknown) {
          await this.#store.upsertScalar("jobs_v1", [
            {
              id: jobId,
              kind: "knowledge-ingest",
              namespace: command.namespace ?? this.#defaultNamespace,
              status: "failed",
              payload: {
                jobId,
                state: "failed",
                error: error instanceof Error ? error.message : String(error),
                failedAt: Date.now(),
              },
              createdAt: now,
              updatedAt: Date.now(),
            },
          ]);
          throw error;
        }
      },
    });
    void scheduled.promise.catch(() => undefined);
    return {
      jobId,
      accepted: true,
      deduplicated: scheduled.deduplicated,
      state: "queued",
    };
  }

  async search(query: KnowledgeQuery, options: SearchOptions = {}): Promise<KnowledgeSearchResult> {
    const limit = Math.max(1, Math.min(100, query.limit ?? 20));
    const started = performance.now();
    return this.#foreground.execute(
      "knowledge-search",
      options.timeoutMs ?? 3_000,
      async (signal) => {
        const stages: Record<string, number> = {};
        const degraded: string[] = [];
        const embeddingStarted = performance.now();
        const queryVector = await this.#queryEmbedding(query.text, { ...options, signal });
        stages["embedding"] = performance.now() - embeddingStarted;
        const filter =
          query.namespace === undefined
            ? undefined
            : `namespace = ${quoteFilter(query.namespace)} AND status = "active"`;
        const zvecStarted = performance.now();
        const searches = await Promise.allSettled([
          this.#store.vectorSearch({
            kind: "knowledge",
            vector: queryVector.values,
            topK: limit * 2,
            ...(filter === undefined ? {} : { filter }),
          }),
          this.#store.ftsSearch({
            kind: "knowledge",
            query: query.text,
            topK: limit * 2,
            ...(filter === undefined ? {} : { filter }),
          }),
        ]);
        stages["zvec"] = performance.now() - zvecStarted;
        const fused = new Map<string, SearchHit>();
        for (const [sourceIndex, result] of searches.entries()) {
          if (result.status === "rejected") {
            degraded.push(sourceIndex === 0 ? "dense-unavailable" : "fts-unavailable");
            continue;
          }
          for (const [rank, document] of result.value.entries()) {
            const payload = decodeStoredPayload(document);
            const text =
              typeof payload["text"] === "string"
                ? payload["text"]
                : stringField(fieldsOf(document), "searchable_text");
            const fields = fieldsOf(document);
            const authority = numericField(fields, "authority", EvidenceAuthority.UserKnowledge);
            const reciprocal = (sourceIndex === 0 ? 1 : 1) / (60 + rank + 1);
            const existing = fused.get(document.id);
            const hit: SearchHit = {
              id: document.id,
              kind: "knowledge",
              text,
              score: (existing?.score ?? 0) + reciprocal,
              tokenCount: numericField(fields, "token_count", 1),
              authority: authority as SearchHit["authority"],
              namespace: stringField(fields, "namespace", "user"),
              contentHash: stringField(fields, "content_hash", contentHash(text)),
              metadata: payload,
            };
            fused.set(document.id, hit);
          }
        }
        const hits = [...fused.values()]
          .sort((left, right) => right.score - left.score)
          .slice(0, limit);
        return {
          hits,
          diagnostics: {
            durationMs: performance.now() - started,
            timedOut: false,
            degraded,
            stages,
            ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
          },
        };
      },
      options.signal,
    );
  }

  async remove(
    command: RemoveKnowledgeCommand,
    options: OperationOptions = {},
  ): Promise<RemoveKnowledgeResult> {
    throwIfAborted(options.signal, "knowledge-remove");
    const sourcePayload = (
      await this.#store.fetchScalar("knowledge_sources_v1", [command.sourceId])
    ).get(command.sourceId);
    const chunks = await this.#store.filterVectors(
      "knowledge",
      `source_id = ${quoteFilter(command.sourceId)}`,
    );
    await this.#store.deleteVectors(
      "knowledge",
      chunks.map((document) => document.id),
    );
    if (sourcePayload !== undefined) {
      const now = Date.now();
      await this.#store.upsertScalar("knowledge_sources_v1", [
        {
          id: command.sourceId,
          kind: typeof sourcePayload["kind"] === "string" ? sourcePayload["kind"] : "source",
          namespace:
            typeof sourcePayload["namespace"] === "string" ? sourcePayload["namespace"] : "user",
          status: "removed",
          payload: { ...sourcePayload, state: "removed", updatedAt: now },
          createdAt:
            typeof sourcePayload["createdAt"] === "number" ? sourcePayload["createdAt"] : now,
          updatedAt: now,
        },
      ]);
    }
    return { sourceId: command.sourceId, removedChunks: chunks.length };
  }

  async sync(
    command: SyncKnowledgeSourceCommand,
    options: EnqueueOptions = {},
  ): Promise<JobReceipt> {
    return this.enqueueIngest(
      {
        source: command.source,
        ...(command.namespace === undefined ? {} : { namespace: command.namespace }),
      },
      options,
    );
  }

  async inspect(query: InspectKnowledgeQuery): Promise<KnowledgeDocumentView | undefined> {
    const payload = (
      await this.#store.fetchScalar("knowledge_documents_v1", [query.documentId])
    ).get(query.documentId);
    if (payload === undefined) return undefined;
    const document = asKnowledgeDocument(payload);
    if (document === undefined) return undefined;
    const chunkDocuments = await this.#store.filterVectors(
      "knowledge",
      `document_id = ${quoteFilter(query.documentId)}`,
    );
    const chunks = chunkDocuments
      .map((stored) => decodeStoredPayload(stored) as unknown as Omit<KnowledgeChunk, "embedding">)
      .sort((left, right) => left.ordinal - right.ordinal);
    return { document, chunks };
  }

  capabilities(): KnowledgeCapabilities {
    return {
      sourceKinds: [
        "file",
        "directory",
        "workspace",
        "git",
        "url",
        "text",
        "buffer",
        "pi-package",
        "skill",
        "mcp",
      ],
      mediaTypes: [
        "text/plain",
        "text/markdown",
        "application/json",
        "application/x-ndjson",
        "application/yaml",
        "application/toml",
        "text/csv",
        "text/html",
        "application/xml",
        "application/pdf",
        "application/epub+zip",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "message/rfc822",
        "application/mbox",
        "application/zip",
      ],
      supportsIncrementalSync: true,
      supportsEmbeddingMigration: true,
    };
  }

  async #queryEmbedding(text: string, options: OperationOptions): Promise<EmbeddingVector> {
    const key = stableHash(
      "query-embedding:v1",
      this.#embedding.id,
      this.#embeddingSpace.modelId,
      String(this.#dimensions),
      contentHash(text),
    );
    const cached = this.#queryCache.get(key);
    if (cached !== undefined) return cached;
    const response = await measure(this.#telemetry, "embedding_duration_ms", () =>
      this.#embedding.embed(
        {
          inputs: [text],
          inputKind: "query",
          dimensions: this.#dimensions,
          truncate: "reject",
        },
        {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
          priority: "interactive",
        },
      ),
    );
    const vector = response.vectors[0];
    if (vector === undefined) throw new Error("Query Embedding response is empty");
    this.#queryCache.set(key, vector);
    return vector;
  }

  async #embedDrafts(
    drafts: readonly { readonly text: string; readonly tokenCount: number }[],
    options: OperationOptions,
  ): Promise<readonly EmbeddingVector[]> {
    const vectors: EmbeddingVector[] = [];
    let batch: typeof drafts = [];
    let tokens = 0;
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const response = await this.#embedding.embed(
        {
          inputs: batch.map((item) => item.text),
          inputKind: "document",
          dimensions: this.#dimensions,
          truncate: "reject",
        },
        {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
          priority: "background",
        },
      );
      vectors.push(...response.vectors);
      batch = [];
      tokens = 0;
    };
    for (const draft of drafts) {
      if (batch.length >= 32 || tokens + draft.tokenCount > 20_000) await flush();
      batch = [...batch, draft];
      tokens += draft.tokenCount;
    }
    await flush();
    return vectors;
  }

  async #consumeParser(
    events: AsyncIterable<
      | {
          readonly type: "document";
          readonly document: import("@pi-mentis/pi-mentis-file-parsers").StructuredDocument;
        }
      | {
          readonly type: "progress";
          readonly completed: number;
          readonly total?: number;
          readonly phase: string;
        }
      | { readonly type: "diagnostic"; readonly code: string; readonly message: string }
    >,
  ): Promise<{
    readonly document?: import("@pi-mentis/pi-mentis-file-parsers").StructuredDocument;
    readonly diagnostics: readonly string[];
  }> {
    let document: import("@pi-mentis/pi-mentis-file-parsers").StructuredDocument | undefined;
    const diagnostics: string[] = [];
    for await (const event of events) {
      if (event.type === "document") document = event.document;
      if (event.type === "diagnostic") diagnostics.push(`${event.code}: ${event.message}`);
    }
    return { ...(document === undefined ? {} : { document }), diagnostics };
  }

  #sourceRecord(source: KnowledgeSource): StoredRecord {
    return {
      id: source.id,
      kind: source.kind,
      namespace: source.namespace,
      status: source.state,
      payload: source as unknown as Readonly<Record<string, unknown>>,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    };
  }

  #documentRecord(document: KnowledgeDocument): StoredRecord {
    return {
      id: document.id,
      kind: "knowledge-document",
      namespace: "system",
      status: document.status,
      payload: document as unknown as Readonly<Record<string, unknown>>,
      createdAt: document.indexedAt,
      updatedAt: document.indexedAt,
    };
  }

  #chunkRecord(chunk: KnowledgeChunk): StoredVectorRecord {
    const { embedding, ...payload } = chunk;
    return {
      id: chunk.id,
      kind: "knowledge",
      namespace: chunk.namespace,
      status: "active",
      payload: payload as unknown as Readonly<Record<string, unknown>>,
      searchableText: chunk.searchableText,
      contentHash: chunk.contentHash,
      sourceId: chunk.sourceId,
      documentId: chunk.documentId,
      authority: chunk.authority,
      tokenCount: chunk.tokenCount,
      revision: chunk.revision,
      embedding,
      createdAt: chunk.createdAt,
      updatedAt: chunk.updatedAt,
    };
  }
}

export function createKnowledgeService(options: CreateKnowledgeServiceOptions): KnowledgeService {
  return new DefaultKnowledgeService(options);
}
