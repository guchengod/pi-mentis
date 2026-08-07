import {
  EvidenceAuthority,
  ForegroundExecutor,
  contentHash,
  normalizeText,
  stableHash,
  systemClock,
  throwIfAborted,
  type Clock,
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
import {
  ZvecStateStore,
  type ZvecStore,
  decodeStoredPayload,
  type StoredVectorRecord,
} from "@pi-mentis/pi-mentis-zvec";

import { TemporalTruthEngine, type TemporalPlan } from "./temporal.js";
import { HierarchicalViewService, type ViewKind } from "./views.js";
import { deriveFactKey as deriveFactKeyNew } from "./fact-key.js";
import { planCommit } from "./commit-planner.js";
import { classifySensitivity, toRemoteSafe } from "./secret-detector.js";

import type {
  CommitMemoryCommand,
  CommitMemoryResult,
  MemoryQuery,
  MemoryRecord,
  MemoryGetOptions,
  MemoryMutationOptions,
  MemorySearchOptions,
  MemoryService,
  MemoryDomain,
  PiScopeContext,
  MentisSecurityMode,
  ResourceOwnership,
  RelevanceScope,
} from "./types.js";

export interface CreateMemoryServiceOptions {
  readonly store: ZvecStore;
  readonly embedding: EmbeddingProvider;
  readonly embeddingSpace: EmbeddingSpaceIdentity;
  readonly dimensions: number;
  readonly telemetry?: InMemoryTelemetry;
  readonly clock?: Clock;
  readonly viewsEnabled?: boolean;
  readonly viewTtlMs?: number;
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
  return planCommit(command.content, command.type, command.scopeContext, {
    domain: command.domain,
    scope: command.scope,
  }).domain;
}

export function deriveFactKey(
  command: Pick<CommitMemoryCommand, "content" | "type" | "domain">,
): string {
  // Bridge: use the new fact-key registry under the hood
  const domain = command.domain ?? "topic";
  return deriveFactKeyNew(command.content, domain as MemoryDomain, undefined).factKey;
}

function defaultCardinality(type: CommitMemoryCommand["type"]) {
  // Only events and tasks get event cardinality by type default
  if (type === "episodic" || type === "task") return "event" as const;
  // All other types default to single — set cardinality is determined by predicate
  return "single" as const;
}

function statusForTemporalState(state: MemoryRecord["temporalState"]): MemoryRecord["status"] {
  if (state === "retracted") return "tombstoned";
  if (state === "pending") return "pending";
  if (state === "rejected") return "rejected";
  if (state === "historical") return "superseded";
  if (state === "conflicted") return "conflicted";
  return "active";
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
  readonly #clock: Clock;
  readonly #temporal: TemporalTruthEngine;
  readonly #state: ZvecStateStore;
  readonly #idempotent = new Map<string, Promise<CommitMemoryResult>>();
  readonly #factLocks = new Map<string, Promise<void>>();
  readonly #views: HierarchicalViewService | undefined;

  constructor(options: CreateMemoryServiceOptions) {
    this.#store = options.store;
    this.#embedding = options.embedding;
    this.#embeddingSpace = options.embeddingSpace;
    this.#embeddingSpaceId = embeddingSpaceId(options.embeddingSpace);
    this.#dimensions = options.dimensions;
    this.#telemetry = options.telemetry ?? new InMemoryTelemetry();
    this.#clock = options.clock ?? systemClock;
    this.#temporal = new TemporalTruthEngine(options.store, this.#clock);
    this.#state = new ZvecStateStore(options.store);
    this.#views =
      options.viewsEnabled === false
        ? undefined
        : new HierarchicalViewService(options.store, {
            clock: this.#clock,
            ...(options.viewTtlMs === undefined ? {} : { ttlMs: options.viewTtlMs }),
          });
  }

  async commit(
    command: CommitMemoryCommand,
    options: OperationOptions = {},
  ): Promise<CommitMemoryResult> {
    const key = command.idempotencyKey;
    if (key === undefined) return this.#commitOnce(command, options);
    const namespace = scopedNamespace(command.scope, command.scopeContext);
    const stateId = this.#state.id("memory-idempotency", namespace, key);
    const commandHash = stableHash(
      "memory-idempotency-command:v1",
      JSON.stringify({
        content: normalizeText(command.content),
        type: command.type,
        domain: command.domain,
        scope: command.scope,
        scopeContext: command.scopeContext,
        confidence: command.confidence,
        importance: command.importance,
        authority: command.authority,
        evidenceRefs: command.evidenceRefs?.map(({ kind, id }) => ({ kind, id })),
        supersedesIds: command.supersedesIds,
        factKey: command.factKey,
        cardinality: command.cardinality,
        retractsFact: command.retractsFact,
        branchClaimState: command.branchClaimState,
        applicability: command.applicability,
        premises: command.premises,
        contentOrigin: command.contentOrigin,
      }),
    );
    const persisted = await this.#state.get<{
      readonly commandHash: string;
      readonly result?: CommitMemoryResult;
    }>(stateId);
    if (persisted?.value.commandHash !== undefined && persisted.value.commandHash !== commandHash) {
      throw new Error(`Idempotency key ${key} was already used for a different memory command`);
    }
    if (persisted?.value.result !== undefined) return persisted.value.result;
    const running = this.#idempotent.get(stateId);
    if (running !== undefined) return running;
    const promise = (async () => {
      await this.#state.put(
        {
          id: stateId,
          kind: "memory-idempotency",
          namespace,
          value: { commandHash, state: "running" },
        },
        { status: "running", now: this.#clock.now() },
      );
      try {
        const result = await this.#commitOnce(command, options);
        await this.#state.put(
          {
            id: stateId,
            kind: "memory-idempotency",
            namespace,
            value: { commandHash, state: "completed", result },
          },
          { status: "completed", now: this.#clock.now() },
        );
        return result;
      } catch (error: unknown) {
        await this.#state.put(
          {
            id: stateId,
            kind: "memory-idempotency",
            namespace,
            value: {
              commandHash,
              state: "failed",
              failure: error instanceof Error ? error.message : String(error),
            },
          },
          { status: "failed", now: this.#clock.now() },
        );
        throw error;
      } finally {
        this.#idempotent.delete(stateId);
      }
    })();
    this.#idempotent.set(stateId, promise);
    return promise;
  }

  async #commitOnce(
    command: CommitMemoryCommand,
    options: OperationOptions = {},
  ): Promise<CommitMemoryResult> {
    const factKey = command.factKey ?? deriveFactKey(command);
    const lockKey = `${scopedNamespace(command.scope, command.scopeContext)}::${factKey}`;
    const previous = this.#factLocks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#factLocks.set(lockKey, queued);
    await previous;
    try {
      return await this.#commitUnlocked({ ...command, factKey }, options);
    } finally {
      release();
      if (this.#factLocks.get(lockKey) === queued) this.#factLocks.delete(lockKey);
    }
  }

  async #commitUnlocked(
    command: CommitMemoryCommand,
    options: OperationOptions = {},
  ): Promise<CommitMemoryResult> {
    throwIfAborted(options.signal, "memory-commit");
    // ── Sensitivity classification (classify, don't destroy) ──
    const sensitivity = classifySensitivity(command.content);
    // Local storage preserves original content.
    // Only drop if the content is entirely a high-confidence secret token
    // (e.g., a bare API key with no surrounding context).
    if (
      sensitivity.categories.some((c) => c === "private_key" || c === "certificate") &&
      sensitivity.sensitivity === "secret"
    ) {
      return {
        outcome: "rejected_sensitive",
        record: undefined as unknown as Omit<MemoryRecord, "embedding">,
        relatedIds: [],
      };
    }
    const evidenceIntegrity = await this.#evidenceIntegrity(
      command.evidenceRefs ?? [],
      command.scopeContext,
    );
    if (command.authority >= EvidenceAuthority.UserKnowledge && evidenceIntegrity !== "valid") {
      command = {
        ...command,
        authority: EvidenceAuthority.AssistantInference,
        confidence: Math.min(command.confidence ?? 0.8, 0.5),
      };
    }
    const normalizedContent = normalizeText(command.content);
    if (normalizedContent.length < 3 || normalizedContent.length > 100_000) {
      throw new Error("Memory content must contain 3 through 100000 normalized characters");
    }
    const hash = contentHash(normalizedContent);
    const scopeKey = scopedNamespace(command.scope, command.scopeContext);
    await this.#assertMemoryIdsInNamespace(command.supersedesIds ?? [], scopeKey);
    const exact = await this.#store.filterVectors(
      "memory",
      `content_hash = ${quoteFilter(hash)} AND namespace = ${quoteFilter(scopeKey)}`,
      2,
    );
    const now = this.#clock.now();
    if (exact[0] !== undefined) {
      const payload = decodeStoredPayload(exact[0]);
      const existing = payload as unknown as Omit<MemoryRecord, "embedding">;
      const stored = await this.#store.fetchVectors("memory", [existing.id]);
      const vector = stored.get(existing.id)?.vectors["embedding"];
      if (!(vector instanceof Float32Array) && !Array.isArray(vector)) {
        throw new Error(`Memory ${existing.id} has no Embedding vector`);
      }
      const factKey = command.factKey ?? deriveFactKey(command);
      const cardinality =
        command.cardinality ?? existing.cardinality ?? defaultCardinality(command.type);
      const temporalPlan = await this.#temporal.prepare({
        factKey,
        cardinality,
        scope: command.scope,
        ...(command.scopeContext === undefined ? {} : { scopeContext: command.scopeContext }),
        memoryId: existing.id,
        contentHash: hash,
        authority: command.authority,
        observedAt: command.observedAt ?? now,
        ...(command.retractsFact === undefined ? {} : { retractsFact: command.retractsFact }),
        ...(command.branchClaimState === undefined
          ? {}
          : { branchClaimState: command.branchClaimState }),
      });
      const record: MemoryRecord = {
        ...existing,
        embedding: vector instanceof Float32Array ? vector : Float32Array.from(vector),
        confidence: Math.min(1, Math.max(existing.confidence, command.confidence ?? 0.8)),
        importance: Math.min(1, Math.max(existing.importance, command.importance ?? 0.5)),
        updatedAt: now,
        lastAccessedAt: now,
        reinforceCount: existing.reinforceCount + 1,
        revision: existing.revision + 1,
        status: statusForTemporalState(temporalPlan.temporalState),
        factKey,
        cardinality,
        temporalState: temporalPlan.temporalState,
        observedAt: Math.max(existing.observedAt, command.observedAt ?? now),
        authority: Math.max(existing.authority, command.authority) as MemoryRecord["authority"],
        supersedesIds: [...new Set([...existing.supersedesIds, ...temporalPlan.supersedesIds])],
        conflictsWithIds: [
          ...new Set([...existing.conflictsWithIds, ...temporalPlan.conflictsWithIds]),
        ],
        evidenceRefs: [
          ...existing.evidenceRefs,
          ...(command.evidenceRefs ?? []).filter(
            (candidate) =>
              !existing.evidenceRefs.some(
                (item) => item.kind === candidate.kind && item.id === candidate.id,
              ),
          ),
        ],
        evidenceIntegrity,
      };
      await this.#store.upsertVectors("memory", [this.#record(record)]);
      await this.#temporal.claimWritten(temporalPlan);
      await this.#applyRelatedTemporalStates(temporalPlan, record.id, now);
      await this.#temporal.apply(temporalPlan);
      await this.#views?.enqueueMemory(withoutEmbedding(record));
      return {
        outcome: temporalPlan.decision === "supersede" ? "superseded" : "reinforced",
        record: withoutEmbedding(record),
        relatedIds: [record.id, ...temporalPlan.supersedesIds, ...temporalPlan.conflictsWithIds],
      };
    }
    // ── Remote safety: produce safe content for embedding ──
    const remoteSafe = toRemoteSafe(normalizedContent);
    const skipEmbedding = remoteSafe.policy === "local_only" || remoteSafe.policy === "drop";
    let embedding: { values: Float32Array } | undefined;

    if (skipEmbedding) {
      embedding = { values: new Float32Array(this.#dimensions) };
    } else {
      const contentForEmbedding = remoteSafe.text ?? normalizedContent;
      const response = await measure(this.#telemetry, "embedding_duration_ms", () =>
        this.#embedding.embed(
          {
            inputs: [contentForEmbedding],
            inputKind: "memory",
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
      const vec = response.vectors[0];
      if (vec === undefined) throw new Error("Memory Embedding response is empty");
      embedding = vec;
    }

    const neighbors = skipEmbedding
      ? []
      : await this.#store.vectorSearch({
          kind: "memory",
          vector: embedding.values,
          topK: 5,
          filter: `namespace = ${quoteFilter(scopeKey)} AND status = "active"`,
        });
    // Event guard: episodic events and event-cardinality records must NOT
    // be deduplicated by semantic similarity — only by exact idempotency key
    // or exact content hash match.
    const commitDomain = inferDomain(command);
    const isEvent =
      commitDomain === "episodic" ||
      command.cardinality === "event" ||
      (command.cardinality === undefined &&
        (command.type === "episodic" || command.type === "task"));
    const semanticDuplicate =
      (command.supersedesIds?.length ?? 0) > 0 || command.cardinality === "single" || isEvent
        ? undefined
        : neighbors.find((neighbor) => {
            const payload = decodeStoredPayload(neighbor);
            const existingContent = payload["content"];
            // Also skip if the neighbor itself is an event
            const neighborCardinality = payload["cardinality"] as string | undefined;
            const neighborDomain = payload["domain"] as string | undefined;
            if (neighborCardinality === "event" || neighborDomain === "episodic") {
              return false;
            }
            return (
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
        const factKey = command.factKey ?? existing.factKey ?? deriveFactKey(command);
        const cardinality =
          command.cardinality ?? existing.cardinality ?? defaultCardinality(command.type);
        const temporalPlan = await this.#temporal.prepare({
          factKey,
          cardinality,
          scope: command.scope,
          ...(command.scopeContext === undefined ? {} : { scopeContext: command.scopeContext }),
          memoryId: existing.id,
          contentHash: existing.contentHash,
          authority: command.authority,
          observedAt: command.observedAt ?? now,
          ...(command.retractsFact === undefined ? {} : { retractsFact: command.retractsFact }),
          ...(command.branchClaimState === undefined
            ? {}
            : { branchClaimState: command.branchClaimState }),
        });
        const record: MemoryRecord = {
          ...existing,
          embedding: vector instanceof Float32Array ? vector : Float32Array.from(vector),
          confidence: Math.min(1, Math.max(existing.confidence, command.confidence ?? 0.8)),
          importance: Math.min(1, Math.max(existing.importance, command.importance ?? 0.5)),
          updatedAt: now,
          lastAccessedAt: now,
          reinforceCount: existing.reinforceCount + 1,
          revision: existing.revision + 1,
          status: statusForTemporalState(temporalPlan.temporalState),
          factKey,
          cardinality,
          temporalState: temporalPlan.temporalState,
          observedAt: Math.max(existing.observedAt, command.observedAt ?? now),
          authority: Math.max(existing.authority, command.authority) as MemoryRecord["authority"],
          supersedesIds: [...new Set([...existing.supersedesIds, ...temporalPlan.supersedesIds])],
          conflictsWithIds: [
            ...new Set([...existing.conflictsWithIds, ...temporalPlan.conflictsWithIds]),
          ],
          evidenceRefs: [
            ...existing.evidenceRefs,
            ...(command.evidenceRefs ?? []).filter(
              (candidate) =>
                !existing.evidenceRefs.some(
                  (item) => item.kind === candidate.kind && item.id === candidate.id,
                ),
            ),
          ],
          evidenceIntegrity,
        };
        await this.#store.upsertVectors("memory", [this.#record(record)]);
        await this.#temporal.claimWritten(temporalPlan);
        await this.#applyRelatedTemporalStates(temporalPlan, record.id, now);
        await this.#temporal.apply(temporalPlan);
        await this.#views?.enqueueMemory(withoutEmbedding(record));
        return {
          outcome: temporalPlan.decision === "supersede" ? "superseded" : "reinforced",
          record: withoutEmbedding(record),
          relatedIds: [record.id, ...temporalPlan.supersedesIds, ...temporalPlan.conflictsWithIds],
        };
      }
    }
    const semanticConflicts = neighbors
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
    let supersedesIds = [...new Set(command.supersedesIds ?? [])];
    const confidence = Math.max(0, Math.min(1, command.confidence ?? 0.8));
    const importance = Math.max(0, Math.min(1, command.importance ?? 0.5));
    // Only low-confidence or implicit model inferences enter pending.
    // Explicit user writes (authority >= UserCurrentInstruction) are always active.
    const pending =
      command.authority < EvidenceAuthority.UserHistoricalStatement &&
      (confidence < 0.6 || command.authority <= EvidenceAuthority.AssistantInference);
    const id = stableHash("memory:v1", scopeKey, hash);
    let conflicts = semanticConflicts;
    const factKey = command.factKey ?? deriveFactKey(command);
    const cardinality = command.cardinality ?? defaultCardinality(command.type);
    const temporalPlan: TemporalPlan = await this.#temporal.prepare({
      factKey,
      cardinality,
      scope: command.scope,
      ...(command.scopeContext === undefined ? {} : { scopeContext: command.scopeContext }),
      memoryId: id,
      contentHash: hash,
      authority: command.authority,
      observedAt: command.observedAt ?? now,
      ...(command.retractsFact === undefined ? {} : { retractsFact: command.retractsFact }),
      ...(command.branchClaimState === undefined
        ? {}
        : { branchClaimState: command.branchClaimState }),
    });
    supersedesIds = [...new Set([...supersedesIds, ...temporalPlan.supersedesIds])];
    conflicts = [...new Set([...conflicts, ...temporalPlan.conflictsWithIds])];
    const status =
      temporalPlan?.temporalState === "rejected"
        ? "rejected"
        : temporalPlan?.temporalState === "retracted"
          ? "tombstoned"
          : temporalPlan?.temporalState === "historical"
            ? "superseded"
            : temporalPlan?.temporalState === "conflicted" || conflicts.length > 0
              ? "conflicted"
              : temporalPlan?.temporalState === "pending" || pending
                ? "pending"
                : "active";
    const record: MemoryRecord = {
      id,
      content: command.content,
      normalizedContent,
      contentHash: hash,
      type: command.type,
      domain: inferDomain(command),
      scope: command.scope,
      ...(command.scopeContext === undefined ? {} : { scopeContext: command.scopeContext }),
      ownership: {
        tenantId: command.scopeContext?.tenantId,
        userId: command.scopeContext?.userId ?? "local",
        appId: command.scopeContext?.appId,
        agentId: command.scopeContext?.agentId,
      },
      sensitivity: sensitivity.sensitivity,
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
      observedAt: command.observedAt ?? now,
      validFrom: now,
      lastAccessedAt: now,
      reinforceCount: 0,
      revision: 1,
      factKey,
      cardinality,
      temporalState: temporalPlan.temporalState,
      ...(command.branchClaimState === undefined
        ? {}
        : { branchClaimState: command.branchClaimState }),
      ...(command.idempotencyKey === undefined ? {} : { idempotencyKey: command.idempotencyKey }),
      ...(command.applicability === undefined ? {} : { applicability: command.applicability }),
      ...(command.premises === undefined ? {} : { premises: command.premises }),
      ...(command.contentOrigin === undefined ? {} : { contentOrigin: command.contentOrigin }),
      evidenceIntegrity,
    };
    await this.#store.upsertVectors("memory", [this.#record(record)]);
    if (temporalPlan !== undefined) await this.#temporal.claimWritten(temporalPlan);
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
    if (conflicts.length > 0) {
      const previous = await this.#store.fetchVectors("memory", conflicts);
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
            status: "conflicted",
            temporalState: "conflicted",
            conflictsWithIds: [...new Set([...payload.conflictsWithIds, record.id])],
            updatedAt: now,
            revision: payload.revision + 1,
          }),
        );
      }
      await this.#store.upsertVectors("memory", updates);
    }
    if (temporalPlan !== undefined) await this.#temporal.apply(temporalPlan);
    if (this.#views !== undefined) {
      await this.#views.enqueueMemory(withoutEmbedding(record));
    }
    const outcome =
      temporalPlan?.decision === "reject"
        ? "rejected"
        : conflicts.length > 0
          ? "conflict"
          : supersedesIds.length > 0
            ? "superseded"
            : "created";
    return {
      outcome,
      record: withoutEmbedding(record),
      relatedIds: [...supersedesIds, ...conflicts],
    };
  }

  async #applyRelatedTemporalStates(
    plan: TemporalPlan,
    currentMemoryId: string,
    now: number,
  ): Promise<void> {
    const ids = [...new Set([...plan.supersedesIds, ...plan.conflictsWithIds])].filter(
      (id) => id !== currentMemoryId,
    );
    if (ids.length === 0) return;
    const stored = await this.#store.fetchVectors("memory", ids);
    const updates: StoredVectorRecord[] = [];
    for (const [id, item] of stored) {
      const payload = decodeStoredPayload(item) as unknown as Omit<MemoryRecord, "embedding">;
      const vector = item.vectors["embedding"];
      if (!(vector instanceof Float32Array) && !Array.isArray(vector)) continue;
      const conflict = plan.conflictsWithIds.includes(id);
      updates.push(
        this.#record({
          ...payload,
          embedding: vector instanceof Float32Array ? vector : Float32Array.from(vector),
          status: conflict ? "conflicted" : "superseded",
          temporalState: conflict ? "conflicted" : "historical",
          ...(conflict
            ? {
                conflictsWithIds: [...new Set([...payload.conflictsWithIds, currentMemoryId])],
              }
            : { supersededById: currentMemoryId, validUntil: now }),
          updatedAt: now,
          revision: payload.revision + 1,
        }),
      );
    }
    await this.#store.upsertVectors("memory", updates);
  }

  async temporalHead(
    factKey: string,
    scope: MemoryRecord["scope"],
    scopeContext?: MemoryRecord["scopeContext"],
  ) {
    return this.#temporal.head(factKey, scope, scopeContext);
  }

  async repairTemporal(options: OperationOptions = {}) {
    return this.#temporal.repair(async (plan) => {
      const stored = (await this.#store.fetchVectors("memory", [plan.claim.memoryId])).get(
        plan.claim.memoryId,
      );
      if (stored === undefined) {
        return false;
      }
      const payload = decodeStoredPayload(stored) as unknown as Omit<MemoryRecord, "embedding">;
      const vector = stored.vectors["embedding"];
      if (!(vector instanceof Float32Array) && !Array.isArray(vector)) {
        throw new Error(`Temporal claim ${plan.claim.memoryId} has no vector`);
      }
      if (payload.temporalState !== plan.temporalState) {
        await this.#store.upsertVectors("memory", [
          this.#record({
            ...payload,
            embedding: vector instanceof Float32Array ? vector : Float32Array.from(vector),
            temporalState: plan.temporalState,
            updatedAt: this.#clock.now(),
            revision: payload.revision + 1,
          }),
        ]);
      }
      const related = await this.#store.fetchVectors("memory", [
        ...plan.supersedesIds,
        ...plan.conflictsWithIds,
      ]);
      const updates: StoredVectorRecord[] = [];
      for (const [id, relatedStored] of related) {
        const relatedPayload = decodeStoredPayload(relatedStored) as unknown as Omit<
          MemoryRecord,
          "embedding"
        >;
        const relatedVector = relatedStored.vectors["embedding"];
        if (!(relatedVector instanceof Float32Array) && !Array.isArray(relatedVector)) continue;
        const isConflict = plan.conflictsWithIds.includes(id);
        const expectedStatus = isConflict ? "conflicted" : "superseded";
        if (relatedPayload.status === expectedStatus) continue;
        updates.push(
          this.#record({
            ...relatedPayload,
            embedding:
              relatedVector instanceof Float32Array
                ? relatedVector
                : Float32Array.from(relatedVector),
            status: expectedStatus,
            temporalState: isConflict ? "conflicted" : "historical",
            ...(isConflict
              ? {
                  conflictsWithIds: [
                    ...new Set([...relatedPayload.conflictsWithIds, plan.claim.memoryId]),
                  ],
                }
              : { supersededById: plan.claim.memoryId, validUntil: this.#clock.now() }),
            updatedAt: this.#clock.now(),
            revision: relatedPayload.revision + 1,
          }),
        );
      }
      await this.#store.upsertVectors("memory", updates);
      return true;
    }, options);
  }

  async getView(kind: ViewKind, scopeId: string, scopeContext?: MemoryRecord["scopeContext"]) {
    return this.#views?.get(kind, scopeId, scopeContext);
  }

  async repairViews() {
    return this.#views?.repair() ?? { inspected: 0, repaired: 0, failed: 0 };
  }

  async flushBackground(): Promise<void> {
    await this.#views?.flush();
  }

  async abandonBranch(
    branchId: string,
    scopeContext: MemoryRecord["scopeContext"],
  ): Promise<number> {
    const pending = await this.#store.filterVectors("memory", 'status = "pending"', 10_000);
    const updates: StoredVectorRecord[] = [];
    const now = this.#clock.now();
    for (const stored of pending) {
      const payload = decodeStoredPayload(stored) as unknown as Omit<MemoryRecord, "embedding">;
      if (
        payload.branchClaimState !== "hypothesis" ||
        payload.scopeContext?.branchId !== branchId ||
        boundaryKey(payload.scopeContext) !== boundaryKey(scopeContext)
      ) {
        continue;
      }
      const full = (await this.#store.fetchVectors("memory", [stored.id])).get(stored.id);
      const vector = full?.vectors["embedding"];
      if (full === undefined || (!(vector instanceof Float32Array) && !Array.isArray(vector)))
        continue;
      updates.push(
        this.#record({
          ...payload,
          embedding: vector instanceof Float32Array ? vector : Float32Array.from(vector),
          status: "rejected",
          temporalState: "rejected",
          branchClaimState: "abandoned",
          updatedAt: now,
          revision: payload.revision + 1,
        }),
      );
    }
    await this.#store.upsertVectors("memory", updates);
    return updates.length;
  }

  async #evidenceIntegrity(
    refs: readonly import("@pi-mentis/pi-mentis-core").EvidenceRef[],
    scopeContext: CommitMemoryCommand["scopeContext"],
  ): Promise<"valid" | "missing" | "invalid"> {
    if (refs.length === 0) return "missing";
    const expectedBoundary = boundaryKey(scopeContext);
    for (const ref of refs) {
      let exists = false;
      if (ref.kind === "user") {
        const state = await this.#state.get<Readonly<Record<string, unknown>>>(ref.id);
        const identity = state?.value["identity"] as Readonly<Record<string, unknown>> | undefined;
        exists =
          state !== undefined &&
          identity !== undefined &&
          boundaryKey({
            tenantId: String(identity["tenantId"] ?? "local"),
            userId: String(identity["userId"] ?? "local"),
            appId: String(identity["appId"] ?? "pi"),
            agentId: String(identity["agentId"] ?? "pi-mentis"),
          }) === expectedBoundary;
      } else if (ref.kind === "episode") {
        const payload = (await this.#store.fetchScalar("episodes_v1", [ref.id])).get(ref.id);
        exists = payload?.["securityNamespace"] === expectedBoundary;
      } else if (ref.kind === "event" || ref.kind === "tool") {
        const payload = (await this.#store.fetchScalar("events_v1", [ref.id])).get(ref.id);
        exists = payload?.["securityNamespace"] === expectedBoundary;
      } else if (ref.kind === "artifact") {
        const payload = (await this.#store.fetchScalar("artifacts_v1", [ref.id])).get(ref.id);
        exists = payload?.["securityNamespace"] === expectedBoundary;
      } else if (ref.kind === "experience") {
        const payload = (await this.#store.fetchScalar("relationships_v1", [ref.id])).get(ref.id);
        exists =
          boundaryKey(payload?.["scopeContext"] as PiScopeContext | undefined) === expectedBoundary;
      } else if (ref.kind === "memory") {
        const stored = (await this.#store.fetchVectors("memory", [ref.id])).get(ref.id);
        const payload = stored === undefined ? undefined : decodeStoredPayload(stored);
        exists =
          boundaryKey(payload?.["scopeContext"] as PiScopeContext | undefined) === expectedBoundary;
      } else if (ref.kind === "knowledge") {
        const stored = (await this.#store.fetchVectors("knowledge", [ref.id])).get(ref.id);
        exists =
          typeof stored?.fields["namespace"] === "string" &&
          stored.fields["namespace"].startsWith(`${expectedBoundary}::`);
      } else if (ref.kind === "capability") {
        exists = (await this.#store.fetchVectors("capability", [ref.id])).has(ref.id);
      }
      if (!exists) return "invalid";
    }
    return "valid";
  }

  async #assertMemoryIdsInNamespace(ids: readonly string[], namespace: string): Promise<void> {
    if (ids.length === 0) return;
    const stored = await this.#store.fetchVectors("memory", [...new Set(ids)]);
    for (const id of ids) {
      const record = stored.get(id);
      if (record === undefined || record.fields["namespace"] !== namespace) {
        throw new Error(`Related memory ${id} is missing or crosses a security namespace`);
      }
    }
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
        const degraded: string[] = [];
        if (vector === undefined) {
          // Security gate: produce remote-safe content before sending to provider
          const safe = toRemoteSafe(query.text);
          if (safe.policy === "drop" || safe.policy === "local_only") {
            return {
              hits: [],
              diagnostics: {
                durationMs: performance.now() - started,
                timedOut: false,
                degraded: ["query-rejected-sensitive"],
                stages: {},
              },
            };
          }
          const embeddingStarted = performance.now();
          try {
            const response = await measure(this.#telemetry, "embedding_duration_ms", () =>
              this.#embedding.embed(
                {
                  inputs: [safe.text ?? "[REDACTED]"],
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
          } catch (error: unknown) {
            throwIfAborted(signal, "memory-search");
            degraded.push(`embedding:${error instanceof Error ? error.name : "error"}`);
          }
          stages["embedding"] = performance.now() - embeddingStarted;
        } else {
          stages["embedding"] = 0;
        }
        const statusFilter =
          query.temporalMode === "historical"
            ? '(status = "superseded" OR status = "conflicted")'
            : query.temporalMode === "all"
              ? 'status != "tombstoned" AND status != "rejected"'
              : 'status = "active"';
        const scopeFilter =
          query.scopes === undefined || query.scopes.length === 0
            ? statusFilter
            : `${statusFilter} AND (${query.scopes
                .map(
                  (scope) =>
                    `namespace = ${quoteFilter(scopedNamespace(scope, query.scopeContext))}`,
                )
                .join(" OR ")})`;
        const limit = Math.max(1, Math.min(100, query.limit ?? 20));
        const zvecStarted = performance.now();
        const results = await Promise.allSettled([
          vector === undefined
            ? Promise.resolve([])
            : this.#store.vectorSearch({
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
        const fused = new Map<string, SearchHit>();
        for (const [sourceIndex, result] of results.entries()) {
          if (result.status === "rejected") {
            degraded.push(sourceIndex === 0 ? "dense-unavailable" : "fts-unavailable");
            continue;
          }
          for (const [rank, stored] of result.value.entries()) {
            const payload = decodeStoredPayload(stored);
            const payloadContext = payload["scopeContext"] as MemoryRecord["scopeContext"];
            const expectedContext = query.scopeContext ?? {
              tenantId: "local",
              userId: "local",
              appId: "pi",
              agentId: "pi-mentis",
            };
            if (boundaryKey(payloadContext) !== boundaryKey(expectedContext)) continue;
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

    const isExplicitId = options.accessIntent === "explicit_id";
    const currentUser = options.scopeContext?.userId ?? "local";
    const currentTenant = options.scopeContext?.tenantId ?? "local";
    const recordOwner = record.ownership?.userId ?? record.scopeContext?.userId ?? "local";
    const recordTenant = record.ownership?.tenantId ?? record.scopeContext?.tenantId ?? "local";

    // Multi-tenant mode: strict tenant isolation
    if (options.securityMode === "multi_tenant" && recordTenant !== currentTenant) {
      return undefined;
    }

    // Different user (not same user): always deny
    if (recordOwner !== currentUser) {
      return undefined;
    }

    // Same user, explicit ID access in personal/team mode: allow cross-project
    if (isExplicitId && options.securityMode !== "multi_tenant") {
      return record;
    }

    // Backward compat: legacy boundary check
    if (
      options.scopeContext !== undefined &&
      boundaryKey(record.scopeContext) !== boundaryKey(options.scopeContext)
    ) {
      // In personal mode with explicit ID, return anyway
      if (
        isExplicitId &&
        (options.securityMode === "personal" || options.securityMode === undefined)
      ) {
        return record;
      }
      return undefined;
    }
    return record;
  }

  async tombstone(id: string, options: MemoryMutationOptions): Promise<boolean> {
    throwIfAborted(options.signal, "memory-tombstone");
    const stored = (await this.#store.fetchVectors("memory", [id])).get(id);
    if (stored === undefined) return false;
    const payload = decodeStoredPayload(stored) as unknown as Omit<MemoryRecord, "embedding">;
    if (boundaryKey(payload.scopeContext) !== boundaryKey(options.scopeContext)) return false;
    const vector = stored.vectors["embedding"];
    if (!(vector instanceof Float32Array) && !Array.isArray(vector)) return false;
    await this.#store.upsertVectors("memory", [
      this.#record({
        ...payload,
        embedding: vector instanceof Float32Array ? vector : Float32Array.from(vector),
        status: "tombstoned",
        validUntil: this.#clock.now(),
        updatedAt: this.#clock.now(),
        revision: payload.revision + 1,
      }),
    ]);
    return true;
  }

  async markConflicted(
    id: string,
    evidence: EvidenceRef,
    options: MemoryMutationOptions,
  ): Promise<Omit<MemoryRecord, "embedding"> | undefined> {
    throwIfAborted(options.signal, "memory-mark-conflicted");
    if ((await this.#evidenceIntegrity([evidence], options.scopeContext)) !== "valid") {
      return undefined;
    }
    const stored = (await this.#store.fetchVectors("memory", [id])).get(id);
    if (stored === undefined) return undefined;
    const payload = decodeStoredPayload(stored) as unknown as Omit<MemoryRecord, "embedding">;
    if (boundaryKey(payload.scopeContext) !== boundaryKey(options.scopeContext)) return undefined;
    const vector = stored.vectors["embedding"];
    if (!(vector instanceof Float32Array) && !Array.isArray(vector)) return undefined;
    const now = this.#clock.now();
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
