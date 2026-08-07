import {
  type BackgroundScheduler,
  EvidenceAuthority,
  ForegroundExecutor,
  TaskPriority,
  chunkId,
  contentHash,
  documentId,
  operationId,
  stableHash,
  systemClock,
  throwIfAborted,
  type Clock,
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
  type ResolvedParserInput,
  type StructuredDocument,
} from "@pi-mentis/pi-mentis-file-parsers";
import { InMemoryTelemetry, measure } from "@pi-mentis/pi-mentis-observability";
import {
  type ZvecStore,
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
  KnowledgeJobRecoveryResult,
  KnowledgeQuery,
  KnowledgeSearchResult,
  KnowledgeService,
  KnowledgeSource,
  RemoveKnowledgeCommand,
  RemoveKnowledgeResult,
  SearchOptions,
  SyncKnowledgeSourceCommand,
} from "./types.js";
import { recoverKnowledgeEmbeddingMigrationJobs } from "./migration.js";
import path from "node:path";

type KnowledgeJobState = "queued" | "leased" | "running" | "succeeded" | "failed" | "dead";

interface PersistedKnowledgeJob {
  readonly jobId: string;
  readonly deduplicationKey: string;
  readonly commandHash: string;
  readonly commandJson: string;
  readonly namespace: string;
  readonly state: KnowledgeJobState;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: number;
  readonly result?: IngestKnowledgeResult;
  readonly error?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const JOB_LEASE_MS = 5 * 60_000;
const JOB_MAX_ATTEMPTS = 3;

function serializeIngestCommand(command: IngestKnowledgeCommand): string {
  return JSON.stringify(command, (_key, value: unknown) =>
    value instanceof Uint8Array
      ? { __piMentisBytes: Buffer.from(value).toString("base64") }
      : value,
  );
}

function parseIngestCommand(commandJson: string): IngestKnowledgeCommand {
  const value = JSON.parse(commandJson, (_key, candidate: unknown) => {
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      typeof (candidate as Record<string, unknown>)["__piMentisBytes"] === "string"
    ) {
      return Uint8Array.from(
        Buffer.from((candidate as Record<string, string>)["__piMentisBytes"] ?? "", "base64"),
      );
    }
    return candidate;
  }) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>)["source"] !== "object"
  ) {
    throw new Error("Persisted knowledge command is invalid");
  }
  return value as IngestKnowledgeCommand;
}

function retryableJobError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("context" in error)) return true;
  const context = (error as { readonly context?: unknown }).context;
  if (typeof context !== "object" || context === null || !("retryable" in context)) return true;
  return (context as { readonly retryable?: unknown }).retryable !== false;
}

function secureNamespace(
  namespace: string,
  scope: import("./types.js").KnowledgeSecurityScope | undefined,
): string {
  if (scope === undefined) return namespace;
  return `${[scope.tenantId, scope.userId, scope.appId, scope.agentId]
    .map(encodeURIComponent)
    .join(":")}::${namespace}`;
}

function securityBoundary(scope: import("./types.js").KnowledgeSecurityScope): string {
  return [scope.tenantId, scope.userId, scope.appId, scope.agentId]
    .map(encodeURIComponent)
    .join(":");
}

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
  readonly clock?: Clock;
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

function abbreviateSource(source: IngestKnowledgeCommand["source"]): string {
  if (source.kind === "directory") {
    const name = path.basename(source.path) || source.path;
    return name.length > 20 ? `${name.slice(0, 18)}…/` : `${name}/`;
  }
  if (source.kind === "workspace") {
    const name = path.basename(source.path) || source.path;
    const short = name.length > 18 ? `${name.slice(0, 16)}…` : name;
    return `ws:${short}`;
  }
  if (source.kind === "url") {
    try {
      const host = new URL(source.url).hostname;
      return host.length > 22 ? `${host.slice(0, 20)}…` : host;
    } catch {
      return "url";
    }
  }
  if (source.kind === "git") {
    const name = path.basename(source.path) || source.path;
    const short = name.length > 18 ? `${name.slice(0, 16)}…` : name;
    return `git:${short}`;
  }
  if (source.kind === "file") {
    const name = path.basename(source.path);
    return name.length > 25 ? `${name.slice(0, 23)}…` : name;
  }
  return source.kind;
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
  readonly #workerId = `knowledge-worker:${operationId("operation")}`;
  readonly #clock: Clock;
  #recoveryPerformed = false;

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
    this.#clock = options.clock ?? systemClock;
  }

  async ingest(
    command: IngestKnowledgeCommand,
    options: OperationOptions = {},
  ): Promise<IngestKnowledgeResult> {
    const logicalNamespace = command.namespace ?? this.#defaultNamespace;
    const namespace = secureNamespace(logicalNamespace, command.scopeContext);
    const authority = command.authority ?? EvidenceAuthority.UserKnowledge;
    const sourceIds: string[] = [];
    const documentIds: string[] = [];
    const diagnostics: string[] = [];
    let chunkCount = 0;
    let unchanged = 0;
    const resolvedFiles: ResolvedParserInput[] = [];
    for await (const resolved of resolveSource(command.source, {
      namespace,
      limits: this.#limits,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })) {
      throwIfAborted(options.signal, "knowledge-ingest");
      resolvedFiles.push(resolved);
    }
    const CONCURRENCY = 5;
    const sourceLabel = abbreviateSource(command.source);
    let failures = 0;
    for (let batchStart = 0; batchStart < resolvedFiles.length; batchStart += CONCURRENCY) {
      const batch = resolvedFiles.slice(batchStart, batchStart + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((resolved) => this.#ingestOne(resolved, command, namespace, authority, options)),
      );
      for (const result of results) {
        if (result.status === "rejected") {
          failures++;
          diagnostics.push(
            `File processing failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          );
          continue;
        }
        const r = result.value;
        sourceIds.push(...r.sourceIds);
        documentIds.push(...r.documentIds);
        diagnostics.push(...r.diagnostics);
        chunkCount += r.chunkCount;
        unchanged += r.unchanged;
      }
      const completed = Math.min(batchStart + CONCURRENCY, resolvedFiles.length);
      const failedSuffix = failures > 0 ? ` (${failures} fail)` : "";
      await options.onProgress?.({
        operation: "knowledge-ingest",
        phase: "indexed",
        completed,
        total: resolvedFiles.length,
        message: `${sourceLabel} ${completed}/${resolvedFiles.length}${failedSuffix}`,
      });
    }
    return { sourceIds, documentIds, chunkCount, unchanged, diagnostics };
  }

  async #ingestOne(
    resolved: ResolvedParserInput,
    command: IngestKnowledgeCommand,
    namespace: string,
    authority: EvidenceAuthority,
    options: OperationOptions,
  ): Promise<IngestKnowledgeResult> {
    const sourceIds: string[] = [];
    const documentIds: string[] = [];
    const diagnostics: string[] = [];
    let chunkCount = 0;
    const unchanged = 0;

    sourceIds.push(resolved.source.id);
    const existingSource = (
      await this.#store.fetchScalar("knowledge_sources_v1", [resolved.source.id])
    ).get(resolved.source.id);
    if (
      existingSource?.["fingerprint"] === resolved.fingerprint &&
      existingSource["state"] === "active"
    ) {
      return { sourceIds, documentIds, chunkCount, unchanged: 1, diagnostics };
    }
    const now = this.#clock.now();
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
      attributes: {
        ...(resolved.source.attributes ?? {}),
        logicalNamespace: command.namespace ?? this.#defaultNamespace,
        ...(command.scopeContext === undefined
          ? {}
          : {
              tenantId: command.scopeContext.tenantId,
              userId: command.scopeContext.userId,
              appId: command.scopeContext.appId,
              agentId: command.scopeContext.agentId,
            }),
      },
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
      const failed = {
        ...knowledgeSource,
        state: "failed" as const,
        updatedAt: this.#clock.now(),
      };
      await this.#store.upsertScalar("knowledge_sources_v1", [this.#sourceRecord(failed)]);
      return { sourceIds, documentIds, chunkCount, unchanged, diagnostics };
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
      chunks
        .filter((chunk) => !persisted.has(chunk.id))
        .map((chunk) => this.#chunkRecord(chunk, "preparing")),
    );
    const previousChunks =
      previousRevision === 0
        ? []
        : await this.#store.filterVectors(
            "knowledge",
            `document_id = ${quoteFilter(identifier)} AND revision = ${previousRevision}`,
          );
    const activeDocument: KnowledgeDocument = {
      ...knowledgeDocument,
      activeRevision: revision,
      status: "active",
    };
    await this.#store.upsertScalar("knowledge_documents_v1", [
      this.#documentRecord(activeDocument),
    ]);
    await this.#store.upsertVectors(
      "knowledge",
      chunks.map((chunk) => this.#chunkRecord(chunk, "active")),
    );
    const nextIds = new Set(chunks.map((chunk) => chunk.id));
    const staleIds = previousChunks.map((document) => document.id).filter((id) => !nextIds.has(id));
    await this.#store.deleteVectors("knowledge", staleIds);
    await this.#store.upsertScalar("knowledge_sources_v1", [
      this.#sourceRecord({
        ...knowledgeSource,
        state: "active",
        updatedAt: this.#clock.now(),
      }),
    ]);
    chunkCount += chunks.length;
    return { sourceIds, documentIds, chunkCount, unchanged, diagnostics };
  }

  async enqueueIngest(
    command: IngestKnowledgeCommand,
    options: EnqueueOptions = {},
  ): Promise<JobReceipt> {
    const commandJson = serializeIngestCommand(command);
    const commandHash = stableHash("knowledge-ingest-command:v1", commandJson);
    const deduplicationKey = stableHash("knowledge-ingest-job:v2", commandHash);
    const existing = await this.#findActiveJob(deduplicationKey);
    if (existing !== undefined) {
      const scheduled = this.#scheduleJob(
        existing,
        parseIngestCommand(existing.commandJson),
        options,
      );
      void scheduled.promise.catch(() => undefined);
      return {
        jobId: existing.jobId,
        accepted: true,
        deduplicated: true,
        state: existing.state === "running" || existing.state === "leased" ? "running" : "queued",
      };
    }
    const jobId = operationId("job");
    const now = this.#clock.now();
    const jobNamespace = secureNamespace(
      command.namespace ?? this.#defaultNamespace,
      command.scopeContext,
    );
    const job: PersistedKnowledgeJob = {
      jobId,
      deduplicationKey,
      commandHash,
      commandJson,
      namespace: jobNamespace,
      state: "queued",
      attempts: 0,
      maxAttempts: JOB_MAX_ATTEMPTS,
      createdAt: now,
      updatedAt: now,
    };
    await this.#persistJob(job);
    const scheduled = this.#scheduleJob(job, command, options);
    void scheduled.promise.catch(() => undefined);
    return {
      jobId,
      accepted: true,
      deduplicated: scheduled.deduplicated,
      state: "queued",
    };
  }

  async recoverJobs(options: OperationOptions = {}): Promise<KnowledgeJobRecoveryResult> {
    if (this.#recoveryPerformed) {
      return { inspected: 0, recovered: 0, dead: 0, invalid: 0 };
    }
    this.#recoveryPerformed = true;
    const documents = await this.#store.filterScalar(
      "jobs_v1",
      'kind = "knowledge-ingest" AND (status = "queued" OR status = "leased" OR status = "running" OR status = "failed")',
      10_000,
    );
    let recovered = 0;
    let dead = 0;
    let invalid = 0;
    for (const document of documents) {
      throwIfAborted(options.signal, "knowledge-job-recovery");
      const payload = decodeStoredPayload(document);
      const job = this.#decodeJob(payload);
      if (job === undefined) {
        const now = this.#clock.now();
        await this.#store.upsertScalar("jobs_v1", [
          {
            id: document.id,
            kind: "knowledge-ingest",
            namespace: stringField(fieldsOf(document), "namespace", this.#defaultNamespace),
            status: "dead",
            payload: {
              ...payload,
              state: "dead",
              error: "Persisted job payload cannot be recovered",
              updatedAt: now,
            },
            createdAt: numericField(fieldsOf(document), "created_at", now),
            updatedAt: now,
          },
        ]);
        invalid++;
        continue;
      }
      if (job.attempts >= job.maxAttempts) {
        await this.#persistJob({
          ...this.#withoutLease(job),
          state: "dead",
          error: job.error ?? "Maximum attempts exhausted before recovery",
          updatedAt: this.#clock.now(),
        });
        dead++;
        continue;
      }
      let command: IngestKnowledgeCommand;
      try {
        command = parseIngestCommand(job.commandJson);
      } catch (error: unknown) {
        await this.#persistJob({
          ...this.#withoutLease(job),
          state: "dead",
          error: error instanceof Error ? error.message : String(error),
          updatedAt: this.#clock.now(),
        });
        invalid++;
        continue;
      }
      const recoveredJob: PersistedKnowledgeJob = {
        ...this.#withoutLease(job),
        state: "queued",
        ...(job.state === "leased" || job.state === "running"
          ? { error: `Lease taken over from ${job.leaseOwner ?? "unknown worker"}` }
          : {}),
        updatedAt: this.#clock.now(),
      };
      await this.#persistJob(recoveredJob);
      const scheduled = this.#scheduleJob(recoveredJob, command, {
        priority: "background",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      void scheduled.promise.catch(() => undefined);
      recovered++;
    }
    const migrations = await recoverKnowledgeEmbeddingMigrationJobs(
      this.#store,
      this.#scheduler,
      this.#embedding,
      {
        clock: this.#clock,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    return {
      inspected: documents.length + migrations.inspected,
      recovered: recovered + migrations.recovered,
      dead: dead + migrations.dead,
      invalid,
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
        let queryVector: EmbeddingVector | undefined = query.queryEmbedding;
        if (queryVector !== undefined && queryVector.values.length !== this.#dimensions) {
          degraded.push("embedding:dimension-mismatch");
          queryVector = undefined;
        }
        if (queryVector === undefined) {
          try {
            queryVector = await this.#queryEmbedding(query.text, { ...options, signal });
          } catch (error: unknown) {
            throwIfAborted(signal, "knowledge-search");
            degraded.push(`embedding:${error instanceof Error ? error.name : "error"}`);
          }
        }
        stages["embedding"] = performance.now() - embeddingStarted;
        const namespace = secureNamespace(
          query.namespace ?? this.#defaultNamespace,
          query.scopeContext,
        );
        const filter = `namespace = ${quoteFilter(namespace)} AND status = "active"`;
        const zvecStarted = performance.now();
        const searches = await Promise.allSettled([
          queryVector === undefined
            ? Promise.resolve([])
            : this.#store.vectorSearch({
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
            if (stringField(fieldsOf(document), "namespace", "") !== namespace) continue;
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
        if (
          hits.length === 0 &&
          query.scopeContext?.tenantId === "local" &&
          query.scopeContext.userId === "local" &&
          query.scopeContext.appId === "pi"
        ) {
          return this.search(
            {
              text: query.text,
              ...(query.namespace === undefined ? {} : { namespace: query.namespace }),
              limit,
            },
            options,
          );
        }
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
    const sourceNamespace = sourcePayload?.["namespace"];
    if (
      sourcePayload !== undefined &&
      (typeof sourceNamespace !== "string" ||
        !sourceNamespace.startsWith(`${securityBoundary(command.scopeContext)}::`))
    ) {
      return { sourceId: command.sourceId, removedChunks: 0 };
    }
    const chunks = await this.#store.filterVectors(
      "knowledge",
      `source_id = ${quoteFilter(command.sourceId)} AND namespace = ${quoteFilter(
        typeof sourceNamespace === "string"
          ? sourceNamespace
          : secureNamespace(this.#defaultNamespace, command.scopeContext),
      )}`,
    );
    await this.#store.deleteVectors(
      "knowledge",
      chunks.map((document) => document.id),
    );
    if (sourcePayload !== undefined) {
      const now = this.#clock.now();
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
        ...(command.scopeContext === undefined ? {} : { scopeContext: command.scopeContext }),
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
      .filter((chunk) => chunk.namespace.startsWith(`${securityBoundary(query.scopeContext)}::`))
      .sort((left, right) => left.ordinal - right.ordinal);
    if (chunks.length === 0) return undefined;
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

  #scheduleJob(
    initial: PersistedKnowledgeJob,
    command: IngestKnowledgeCommand,
    options: EnqueueOptions,
  ): ReturnType<BackgroundScheduler["schedule"]> {
    const scheduled = this.#scheduler.schedule({
      id: initial.jobId,
      deduplicationKey: initial.deduplicationKey,
      priority:
        options.priority === "background"
          ? TaskPriority.BackgroundSync
          : TaskPriority.UserRequested,
      estimatedBytes: Buffer.byteLength(initial.commandJson, "utf8"),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      run: async (signal) => {
        let job = initial;
        let lastError: unknown;
        while (job.attempts < job.maxAttempts) {
          throwIfAborted(signal, "knowledge-ingest-job");
          const leasedAt = this.#clock.now();
          job = {
            ...this.#withoutLease(job),
            state: "leased",
            attempts: job.attempts + 1,
            leaseOwner: this.#workerId,
            leaseExpiresAt: leasedAt + JOB_LEASE_MS,
            updatedAt: leasedAt,
          };
          await this.#persistJob(job);
          job = { ...job, state: "running", updatedAt: this.#clock.now() };
          await this.#persistJob(job);
          try {
            const result = await this.ingest(command, { ...options, signal });
            const succeeded: PersistedKnowledgeJob = {
              ...this.#withoutLease(job),
              state: "succeeded",
              result,
              updatedAt: this.#clock.now(),
            };
            await this.#persistJob(succeeded);
            return result;
          } catch (error: unknown) {
            lastError = error;
            const message = error instanceof Error ? error.message : String(error);
            const failed: PersistedKnowledgeJob = {
              ...this.#withoutLease(job),
              state: "failed",
              error: message,
              updatedAt: this.#clock.now(),
            };
            await this.#persistJob(failed);
            if (signal.aborted) throw error;
            if (!retryableJobError(error) || failed.attempts >= failed.maxAttempts) {
              await this.#persistJob({
                ...failed,
                state: "dead",
                updatedAt: this.#clock.now(),
              });
              throw error;
            }
            job = { ...failed, state: "queued", updatedAt: this.#clock.now() };
            await this.#persistJob(job);
            await this.#retryDelay(250 * 2 ** Math.max(0, job.attempts - 1), signal);
          }
        }
        throw lastError instanceof Error ? lastError : new Error("Knowledge job exhausted retries");
      },
    });
    if (options.onDone) {
      const onDone = options.onDone;
      void scheduled.promise
        .then((result) => onDone(result))
        .catch((error: unknown) =>
          onDone(error instanceof Error ? error : new Error(String(error))),
        );
    }
    return scheduled;
  }

  async #findActiveJob(deduplicationKey: string): Promise<PersistedKnowledgeJob | undefined> {
    const documents = await this.#store.filterScalar(
      "jobs_v1",
      'kind = "knowledge-ingest" AND (status = "queued" OR status = "leased" OR status = "running" OR status = "failed")',
      10_000,
    );
    for (const document of documents) {
      const job = this.#decodeJob(decodeStoredPayload(document));
      if (job?.deduplicationKey === deduplicationKey) return job;
    }
    return undefined;
  }

  #decodeJob(payload: Readonly<Record<string, unknown>>): PersistedKnowledgeJob | undefined {
    if (
      typeof payload["jobId"] !== "string" ||
      typeof payload["deduplicationKey"] !== "string" ||
      typeof payload["commandHash"] !== "string" ||
      typeof payload["commandJson"] !== "string" ||
      typeof payload["namespace"] !== "string" ||
      typeof payload["state"] !== "string" ||
      !["queued", "leased", "running", "succeeded", "failed", "dead"].includes(payload["state"]) ||
      typeof payload["attempts"] !== "number" ||
      typeof payload["maxAttempts"] !== "number" ||
      typeof payload["createdAt"] !== "number" ||
      typeof payload["updatedAt"] !== "number"
    ) {
      return undefined;
    }
    return payload as unknown as PersistedKnowledgeJob;
  }

  #withoutLease(
    job: PersistedKnowledgeJob,
  ): Omit<PersistedKnowledgeJob, "leaseOwner" | "leaseExpiresAt"> {
    const { leaseOwner: _leaseOwner, leaseExpiresAt: _leaseExpiresAt, ...rest } = job;
    void _leaseOwner;
    void _leaseExpiresAt;
    return rest;
  }

  async #persistJob(job: PersistedKnowledgeJob): Promise<void> {
    await this.#store.upsertScalar("jobs_v1", [
      {
        id: job.jobId,
        kind: "knowledge-ingest",
        namespace: job.namespace,
        status: job.state,
        payload: job as unknown as Readonly<Record<string, unknown>>,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      },
    ]);
  }

  async #retryDelay(delayMs: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason instanceof Error ? signal.reason : new Error("Job cancelled"));
        },
        { once: true },
      );
    });
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

  #chunkRecord(chunk: KnowledgeChunk, status: "preparing" | "active"): StoredVectorRecord {
    const { embedding, ...payload } = chunk;
    return {
      id: chunk.id,
      kind: "knowledge",
      namespace: chunk.namespace,
      status,
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
