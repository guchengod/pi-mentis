import {
  EvidenceAuthority,
  ForegroundExecutor,
  contentHash,
  normalizeText,
  stableHash,
  throwIfAborted,
  type OperationOptions,
  type EvidenceRef,
  type SearchHit,
} from "@pi-mentis/pi-mentis-core";
import {
  BoundedTtlCache,
  embeddingSpaceId,
  type EmbeddingProvider,
  type EmbeddingSpaceIdentity,
  type EmbeddingVector,
} from "@pi-mentis/pi-mentis-inference";
import { InMemoryTelemetry, measure } from "@pi-mentis/pi-mentis-observability";
import { ZvecStore, decodeStoredPayload, type StoredVectorRecord } from "@pi-mentis/pi-mentis-zvec";

import type {
  CommitMemoryCommand,
  CommitMemoryResult,
  MemoryQuery,
  MemoryRecord,
  MemoryGetOptions,
  MemorySearchOptions,
  MemoryService,
  MemoryDomain,
} from "./types.js";

export interface CreateMemoryServiceOptions {
  readonly store: ZvecStore;
  readonly embedding: EmbeddingProvider;
  readonly embeddingSpace: EmbeddingSpaceIdentity;
  readonly dimensions: number;
  readonly telemetry?: InMemoryTelemetry;
}

function quoteFilter(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function boundaryKey(
  context: CommitMemoryCommand["scopeContext"] | MemoryQuery["scopeContext"],
): string {
  return [
    context?.tenantId ?? "local",
    context?.userId ?? "local",
    context?.appId ?? "pi",
    context?.agentId ?? "pi-mentis",
  ]
    .map((value) => encodeURIComponent(value))
    .join(":");
}

function scopedNamespace(
  scope: MemoryRecord["scope"],
  context: CommitMemoryCommand["scopeContext"] | MemoryQuery["scopeContext"],
): string {
  return `${boundaryKey(context)}::${scope.kind}:${scope.id}`;
}

function withoutEmbedding(record: MemoryRecord): Omit<MemoryRecord, "embedding"> {
  const { embedding: _embedding, ...view } = record;
  void _embedding;
  return view;
}

function fields(document: { readonly fields: Record<string, unknown> }): Record<string, unknown> {
  return document.fields;
}

function polarity(text: string): "positive" | "negative" {
  return /\b(?:not|never|no longer|禁止|不要|不能|不再)\b/i.test(text) ? "negative" : "positive";
}

function cosineSimilarity(score: number): number {
  // Zvec returns cosine distance (0 is identical), not cosine similarity.
  return 1 - score;
}

function inferDomain(command: CommitMemoryCommand): MemoryDomain {
  if (command.domain !== undefined) return command.domain;
  if (command.type === "preference") return "user";
  if (command.type === "procedural") return "procedure";
  if (command.type === "episodic") return "episodic";
  if (command.type === "task") return "task";
  if (
    command.scope.kind === "repository" ||
    command.scope.kind === "project" ||
    command.scopeContext?.repositoryId !== undefined ||
    command.scopeContext?.projectId !== undefined
  ) {
    return "project";
  }
  return "topic";
}

export class DefaultMemoryService implements MemoryService {
  readonly #store: ZvecStore;
  readonly #embedding: EmbeddingProvider;
  readonly #embeddingSpace: EmbeddingSpaceIdentity;
  readonly #embeddingSpaceId: string;
  readonly #dimensions: number;
  readonly #telemetry: InMemoryTelemetry;
  readonly #queryCache = new BoundedTtlCache<EmbeddingVector>(512, 300_000);
  readonly #foreground = new ForegroundExecutor();

  constructor(options: CreateMemoryServiceOptions) {
    this.#store = options.store;
    this.#embedding = options.embedding;
    this.#embeddingSpace = options.embeddingSpace;
    this.#embeddingSpaceId = embeddingSpaceId(options.embeddingSpace);
    this.#dimensions = options.dimensions;
    this.#telemetry = options.telemetry ?? new InMemoryTelemetry();
  }

  async commit(
    command: CommitMemoryCommand,
    options: OperationOptions = {},
  ): Promise<CommitMemoryResult> {
    throwIfAborted(options.signal, "memory-commit");
    const normalizedContent = normalizeText(command.content);
    if (normalizedContent.length < 3 || normalizedContent.length > 100_000) {
      throw new Error("Memory content must contain 3 through 100000 normalized characters");
    }
    const hash = contentHash(normalizedContent);
    const scopeKey = scopedNamespace(command.scope, command.scopeContext);
    const exact = await this.#store.filterVectors(
      "memory",
      `content_hash = ${quoteFilter(hash)} AND namespace = ${quoteFilter(scopeKey)}`,
      2,
    );
    const now = Date.now();
    if (exact[0] !== undefined) {
      const payload = decodeStoredPayload(exact[0]);
      const existing = payload as unknown as Omit<MemoryRecord, "embedding">;
      const stored = await this.#store.fetchVectors("memory", [existing.id]);
      const vector = stored.get(existing.id)?.vectors["embedding"];
      if (!(vector instanceof Float32Array) && !Array.isArray(vector)) {
        throw new Error(`Memory ${existing.id} has no Embedding vector`);
      }
      const record: MemoryRecord = {
        ...existing,
        embedding: vector instanceof Float32Array ? vector : Float32Array.from(vector),
        confidence: Math.min(1, Math.max(existing.confidence, command.confidence ?? 0.8)),
        importance: Math.min(1, Math.max(existing.importance, command.importance ?? 0.5)),
        updatedAt: now,
        lastAccessedAt: now,
        reinforceCount: existing.reinforceCount + 1,
        revision: existing.revision + 1,
        status: "active",
      };
      await this.#store.upsertVectors("memory", [this.#record(record)]);
      return { outcome: "reinforced", record: withoutEmbedding(record), relatedIds: [record.id] };
    }
    const response = await this.#embedding.embed(
      {
        inputs: [normalizedContent],
        inputKind: "memory",
        dimensions: this.#dimensions,
        truncate: "reject",
      },
      {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
        priority: "interactive",
      },
    );
    const embedding = response.vectors[0];
    if (embedding === undefined) throw new Error("Memory Embedding response is empty");
    const neighbors = await this.#store.vectorSearch({
      kind: "memory",
      vector: embedding.values,
      topK: 5,
      filter: `namespace = ${quoteFilter(scopeKey)} AND status = "active"`,
    });
    const semanticDuplicate =
      (command.supersedesIds?.length ?? 0) > 0
        ? undefined
        : neighbors.find((neighbor) => {
            const existingContent = decodeStoredPayload(neighbor)["content"];
            return (
              // BGE-M3 scores production paraphrases more conservatively than
              // exact copies. Scope and polarity gates keep this threshold
              // from merging unrelated records.
              cosineSimilarity(neighbor.score) >= 0.78 &&
              typeof existingContent === "string" &&
              polarity(existingContent) === polarity(normalizedContent)
            );
          });
    if (semanticDuplicate !== undefined) {
      const stored = (await this.#store.fetchVectors("memory", [semanticDuplicate.id])).get(
        semanticDuplicate.id,
      );
      const vector = stored?.vectors["embedding"];
      if (stored !== undefined && (vector instanceof Float32Array || Array.isArray(vector))) {
        const existing = decodeStoredPayload(stored) as unknown as Omit<MemoryRecord, "embedding">;
        const record: MemoryRecord = {
          ...existing,
          embedding: vector instanceof Float32Array ? vector : Float32Array.from(vector),
          confidence: Math.min(1, Math.max(existing.confidence, command.confidence ?? 0.8)),
          importance: Math.min(1, Math.max(existing.importance, command.importance ?? 0.5)),
          updatedAt: now,
          lastAccessedAt: now,
          reinforceCount: existing.reinforceCount + 1,
          revision: existing.revision + 1,
          status: "active",
        };
        await this.#store.upsertVectors("memory", [this.#record(record)]);
        return { outcome: "reinforced", record: withoutEmbedding(record), relatedIds: [record.id] };
      }
    }
    const conflicts = neighbors
      .filter(
        (neighbor) =>
          cosineSimilarity(neighbor.score) >= 0.82 &&
          polarity(
            typeof decodeStoredPayload(neighbor)["content"] === "string"
              ? (decodeStoredPayload(neighbor)["content"] as string)
              : "",
          ) !== polarity(normalizedContent),
      )
      .map((neighbor) => neighbor.id);
    const supersedesIds = [...new Set(command.supersedesIds ?? [])];
    const confidence = Math.max(0, Math.min(1, command.confidence ?? 0.8));
    const importance = Math.max(0, Math.min(1, command.importance ?? 0.5));
    const pending = confidence < 0.6 || command.authority <= EvidenceAuthority.AssistantInference;
    const id = stableHash("memory:v1", scopeKey, hash);
    const status = conflicts.length > 0 ? "conflicted" : pending ? "pending" : "active";
    const record: MemoryRecord = {
      id,
      content: command.content,
      normalizedContent,
      contentHash: hash,
      type: command.type,
      domain: inferDomain(command),
      scope: command.scope,
      ...(command.scopeContext === undefined ? {} : { scopeContext: command.scopeContext }),
      confidence,
      importance,
      authority: command.authority,
      evidenceRefs: command.evidenceRefs ?? [],
      supersedesIds,
      conflictsWithIds: conflicts,
      status,
      embeddingSpaceId: this.#embeddingSpaceId,
      embedding: embedding.values,
      createdAt: now,
      updatedAt: now,
      observedAt: now,
      validFrom: now,
      lastAccessedAt: now,
      reinforceCount: 0,
      revision: 1,
    };
    await this.#store.upsertVectors("memory", [this.#record(record)]);
    if (supersedesIds.length > 0) {
      const previous = await this.#store.fetchVectors("memory", supersedesIds);
      const updates: StoredVectorRecord[] = [];
      for (const [previousId, stored] of previous) {
        const payload = decodeStoredPayload(stored) as unknown as Omit<MemoryRecord, "embedding">;
        const vector = stored.vectors["embedding"];
        if (!(vector instanceof Float32Array) && !Array.isArray(vector)) continue;
        updates.push(
          this.#record({
            ...payload,
            id: previousId,
            embedding: vector instanceof Float32Array ? vector : Float32Array.from(vector),
            status: "superseded",
            supersededById: record.id,
            validUntil: now,
            updatedAt: now,
            revision: payload.revision + 1,
          }),
        );
      }
      await this.#store.upsertVectors("memory", updates);
    }
    const outcome =
      conflicts.length > 0 ? "conflict" : supersedesIds.length > 0 ? "superseded" : "created";
    return {
      outcome,
      record: withoutEmbedding(record),
      relatedIds: [...supersedesIds, ...conflicts],
    };
  }

  async search(
    query: MemoryQuery,
    options: MemorySearchOptions = {},
  ): Promise<import("@pi-mentis/pi-mentis-core").SearchResult> {
    const started = performance.now();
    return this.#foreground.execute(
      "memory-search",
      options.timeoutMs ?? 3_000,
      async (signal) => {
        const key = stableHash(
          "memory-query:v1",
          this.#embedding.id,
          this.#embeddingSpace.modelId,
          String(this.#dimensions),
          contentHash(query.text),
        );
        let vector = this.#queryCache.get(key);
        const stages: Record<string, number> = {};
        if (vector === undefined) {
          const embeddingStarted = performance.now();
          const response = await measure(this.#telemetry, "embedding_duration_ms", () =>
            this.#embedding.embed(
              {
                inputs: [query.text],
                inputKind: "query",
                dimensions: this.#dimensions,
                truncate: "reject",
              },
              { signal, priority: "interactive" },
            ),
          );
          vector = response.vectors[0];
          if (vector === undefined) throw new Error("Memory query Embedding response is empty");
          this.#queryCache.set(key, vector);
          stages["embedding"] = performance.now() - embeddingStarted;
        } else {
          stages["embedding"] = 0;
        }
        const scopeFilter =
          query.scopes === undefined || query.scopes.length === 0
            ? 'status = "active"'
            : `status = "active" AND (${query.scopes
                .map(
                  (scope) =>
                    `namespace = ${quoteFilter(scopedNamespace(scope, query.scopeContext))}`,
                )
                .join(" OR ")})`;
        const limit = Math.max(1, Math.min(100, query.limit ?? 20));
        const zvecStarted = performance.now();
        const results = await Promise.allSettled([
          this.#store.vectorSearch({
            kind: "memory",
            vector: vector.values,
            topK: limit * 2,
            filter: scopeFilter,
          }),
          this.#store.ftsSearch({
            kind: "memory",
            query: query.text,
            topK: limit * 2,
            filter: scopeFilter,
          }),
        ]);
        stages["zvec"] = performance.now() - zvecStarted;
        const degraded: string[] = [];
        const fused = new Map<string, SearchHit>();
        for (const [sourceIndex, result] of results.entries()) {
          if (result.status === "rejected") {
            degraded.push(sourceIndex === 0 ? "dense-unavailable" : "fts-unavailable");
            continue;
          }
          for (const [rank, stored] of result.value.entries()) {
            const payload = decodeStoredPayload(stored);
            const text = typeof payload["content"] === "string" ? payload["content"] : "";
            const rawFields = fields(stored);
            const authority =
              typeof rawFields["authority"] === "number"
                ? rawFields["authority"]
                : EvidenceAuthority.EpisodicMemory;
            const previous = fused.get(stored.id);
            fused.set(stored.id, {
              id: stored.id,
              kind: "memory",
              text,
              score: (previous?.score ?? 0) + 1 / (60 + rank + 1),
              tokenCount:
                typeof rawFields["token_count"] === "number" ? rawFields["token_count"] : 1,
              authority: authority as SearchHit["authority"],
              namespace:
                typeof rawFields["namespace"] === "string"
                  ? rawFields["namespace"]
                  : "user:default",
              contentHash:
                typeof rawFields["content_hash"] === "string"
                  ? rawFields["content_hash"]
                  : contentHash(text),
              metadata: payload,
            });
          }
        }
        return {
          hits: [...fused.values()].sort((left, right) => right.score - left.score).slice(0, limit),
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

  async get(
    id: string,
    options: MemoryGetOptions = {},
  ): Promise<Omit<MemoryRecord, "embedding"> | undefined> {
    throwIfAborted(options.signal, "memory-get");
    const stored = (await this.#store.fetchVectors("memory", [id])).get(id);
    if (stored === undefined) return undefined;
    const record = decodeStoredPayload(stored) as unknown as Omit<MemoryRecord, "embedding">;
    if (
      options.scopeContext !== undefined &&
      boundaryKey(record.scopeContext) !== boundaryKey(options.scopeContext)
    ) {
      return undefined;
    }
    return record;
  }

  async tombstone(id: string, options: OperationOptions = {}): Promise<boolean> {
    throwIfAborted(options.signal, "memory-tombstone");
    const stored = (await this.#store.fetchVectors("memory", [id])).get(id);
    if (stored === undefined) return false;
    const payload = decodeStoredPayload(stored) as unknown as Omit<MemoryRecord, "embedding">;
    const vector = stored.vectors["embedding"];
    if (!(vector instanceof Float32Array) && !Array.isArray(vector)) return false;
    await this.#store.upsertVectors("memory", [
      this.#record({
        ...payload,
        embedding: vector instanceof Float32Array ? vector : Float32Array.from(vector),
        status: "tombstoned",
        validUntil: Date.now(),
        updatedAt: Date.now(),
        revision: payload.revision + 1,
      }),
    ]);
    return true;
  }

  async markConflicted(
    id: string,
    evidence: EvidenceRef,
    options: OperationOptions = {},
  ): Promise<Omit<MemoryRecord, "embedding"> | undefined> {
    throwIfAborted(options.signal, "memory-mark-conflicted");
    const stored = (await this.#store.fetchVectors("memory", [id])).get(id);
    if (stored === undefined) return undefined;
    const payload = decodeStoredPayload(stored) as unknown as Omit<MemoryRecord, "embedding">;
    const vector = stored.vectors["embedding"];
    if (!(vector instanceof Float32Array) && !Array.isArray(vector)) return undefined;
    const now = Date.now();
    const record: MemoryRecord = {
      ...payload,
      embedding: vector instanceof Float32Array ? vector : Float32Array.from(vector),
      status: "conflicted",
      conflictsWithIds: [...new Set([...payload.conflictsWithIds, evidence.id])],
      evidenceRefs: [
        ...payload.evidenceRefs,
        ...(payload.evidenceRefs.some(
          (existing) => existing.kind === evidence.kind && existing.id === evidence.id,
        )
          ? []
          : [evidence]),
      ],
      updatedAt: now,
      revision: payload.revision + 1,
    };
    await this.#store.upsertVectors("memory", [this.#record(record)]);
    return withoutEmbedding(record);
  }

  #record(record: MemoryRecord): StoredVectorRecord {
    const { embedding, ...payload } = record;
    const namespace = scopedNamespace(record.scope, record.scopeContext);
    return {
      id: record.id,
      kind: "memory",
      namespace,
      status: record.status,
      payload: payload as unknown as Readonly<Record<string, unknown>>,
      searchableText: record.normalizedContent,
      contentHash: record.contentHash,
      sourceId: namespace,
      documentId: record.id,
      authority: record.authority,
      tokenCount: Math.max(1, Buffer.byteLength(record.normalizedContent, "utf8")),
      revision: record.revision,
      embedding,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}

export function createMemoryService(options: CreateMemoryServiceOptions): MemoryService {
  return new DefaultMemoryService(options);
}
