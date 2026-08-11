import {
  EvidenceAuthority,
  ForegroundExecutor,
  contentHash,
  normalizeText,
  stableHash,
  systemClock,
  throwIfAborted,
  type Clock,
  type EvidenceRef,
  type OperationOptions,
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
  decodeStoredPayload,
  type StoredVectorRecord,
  type ZvecStore,
} from "@pi-mentis/pi-mentis-zvec";

import { adaptLegacyMemory, isLegacyMemory, legacyMetadata } from "./legacy-memory-adapter.js";
import {
  DefaultMemoryRelationshipResolver,
  type MemoryRelationshipResolver,
  type RelationshipCandidate,
} from "./relationship-resolver.js";
import { classifySensitivity, toRemoteSafe } from "./secret-detector.js";
import {
  ScopeSemanticPlanner,
  memoryScopeForDecision,
  type ScopeOwnershipDecision,
} from "./scope-semantics.js";
import { TemporalRelationshipEngine, type TemporalRelationshipPlan } from "./temporal.js";
import { HierarchicalViewService, type ViewKind } from "./views.js";
import type {
  CommitMemoryCommand,
  CommitMemoryResult,
  MemoryGetOptions,
  MemoryMutationOptions,
  MemoryQuery,
  MemoryRecord,
  MemoryRelationshipEvidence,
  MemoryRelationship,
  MemorySearchOptions,
  MemoryService,
  PiScopeContext,
  RelationshipLearningCandidate,
  RelationshipLearningWork,
  RelationshipRecoveryReason,
  RelationshipConsolidationResult,
} from "./types.js";

const RELATIONSHIP_LEARNING_KIND = "memory-relationship-learning-v1";
const RELATIONSHIP_LEARNING_MAX_ATTEMPTS = 4;
const RELATIONSHIP_LEARNING_SCAN_LIMIT = 512;

export function relationshipOperationKey(
  incomingId: string,
  targetIds: readonly string[],
  relation: MemoryRelationship,
): string {
  return stableHash(
    "memory-relationship-operation:v1",
    incomingId,
    relation,
    ...[...targetIds].sort(),
  );
}

export interface CreateMemoryServiceOptions {
  readonly store: ZvecStore;
  readonly embedding: EmbeddingProvider;
  readonly embeddingSpace: EmbeddingSpaceIdentity;
  readonly dimensions: number;
  readonly telemetry?: InMemoryTelemetry;
  readonly clock?: Clock;
  readonly viewsEnabled?: boolean;
  readonly viewTtlMs?: number;
  readonly scopePlanner?: ScopeSemanticPlanner;
  readonly relationshipResolver?: MemoryRelationshipResolver;
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

function cosineSimilarity(distance: number): number {
  return 1 - distance;
}

async function embedContent(
  embedding: EmbeddingProvider,
  content: string,
  dimensions: number,
  options: { readonly signal?: AbortSignal } = {},
): Promise<EmbeddingVector> {
  const response = await embedding.embed(
    {
      inputs: [normalizeText(content)],
      inputKind: "memory",
      dimensions,
      truncate: "reject",
    },
    {
      priority: "interactive",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  const vector = response.vectors[0];
  if (vector === undefined) throw new Error("Memory content Embedding response is empty");
  return vector;
}

function orderedItems(content: string): MemoryRecord["orderedItems"] {
  const normalized = content.replaceAll("→", "\n");
  const items = normalized
    .split(/\r?\n/u)
    .map((item) => item.trim().replace(/^[-*]\s*/u, ""))
    .filter((item) => item.length > 0);
  if (
    items.length < 3 ||
    (content.includes("→") === false && /\n\s*[-*]/u.test(content) === false)
  ) {
    return undefined;
  }
  return items.map((value, index) => ({ position: index + 1, value }));
}

function fields(document: { readonly fields: Record<string, unknown> }): Record<string, unknown> {
  return document.fields;
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
  readonly #temporal: TemporalRelationshipEngine;
  readonly #state: ZvecStateStore;
  readonly #relationshipResolver: MemoryRelationshipResolver;
  readonly #idempotent = new Map<string, Promise<CommitMemoryResult>>();
  readonly #namespaceLocks = new Map<string, Promise<void>>();
  readonly #views: HierarchicalViewService | undefined;
  readonly #scopePlanner: ScopeSemanticPlanner;

  constructor(options: CreateMemoryServiceOptions) {
    this.#store = options.store;
    this.#embedding = options.embedding;
    this.#embeddingSpace = options.embeddingSpace;
    this.#embeddingSpaceId = embeddingSpaceId(options.embeddingSpace);
    this.#dimensions = options.dimensions;
    this.#telemetry = options.telemetry ?? new InMemoryTelemetry();
    this.#clock = options.clock ?? systemClock;
    this.#temporal = new TemporalRelationshipEngine(options.store, this.#clock);
    this.#state = new ZvecStateStore(options.store);
    this.#relationshipResolver =
      options.relationshipResolver ?? new DefaultMemoryRelationshipResolver();
    this.#views =
      options.viewsEnabled === false
        ? undefined
        : new HierarchicalViewService(options.store, {
            clock: this.#clock,
            ...(options.viewTtlMs === undefined ? {} : { ttlMs: options.viewTtlMs }),
          });
    this.#scopePlanner =
      options.scopePlanner ??
      new ScopeSemanticPlanner({ embedding: options.embedding, dimensions: options.dimensions });
  }

  async planScopeSemantic(
    command: Pick<CommitMemoryCommand, "content" | "scopeContext"> & {
      readonly embedding?: EmbeddingVector;
    },
    options: OperationOptions = {},
  ): Promise<{ readonly scope: MemoryRecord["scope"]; readonly embedding: EmbeddingVector }> {
    const embedding =
      command.embedding ??
      (await embedContent(this.#embedding, command.content, this.#dimensions, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }));
    const scopeContext = command.scopeContext ?? {
      tenantId: "local",
      userId: "local",
      appId: "pi",
      agentId: "pi-mentis",
    };
    const decision = await this.#scopePlanner.decideOwnership(
      { content: command.content, embedding: embedding.values },
      scopeContext,
      options.signal === undefined ? undefined : { signal: options.signal },
    );
    return { scope: memoryScopeForDecision(decision, scopeContext), embedding };
  }

  async getRelationshipLearning(incomingId: string): Promise<RelationshipLearningWork | undefined> {
    const record = await this.#readRecord(incomingId);
    if (record === undefined) return undefined;
    return (
      await this.#state.get<RelationshipLearningWork>(
        this.#relationshipLearningStateId(
          scopedNamespace(record.scope, record.scopeContext),
          incomingId,
        ),
      )
    )?.value;
  }

  async prepareRelationshipLearning(
    incomingId: string,
    candidates: readonly RelationshipLearningCandidate[],
    options: MemoryMutationOptions,
  ): Promise<RelationshipLearningWork | undefined> {
    const record = await this.#readRecord(incomingId);
    if (record === undefined) return undefined;
    this.#assertBoundary(record, options.scopeContext);
    const namespace = scopedNamespace(record.scope, record.scopeContext);
    const id = this.#relationshipLearningStateId(namespace, incomingId);
    const existing = await this.#state.get<RelationshipLearningWork>(id);
    if (existing?.value.state === "resolved" || existing?.value.state === "failed_terminal") {
      return existing.value;
    }
    const merged = this.#mergeRelationshipCandidates(existing?.value.candidates ?? [], candidates);
    if (merged.length === 0) return existing?.value;
    const now = this.#clock.now();
    const work: RelationshipLearningWork = {
      incomingId,
      namespace,
      state: "pending",
      candidates: merged,
      scopeContext: record.scopeContext ?? options.scopeContext,
      attempts: existing?.value.attempts ?? record.relationshipLearningAttempts ?? 0,
      maxAttempts: existing?.value.maxAttempts ?? RELATIONSHIP_LEARNING_MAX_ATTEMPTS,
      updatedAt: now,
      operationKeys: existing?.value.operationKeys ?? [],
    };
    await this.#state.put(
      { id, kind: RELATIONSHIP_LEARNING_KIND, namespace, value: work },
      {
        status: "pending",
        now,
        ...(existing === undefined ? {} : { expectedRevision: existing.revision }),
      },
    );
    await this.#updateRelationshipLearningRecord(record, work);
    return work;
  }

  async claimRelationshipLearning(
    incomingId: string,
    input: {
      readonly owner: string;
      readonly leaseMs: number;
      readonly recoveryReason: RelationshipRecoveryReason;
    },
    options: MemoryMutationOptions,
  ): Promise<RelationshipLearningWork | undefined> {
    const record = await this.#readRecord(incomingId);
    if (record === undefined) return undefined;
    this.#assertBoundary(record, options.scopeContext);
    const namespace = scopedNamespace(record.scope, record.scopeContext);
    const id = this.#relationshipLearningStateId(namespace, incomingId);
    const existing = await this.#state.get<RelationshipLearningWork>(id);
    if (existing === undefined) return undefined;
    const now = this.#clock.now();
    for (const candidate of existing.value.candidates) {
      const dependency = await this.getRelationshipLearning(candidate.id);
      if (
        dependency !== undefined &&
        (dependency.state === "pending" ||
          dependency.state === "processing" ||
          dependency.state === "failed_retryable")
      ) {
        return undefined;
      }
    }
    const recoverable =
      existing.value.state === "pending" ||
      (existing.value.state === "failed_retryable" && (existing.value.nextRetryAt ?? 0) <= now) ||
      (existing.value.state === "processing" && (existing.value.leaseExpiresAt ?? 0) <= now);
    if (!recoverable || existing.value.attempts >= existing.value.maxAttempts) return undefined;
    const { nextRetryAt: _nextRetryAt, lastError: _lastError, ...claimable } = existing.value;
    void _nextRetryAt;
    void _lastError;
    const work: RelationshipLearningWork = {
      ...claimable,
      state: "processing",
      attempts: existing.value.attempts + 1,
      updatedAt: now,
      processingOwner: input.owner,
      processingStartedAt: now,
      leaseExpiresAt: now + Math.max(1_000, input.leaseMs),
      recoveryReason: input.recoveryReason,
    };
    await this.#state.put(
      { id, kind: RELATIONSHIP_LEARNING_KIND, namespace, value: work },
      { status: "processing", expectedRevision: existing.revision, now },
    );
    await this.#updateRelationshipLearningRecord(record, work);
    return work;
  }

  async resolveRelationshipLearning(
    incomingId: string,
    operationKeys: readonly string[],
    options: MemoryMutationOptions,
  ): Promise<RelationshipLearningWork | undefined> {
    const record = await this.#readRecord(incomingId);
    if (record === undefined) return undefined;
    this.#assertBoundary(record, options.scopeContext);
    const namespace = scopedNamespace(record.scope, record.scopeContext);
    const id = this.#relationshipLearningStateId(namespace, incomingId);
    const existing = await this.#state.get<RelationshipLearningWork>(id);
    if (existing === undefined) return undefined;
    const now = this.#clock.now();
    const {
      processingOwner: _processingOwner,
      processingStartedAt: _processingStartedAt,
      leaseExpiresAt: _leaseExpiresAt,
      nextRetryAt: _nextRetryAt,
      lastError: _lastError,
      ...resolvable
    } = existing.value;
    void _processingOwner;
    void _processingStartedAt;
    void _leaseExpiresAt;
    void _nextRetryAt;
    void _lastError;
    const work: RelationshipLearningWork = {
      ...resolvable,
      state: "resolved",
      updatedAt: now,
      operationKeys: [...new Set([...existing.value.operationKeys, ...operationKeys])],
    };
    await this.#state.put(
      { id, kind: RELATIONSHIP_LEARNING_KIND, namespace, value: work },
      { status: "resolved", expectedRevision: existing.revision, now },
    );
    await this.#updateRelationshipLearningRecord(await this.#readRecord(incomingId), work);
    return work;
  }

  async failRelationshipLearning(
    incomingId: string,
    error: unknown,
    options: MemoryMutationOptions,
  ): Promise<RelationshipLearningWork | undefined> {
    const record = await this.#readRecord(incomingId);
    if (record === undefined) return undefined;
    this.#assertBoundary(record, options.scopeContext);
    const namespace = scopedNamespace(record.scope, record.scopeContext);
    const id = this.#relationshipLearningStateId(namespace, incomingId);
    const existing = await this.#state.get<RelationshipLearningWork>(id);
    if (existing === undefined) return undefined;
    const now = this.#clock.now();
    const terminal = existing.value.attempts >= existing.value.maxAttempts;
    const retryDelayMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, existing.value.attempts - 1));
    const {
      processingOwner: _processingOwner,
      processingStartedAt: _processingStartedAt,
      leaseExpiresAt: _leaseExpiresAt,
      nextRetryAt: _nextRetryAt,
      ...failable
    } = existing.value;
    void _processingOwner;
    void _processingStartedAt;
    void _leaseExpiresAt;
    void _nextRetryAt;
    const work: RelationshipLearningWork = {
      ...failable,
      state: terminal ? "failed_terminal" : "failed_retryable",
      updatedAt: now,
      ...(terminal ? {} : { nextRetryAt: now + retryDelayMs }),
      lastError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    };
    await this.#state.put(
      { id, kind: RELATIONSHIP_LEARNING_KIND, namespace, value: work },
      {
        status: terminal ? "failed_terminal" : "failed_retryable",
        expectedRevision: existing.revision,
        now,
      },
    );
    await this.#updateRelationshipLearningRecord(record, work);
    return work;
  }

  async listRecoverableRelationshipLearning(
    input: { readonly limit?: number; readonly now?: number } = {},
  ): Promise<readonly RelationshipLearningWork[]> {
    const now = input.now ?? this.#clock.now();
    const limit = Math.max(1, Math.min(input.limit ?? 128, RELATIONSHIP_LEARNING_SCAN_LIMIT));
    await this.#repairMissingRelationshipLearningMarkers(limit);
    const states = await Promise.all(
      (["pending", "processing", "failed_retryable"] as const).map((status) =>
        this.#state.list<RelationshipLearningWork>({
          kind: RELATIONSHIP_LEARNING_KIND,
          status,
          limit,
        }),
      ),
    );
    return states
      .flat()
      .map((state) => state.value)
      .filter(
        (work) =>
          work.state === "pending" ||
          (work.state === "failed_retryable" && (work.nextRetryAt ?? 0) <= now) ||
          (work.state === "processing" && (work.leaseExpiresAt ?? 0) <= now),
      )
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .slice(0, limit);
  }

  async listPendingRelationshipLearning(
    input: { readonly limit?: number } = {},
  ): Promise<readonly RelationshipLearningWork[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 64, RELATIONSHIP_LEARNING_SCAN_LIMIT));
    await this.#repairMissingRelationshipLearningMarkers(limit);
    const states = await Promise.all(
      (["pending", "processing", "failed_retryable"] as const).map((status) =>
        this.#state.list<RelationshipLearningWork>({
          kind: RELATIONSHIP_LEARNING_KIND,
          status,
          limit,
        }),
      ),
    );
    return states
      .flat()
      .map((state) => state.value)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit);
  }

  async commit(
    command: CommitMemoryCommand,
    options: OperationOptions = {},
  ): Promise<CommitMemoryResult> {
    const idempotencyKey = command.idempotencyKey;
    if (idempotencyKey === undefined) return this.#commitLocked(command, options);
    const namespace = scopedNamespace(command.scope, command.scopeContext);
    const stateId = this.#state.id("memory-idempotency-v2", namespace, idempotencyKey);
    const commandHash = stableHash(
      "memory-idempotency-command:v2",
      normalizeText(command.content),
      JSON.stringify(command.scope),
      JSON.stringify(command.provenance),
    );
    const persisted = await this.#state.get<{
      readonly commandHash: string;
      readonly result?: CommitMemoryResult;
    }>(stateId);
    if (persisted?.value.commandHash !== undefined && persisted.value.commandHash !== commandHash) {
      throw new Error(
        `Idempotency key ${idempotencyKey} was already used for a different memory command`,
      );
    }
    if (persisted?.value.result !== undefined) return persisted.value.result;
    const running = this.#idempotent.get(stateId);
    if (running !== undefined) return running;
    const promise = (async () => {
      const result = await this.#commitLocked(command, options);
      await this.#state.put(
        { id: stateId, kind: "memory-idempotency-v2", namespace, value: { commandHash, result } },
        { status: "completed", now: this.#clock.now() },
      );
      return result;
    })().finally(() => this.#idempotent.delete(stateId));
    this.#idempotent.set(stateId, promise);
    return promise;
  }

  async #commitLocked(
    command: CommitMemoryCommand,
    options: OperationOptions,
  ): Promise<CommitMemoryResult> {
    const namespace = scopedNamespace(command.scope, command.scopeContext);
    const previous = this.#namespaceLocks.get(namespace) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#namespaceLocks.set(namespace, queued);
    await previous;
    try {
      return await this.#commitUnlocked(command, options);
    } finally {
      release();
      if (this.#namespaceLocks.get(namespace) === queued) this.#namespaceLocks.delete(namespace);
    }
  }

  async #commitUnlocked(
    command: CommitMemoryCommand,
    options: OperationOptions,
  ): Promise<CommitMemoryResult> {
    throwIfAborted(options.signal, "memory-commit");
    const normalizedContent = normalizeText(command.content);
    if (normalizedContent.length < 3 || normalizedContent.length > 100_000) {
      throw new Error("Memory content must contain 3 through 100000 normalized characters");
    }
    const sensitivity = classifySensitivity(command.content);
    if (
      sensitivity.sensitivity === "secret" &&
      sensitivity.categories.some((item) => item === "private_key" || item === "certificate")
    ) {
      return { outcome: "rejected_sensitive", relatedIds: [], relationDecision: "unrelated" };
    }

    const scopeKey = scopedNamespace(command.scope, command.scopeContext);
    const hash = contentHash(normalizedContent);
    const now = this.#clock.now();
    const exact = await this.#store.filterVectors(
      "memory",
      `content_hash = ${quoteFilter(hash)} AND namespace = ${quoteFilter(scopeKey)} AND status = "active"`,
      2,
    );
    const exactStored = exact[0];
    if (exactStored !== undefined) {
      const full = (await this.#store.fetchVectors("memory", [exactStored.id])).get(exactStored.id);
      const vector = full?.vectors["embedding"];
      if (full !== undefined && (vector instanceof Float32Array || Array.isArray(vector))) {
        const existing = adaptLegacyMemory(decodeStoredPayload(full));
        const record: MemoryRecord = {
          ...existing,
          schemaVersion: 2,
          embedding: vector instanceof Float32Array ? vector : Float32Array.from(vector),
          confidence: Math.max(existing.confidence, command.confidence ?? 0.8),
          importance: Math.max(existing.importance, command.importance ?? 0.5),
          evidenceRefs: this.#mergeEvidence(existing.evidenceRefs, command.evidenceRefs ?? []),
          relationships: {
            ...existing.relationships,
            reinforcesIds: [...new Set([...existing.relationships.reinforcesIds, existing.id])],
          },
          reinforceCount: existing.reinforceCount + 1,
          lastReinforcedAt: now,
          lastAccessedAt: now,
          updatedAt: now,
          revision: existing.revision + 1,
        };
        const plan = this.#temporal.plan("reinforce", [existing.id]);
        const trace = await this.#temporal.persistTrace({
          incomingId: existing.id,
          candidateIds: [existing.id],
          relationDecision: "reinforce",
          confidence: 1,
          reasonCodes: ["exact_duplicate"],
          temporalAction: plan.temporalAction,
        });
        const traced = { ...record, decisionTraceId: trace.id };
        await this.#store.upsertVectors("memory", [this.#record(traced)]);
        return {
          outcome: "reinforced",
          record: withoutEmbedding(traced),
          relatedIds: [existing.id],
          relationDecision: "reinforce",
          traceId: trace.id,
        };
      }
    }

    const remoteSafe = toRemoteSafe(normalizedContent);
    const skipEmbedding = remoteSafe.policy === "local_only" || remoteSafe.policy === "drop";
    const embedding =
      command.embedding ??
      (skipEmbedding
        ? { values: new Float32Array(this.#dimensions) }
        : await measure(this.#telemetry, "embedding_duration_ms", () =>
            embedContent(this.#embedding, remoteSafe.text ?? normalizedContent, this.#dimensions, {
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            }),
          ));
    const discovered = skipEmbedding
      ? []
      : await this.#store.vectorSearch({
          kind: "memory",
          vector: embedding.values,
          topK: 8,
          filter: `namespace = ${quoteFilter(scopeKey)} AND status = "active"`,
        });
    const candidateIds = [
      ...new Set([
        ...discovered.map((item) => item.id),
        ...(command.relationshipCandidates ?? []).map((candidate) => candidate.id),
      ]),
    ];
    const candidateRecords = await this.#store.fetchVectors("memory", candidateIds);
    const discoveredSimilarity = new Map(discovered.map((item) => [item.id, item.score]));
    const candidates: RelationshipCandidate[] = candidateIds.flatMap((id) => {
      const itemScore = discoveredSimilarity.get(id);
      const stored = candidateRecords.get(id);
      if (stored === undefined) return [];
      return [
        {
          record: adaptLegacyMemory(decodeStoredPayload(stored)),
          similarity: itemScore === undefined ? 0 : cosineSimilarity(itemScore),
        },
      ];
    });
    const observedAt = command.observedAt ?? now;
    const id = stableHash(
      "memory:v2",
      scopeKey,
      hash,
      String(observedAt),
      command.idempotencyKey ?? String(now),
    );
    const resolution = this.#relationshipResolver.resolve(command, candidates);
    await this.#assertMemoryIdsInNamespace(resolution.targetIds, scopeKey);
    const temporalPlan = this.#temporal.plan(resolution.relation, resolution.targetIds);
    const evidenceIntegrity = await this.#evidenceIntegrity(
      command.evidenceRefs ?? [],
      command.scopeContext,
    );
    const provenance = command.provenance ?? {
      origin: "user" as const,
      epistemicState: "asserted" as const,
      ...(command.scopeContext?.branchId === undefined
        ? {}
        : { branchId: command.scopeContext.branchId }),
    };
    const inferredOrderedItems = command.orderedItems ?? orderedItems(command.content);
    const relationshipCandidates = this.#mergeRelationshipCandidates(
      command.relationshipCandidates ?? [],
      candidates.map((candidate) => ({
        id: candidate.record.id,
        source: "semantic_candidate" as const,
      })),
    ).slice(0, 6);
    const relationshipLearningPending =
      command.relationshipEvidence === undefined && relationshipCandidates.length > 0;
    const record: MemoryRecord = {
      schemaVersion: 2,
      id,
      content: command.content,
      normalizedContent,
      contentHash: hash,
      scope: command.scope,
      ...(command.scopeContext === undefined ? {} : { scopeContext: command.scopeContext }),
      ownership: {
        tenantId: command.scopeContext?.tenantId,
        userId: command.scopeContext?.userId ?? "local",
        appId: command.scopeContext?.appId,
        agentId: command.scopeContext?.agentId,
      },
      sensitivity: sensitivity.sensitivity,
      confidence: Math.max(0, Math.min(1, command.confidence ?? 0.8)),
      importance: Math.max(0, Math.min(1, command.importance ?? 0.5)),
      authority: command.authority,
      evidenceRefs: command.evidenceRefs ?? [],
      relationships: temporalPlan.relationships,
      status: temporalPlan.incomingStatus,
      embeddingSpaceId: this.#embeddingSpaceId,
      embedding: embedding.values,
      createdAt: now,
      updatedAt: now,
      observedAt,
      validFrom: now,
      lastAccessedAt: now,
      reinforceCount: 0,
      revision: 1,
      ...(command.idempotencyKey === undefined ? {} : { idempotencyKey: command.idempotencyKey }),
      ...(command.runtimeConstraints === undefined
        ? {}
        : { runtimeConstraints: command.runtimeConstraints }),
      ...(command.recallPrerequisites === undefined
        ? {}
        : { recallPrerequisites: command.recallPrerequisites }),
      provenance,
      evidenceIntegrity,
      ...(inferredOrderedItems === undefined ? {} : { orderedItems: inferredOrderedItems }),
      ...(command.semanticHints === undefined &&
      command.relationshipEvidence?.incomingHints === undefined
        ? {}
        : {
            semanticHints:
              command.semanticHints ?? command.relationshipEvidence?.incomingHints ?? {},
          }),
      ...(command.temporalKind === undefined ? {} : { temporalKind: command.temporalKind }),
      ...(command.occurredAt === undefined ? {} : { occurredAt: command.occurredAt }),
      relationshipLearningState: relationshipLearningPending ? "pending" : "resolved",
      relationshipLearningUpdatedAt: now,
      relationshipLearningAttempts: 0,
      relationshipCandidateIds: relationshipCandidates.map((candidate) => candidate.id),
    };
    const trace = await this.#temporal.persistTrace({
      incomingId: id,
      candidateIds: candidates.map((item) => item.record.id),
      relationDecision: resolution.relation,
      confidence: resolution.confidence,
      reasonCodes: resolution.reasonCodes,
      temporalAction: temporalPlan.temporalAction,
    });
    const traced = { ...record, decisionTraceId: trace.id };
    await this.#store.upsertVectors("memory", [this.#record(traced)]);
    if (relationshipLearningPending) {
      await this.#persistInitialRelationshipLearningWork(traced, relationshipCandidates);
    }
    await this.#applyTargetTransitions(temporalPlan, id, now);
    await this.#temporal.persistRelationships(scopeKey, id, temporalPlan);
    await this.#views?.enqueueMemory(withoutEmbedding(traced));
    const outcome = this.#outcome(resolution.relation);
    return {
      outcome,
      record: withoutEmbedding(traced),
      relatedIds: resolution.targetIds,
      relationDecision: resolution.relation,
      traceId: trace.id,
      relationshipCandidateIds: relationshipCandidates.map((candidate) => candidate.id),
    };
  }

  #relationshipLearningStateId(namespace: string, incomingId: string): string {
    return this.#state.id(RELATIONSHIP_LEARNING_KIND, namespace, incomingId);
  }

  #mergeRelationshipCandidates(
    left: readonly RelationshipLearningCandidate[],
    right: readonly RelationshipLearningCandidate[],
  ): readonly RelationshipLearningCandidate[] {
    const merged = new Map<string, RelationshipLearningCandidate>();
    for (const candidate of [...left, ...right]) {
      if (candidate.id.length === 0) continue;
      const previous = merged.get(candidate.id);
      merged.set(candidate.id, {
        id: candidate.id,
        source:
          previous?.source === "same_turn_recall" || candidate.source === "same_turn_recall"
            ? "same_turn_recall"
            : "semantic_candidate",
      });
    }
    return [...merged.values()].slice(0, 6);
  }

  async #readRecord(id: string): Promise<MemoryRecord | undefined> {
    const stored = (await this.#store.fetchVectors("memory", [id])).get(id);
    if (stored === undefined) return undefined;
    const vector = stored.vectors["embedding"];
    if (!(vector instanceof Float32Array) && !Array.isArray(vector)) return undefined;
    return {
      ...adaptLegacyMemory(decodeStoredPayload(stored)),
      embedding: vector instanceof Float32Array ? vector : Float32Array.from(vector),
    };
  }

  #assertBoundary(record: MemoryRecord, scopeContext: MemoryMutationOptions["scopeContext"]): void {
    if (boundaryKey(record.scopeContext) !== boundaryKey(scopeContext)) {
      throw new Error(`Memory ${record.id} crosses a security boundary`);
    }
  }

  async #persistInitialRelationshipLearningWork(
    record: MemoryRecord,
    candidates: readonly RelationshipLearningCandidate[],
  ): Promise<RelationshipLearningWork> {
    const namespace = scopedNamespace(record.scope, record.scopeContext);
    const now = this.#clock.now();
    const work: RelationshipLearningWork = {
      incomingId: record.id,
      namespace,
      state: "pending",
      candidates,
      scopeContext: record.scopeContext ?? {
        tenantId: "local",
        userId: "local",
        appId: "pi",
        agentId: "pi-mentis",
      },
      attempts: 0,
      maxAttempts: RELATIONSHIP_LEARNING_MAX_ATTEMPTS,
      updatedAt: now,
      operationKeys: [],
    };
    await this.#state.put(
      {
        id: this.#relationshipLearningStateId(namespace, record.id),
        kind: RELATIONSHIP_LEARNING_KIND,
        namespace,
        value: work,
      },
      { status: "pending", now },
    );
    return work;
  }

  async #updateRelationshipLearningRecord(
    record: MemoryRecord | undefined,
    work: RelationshipLearningWork,
  ): Promise<void> {
    if (record === undefined) return;
    const updated: MemoryRecord = {
      ...record,
      relationshipLearningState: work.state,
      relationshipLearningUpdatedAt: work.updatedAt,
      relationshipLearningAttempts: work.attempts,
      relationshipCandidateIds: work.candidates.map((candidate) => candidate.id),
      updatedAt: Math.max(record.updatedAt, work.updatedAt),
      revision: record.revision + 1,
    };
    await this.#store.upsertVectors("memory", [this.#record(updated)]);
  }

  async #repairMissingRelationshipLearningMarkers(limit: number): Promise<void> {
    const documents = await this.#store.filterVectors("memory", 'status = "active"', limit);
    for (const document of documents) {
      const record = adaptLegacyMemory(decodeStoredPayload(document));
      if (
        record.relationshipLearningState !== "pending" &&
        record.relationshipLearningState !== "processing" &&
        record.relationshipLearningState !== "failed_retryable"
      ) {
        continue;
      }
      const namespace = scopedNamespace(record.scope, record.scopeContext);
      const id = this.#relationshipLearningStateId(namespace, record.id);
      if ((await this.#state.get(id)) !== undefined) continue;
      await this.#persistInitialRelationshipLearningWork(
        {
          ...record,
          embedding: new Float32Array(this.#dimensions),
        },
        (record.relationshipCandidateIds ?? []).map((candidateId) => ({
          id: candidateId,
          source: "semantic_candidate",
        })),
      );
    }
  }

  #outcome(relation: MemoryRelationship): CommitMemoryResult["outcome"] {
    if (relation === "supersede") return "superseded";
    if (relation === "retract") return "retracted";
    if (relation === "conflict") return "conflict";
    if (relation === "reinforce") return "reinforced";
    return "created";
  }

  async consolidateRelationship(
    incomingId: string,
    evidence: MemoryRelationshipEvidence,
    options: MemoryMutationOptions,
  ): Promise<RelationshipConsolidationResult> {
    const incomingStored = (await this.#store.fetchVectors("memory", [incomingId])).get(incomingId);
    if (incomingStored === undefined) {
      return {
        action: "skipped",
        incomingId,
        targetIds: [],
        relationDecision: "uncertain",
        reason: "incoming_not_found",
      };
    }
    const unlockedIncoming = adaptLegacyMemory(decodeStoredPayload(incomingStored));
    const namespace = scopedNamespace(unlockedIncoming.scope, unlockedIncoming.scopeContext);
    const previous = this.#namespaceLocks.get(namespace) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#namespaceLocks.set(namespace, queued);
    await previous;
    try {
      const lockedIncomingStored = (await this.#store.fetchVectors("memory", [incomingId])).get(
        incomingId,
      );
      const incomingVector = lockedIncomingStored?.vectors["embedding"];
      if (
        lockedIncomingStored === undefined ||
        (!(incomingVector instanceof Float32Array) && !Array.isArray(incomingVector))
      ) {
        return {
          action: "skipped",
          incomingId,
          targetIds: [],
          relationDecision: "uncertain",
          reason:
            lockedIncomingStored === undefined
              ? "incoming_not_found"
              : "incoming_embedding_missing",
        };
      }
      const incoming = adaptLegacyMemory(decodeStoredPayload(lockedIncomingStored));
      if (boundaryKey(incoming.scopeContext) !== boundaryKey(options.scopeContext)) {
        throw new Error(`Incoming memory ${incomingId} crosses a security boundary`);
      }
      if (incoming.status !== "active") {
        return {
          action: "skipped",
          incomingId,
          targetIds: [],
          relationDecision: "uncertain",
          reason: "incoming_not_active",
        };
      }
      const targetIds = [...new Set(evidence.targetIds)].filter((id) => id !== incomingId);
      await this.#assertMemoryIdsInNamespace(targetIds, namespace);
      const targets = await this.#store.fetchVectors("memory", targetIds);
      const activeTargets = targetIds.flatMap((id) => {
        const stored = targets.get(id);
        if (stored === undefined) return [];
        const vector = stored.vectors["embedding"];
        if (!(vector instanceof Float32Array) && !Array.isArray(vector)) return [];
        const record = adaptLegacyMemory(decodeStoredPayload(stored));
        return record.status === "active" ? [record] : [];
      });
      if (activeTargets.length !== targetIds.length || targetIds.length === 0) {
        return {
          action: "skipped",
          incomingId,
          targetIds: activeTargets.map((record) => record.id),
          relationDecision: "uncertain",
          reason: "target_not_active",
        };
      }
      const resolution = this.#relationshipResolver.resolve(
        { content: incoming.content, relationshipEvidence: { ...evidence, targetIds } },
        activeTargets.map((record) => ({ record, similarity: 0 })),
      );
      if (
        resolution.relation === "coexist" ||
        resolution.relation === "unrelated" ||
        resolution.relation === "uncertain"
      ) {
        const operationKey = relationshipOperationKey(
          incomingId,
          resolution.targetIds,
          resolution.relation,
        );
        const learning = await this.getRelationshipLearning(incomingId);
        if (learning?.operationKeys.includes(operationKey) === true) {
          return {
            action: "skipped",
            incomingId,
            targetIds: resolution.targetIds,
            relationDecision: resolution.relation,
            reason: "duplicate_relationship_operation",
            operationKey,
          };
        }
        const temporalState = Object.fromEntries([
          [incoming.id, incoming.status],
          ...activeTargets.map((target) => [target.id, target.status] as const),
        ]);
        const trace = await this.#temporal.persistTrace({
          incomingId,
          candidateIds: resolution.targetIds,
          relationDecision: resolution.relation,
          confidence: resolution.confidence,
          reasonCodes: [...resolution.reasonCodes, "slow_consolidation"],
          ...(evidence.signals === undefined ? {} : { signals: evidence.signals }),
          ...(evidence.proposalRelationship === undefined
            ? {}
            : { proposalRelationship: evidence.proposalRelationship }),
          ...(evidence.proposalConfidence === undefined
            ? {}
            : { proposalConfidence: evidence.proposalConfidence }),
          ...(evidence.gateName === undefined ? {} : { gateName: evidence.gateName }),
          ...(evidence.gateAccepted === undefined ? {} : { gateAccepted: evidence.gateAccepted }),
          ...(evidence.gateRejectReasons === undefined
            ? {}
            : { gateRejectReasons: evidence.gateRejectReasons }),
          ...(evidence.incomingHints === undefined
            ? {}
            : { incomingHints: evidence.incomingHints }),
          ...(evidence.targetHints === undefined ? {} : { targetHints: evidence.targetHints }),
          temporalPreState: temporalState,
          temporalPostState: temporalState,
          operationKey,
          recoveryReason: learning?.recoveryReason ?? "normal",
          temporalAction: "no_persistent_mutation",
        });
        await this.#store.upsertVectors("memory", [
          this.#record({
            ...incoming,
            embedding:
              incomingVector instanceof Float32Array
                ? incomingVector
                : Float32Array.from(incomingVector),
            decisionTraceId: trace.id,
          }),
        ]);
        return {
          action: "skipped",
          incomingId,
          targetIds: resolution.targetIds,
          relationDecision: resolution.relation,
          reason: resolution.reasonCodes.join(","),
          operationKey,
        };
      }
      if (
        (resolution.relation === "supersede" || resolution.relation === "retract") &&
        activeTargets.some(
          (target) =>
            target.observedAt > incoming.observedAt ||
            (target.observedAt === incoming.observedAt && target.authority > incoming.authority),
        )
      ) {
        return {
          action: "skipped",
          incomingId,
          targetIds: resolution.targetIds,
          relationDecision: "uncertain",
          reason: "incoming_is_older_or_lower_authority_than_target",
        };
      }
      const operationKey = relationshipOperationKey(
        incomingId,
        resolution.targetIds,
        resolution.relation,
      );
      const learning = await this.getRelationshipLearning(incomingId);
      if (learning?.operationKeys.includes(operationKey) === true) {
        return {
          action: "skipped",
          incomingId,
          targetIds: resolution.targetIds,
          relationDecision: resolution.relation,
          reason: "duplicate_relationship_operation",
          operationKey,
        };
      }
      const now = this.#clock.now();
      const plan = this.#temporal.plan(resolution.relation, resolution.targetIds);
      const temporalPreState = Object.fromEntries([
        [incoming.id, incoming.status],
        ...activeTargets.map((target) => [target.id, target.status] as const),
      ]);
      const temporalPostState = Object.fromEntries([
        [incoming.id, resolution.relation === "reinforce" ? "superseded" : plan.incomingStatus],
        ...activeTargets.map((target) => [target.id, plan.targetStatus ?? target.status] as const),
      ]);
      const trace = await this.#temporal.persistTrace({
        incomingId,
        candidateIds: resolution.targetIds,
        relationDecision: resolution.relation,
        confidence: resolution.confidence,
        reasonCodes: [...resolution.reasonCodes, "slow_consolidation"],
        ...(evidence.signals === undefined ? {} : { signals: evidence.signals }),
        ...(evidence.proposalRelationship === undefined
          ? {}
          : { proposalRelationship: evidence.proposalRelationship }),
        ...(evidence.proposalConfidence === undefined
          ? {}
          : { proposalConfidence: evidence.proposalConfidence }),
        ...(evidence.gateName === undefined ? {} : { gateName: evidence.gateName }),
        ...(evidence.gateAccepted === undefined ? {} : { gateAccepted: evidence.gateAccepted }),
        ...(evidence.gateRejectReasons === undefined
          ? {}
          : { gateRejectReasons: evidence.gateRejectReasons }),
        ...(evidence.incomingHints === undefined ? {} : { incomingHints: evidence.incomingHints }),
        ...(evidence.targetHints === undefined ? {} : { targetHints: evidence.targetHints }),
        temporalPreState,
        temporalPostState,
        operationKey,
        recoveryReason: learning?.recoveryReason ?? "normal",
        temporalAction:
          resolution.relation === "reinforce"
            ? "merge_reinforcement_preserve_source"
            : plan.temporalAction,
      });

      if (resolution.relation === "reinforce") {
        const targetId = resolution.targetIds[0];
        const targetStored = targetId === undefined ? undefined : targets.get(targetId);
        const targetVector = targetStored?.vectors["embedding"];
        if (
          targetId === undefined ||
          targetStored === undefined ||
          (!(targetVector instanceof Float32Array) && !Array.isArray(targetVector))
        ) {
          return {
            action: "skipped",
            incomingId,
            targetIds: resolution.targetIds,
            relationDecision: "uncertain",
            reason: "reinforcement_target_unreadable",
          };
        }
        const target = adaptLegacyMemory(decodeStoredPayload(targetStored));
        const strengthened: MemoryRecord = {
          ...target,
          schemaVersion: 2,
          embedding:
            targetVector instanceof Float32Array ? targetVector : Float32Array.from(targetVector),
          confidence: Math.max(target.confidence, incoming.confidence),
          importance: Math.max(target.importance, incoming.importance),
          evidenceRefs: this.#mergeEvidence(target.evidenceRefs, incoming.evidenceRefs),
          reinforceCount: target.reinforceCount + 1,
          lastReinforcedAt: now,
          updatedAt: now,
          revision: target.revision + 1,
        };
        const source: MemoryRecord = {
          ...incoming,
          schemaVersion: 2,
          embedding:
            incomingVector instanceof Float32Array
              ? incomingVector
              : Float32Array.from(incomingVector),
          relationships: plan.relationships,
          status: "superseded",
          supersededById: targetId,
          validUntil: now,
          updatedAt: now,
          revision: incoming.revision + 1,
          decisionTraceId: trace.id,
          ...(evidence.incomingHints === undefined
            ? {}
            : { semanticHints: evidence.incomingHints }),
        };
        await this.#store.upsertVectors("memory", [
          this.#record(strengthened),
          this.#record(source),
        ]);
        await this.#temporal.persistRelationships(namespace, incomingId, plan);
        await this.#views?.enqueueMemory(withoutEmbedding(source));
      } else {
        const updated: MemoryRecord = {
          ...incoming,
          schemaVersion: 2,
          embedding:
            incomingVector instanceof Float32Array
              ? incomingVector
              : Float32Array.from(incomingVector),
          relationships: plan.relationships,
          status: plan.incomingStatus,
          updatedAt: now,
          revision: incoming.revision + 1,
          decisionTraceId: trace.id,
          ...(evidence.incomingHints === undefined
            ? {}
            : { semanticHints: evidence.incomingHints }),
        };
        await this.#store.upsertVectors("memory", [this.#record(updated)]);
        await this.#applyTargetTransitions(plan, incomingId, now);
        await this.#temporal.persistRelationships(namespace, incomingId, plan);
        await this.#views?.enqueueMemory(withoutEmbedding(updated));
      }
      return {
        action: "applied",
        incomingId,
        targetIds: resolution.targetIds,
        relationDecision: resolution.relation,
        reason: "high_confidence_pairwise_evidence",
        traceId: trace.id,
        operationKey,
      };
    } finally {
      release();
      if (this.#namespaceLocks.get(namespace) === queued) this.#namespaceLocks.delete(namespace);
    }
  }

  async #applyTargetTransitions(
    plan: TemporalRelationshipPlan,
    incomingId: string,
    now: number,
  ): Promise<void> {
    if (plan.targetStatus === undefined) return;
    const ids = [...plan.relationships.supersedesIds, ...plan.relationships.retractsIds].filter(
      (id) => id !== incomingId,
    );
    const stored = await this.#store.fetchVectors("memory", ids);
    const updates: StoredVectorRecord[] = [];
    for (const item of stored.values()) {
      const vector = item.vectors["embedding"];
      if (!(vector instanceof Float32Array) && !Array.isArray(vector)) continue;
      const payload = adaptLegacyMemory(decodeStoredPayload(item));
      updates.push(
        this.#record({
          ...payload,
          schemaVersion: 2,
          embedding: vector instanceof Float32Array ? vector : Float32Array.from(vector),
          status: plan.targetStatus,
          ...(plan.relation === "supersede" ? { supersededById: incomingId } : {}),
          validUntil: now,
          updatedAt: now,
          revision: payload.revision + 1,
        }),
      );
    }
    if (updates.length > 0) await this.#store.upsertVectors("memory", updates);
  }

  #mergeEvidence(
    left: readonly EvidenceRef[],
    right: readonly EvidenceRef[],
  ): readonly EvidenceRef[] {
    return [
      ...left,
      ...right.filter((candidate) =>
        left.every((existing) => existing.kind !== candidate.kind || existing.id !== candidate.id),
      ),
    ];
  }

  async #evidenceIntegrity(
    refs: readonly EvidenceRef[],
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
        exists =
          (await this.#store.fetchScalar("episodes_v1", [ref.id])).get(ref.id)?.[
            "securityNamespace"
          ] === expectedBoundary;
      } else if (ref.kind === "event" || ref.kind === "tool") {
        exists =
          (await this.#store.fetchScalar("events_v1", [ref.id])).get(ref.id)?.[
            "securityNamespace"
          ] === expectedBoundary;
      } else if (ref.kind === "artifact") {
        exists =
          (await this.#store.fetchScalar("artifacts_v1", [ref.id])).get(ref.id)?.[
            "securityNamespace"
          ] === expectedBoundary;
      } else if (ref.kind === "memory") {
        const stored = (await this.#store.fetchVectors("memory", [ref.id])).get(ref.id);
        exists =
          stored !== undefined &&
          boundaryKey(decodeStoredPayload(stored)["scopeContext"] as PiScopeContext | undefined) ===
            expectedBoundary;
      } else if (ref.kind === "experience") {
        const payload = (await this.#store.fetchScalar("relationships_v1", [ref.id])).get(ref.id);
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
          "memory-query:v2",
          this.#embedding.id,
          this.#embeddingSpace.modelId,
          String(this.#dimensions),
          contentHash(query.text),
        );
        let vector = query.queryEmbedding ?? this.#queryCache.get(key);
        const stages: Record<string, number> = {};
        const degraded: string[] = [];
        if (vector !== undefined && vector.values.length !== this.#dimensions) vector = undefined;
        if (vector === undefined) {
          const safe = toRemoteSafe(query.text);
          if (safe.policy === "drop" || safe.policy === "local_only") {
            return {
              hits: [],
              diagnostics: {
                durationMs: performance.now() - started,
                timedOut: false,
                degraded: ["query-rejected-sensitive"],
                stages,
              },
            };
          }
          const embeddingStarted = performance.now();
          vector = await embedContent(
            this.#embedding,
            safe.text ?? "[REDACTED]",
            this.#dimensions,
            { signal },
          );
          this.#queryCache.set(key, vector);
          stages["embedding"] = performance.now() - embeddingStarted;
        } else stages["embedding"] = 0;
        const statusFilter =
          query.temporalMode === "historical"
            ? '(status = "superseded" OR status = "conflicted" OR status = "tombstoned")'
            : query.temporalMode === "all"
              ? 'status != "rejected"'
              : 'status = "active"';
        const scopeFilter =
          query.scopes === undefined || query.scopes.length === 0
            ? statusFilter
            : `${statusFilter} AND (${query.scopes.map((scope) => `namespace = ${quoteFilter(scopedNamespace(scope, query.scopeContext))}`).join(" OR ")})`;
        const limit = Math.max(1, Math.min(100, query.limit ?? 20));
        const zvecStarted = performance.now();
        const timedSearch = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
          const stageStarted = performance.now();
          try {
            return await operation();
          } finally {
            stages[name] = performance.now() - stageStarted;
          }
        };
        const results = await Promise.allSettled([
          timedSearch("dense", () =>
            this.#store.vectorSearch({
              kind: "memory",
              vector: vector.values,
              topK: limit * 2,
              filter: scopeFilter,
            }),
          ),
          timedSearch("fts", () =>
            this.#store.ftsSearch({
              kind: "memory",
              query: query.text,
              topK: limit * 2,
              filter: scopeFilter,
            }),
          ),
        ]);
        stages["zvec"] = performance.now() - zvecStarted;
        const fused = new Map<string, SearchHit>();
        for (const [sourceIndex, result] of results.entries()) {
          if (result.status === "rejected") {
            degraded.push(sourceIndex === 0 ? "dense-unavailable" : "fts-unavailable");
            continue;
          }
          for (const [rank, stored] of result.value.entries()) {
            const raw = decodeStoredPayload(stored);
            const record = adaptLegacyMemory(raw);
            const expected = query.scopeContext ?? {
              tenantId: "local",
              userId: "local",
              appId: "pi",
              agentId: "pi-mentis",
            };
            if (boundaryKey(record.scopeContext) !== boundaryKey(expected)) continue;
            const rawFields = fields(stored);
            const previous = fused.get(stored.id);
            fused.set(stored.id, {
              id: stored.id,
              kind: "memory",
              text: record.content,
              score: (previous?.score ?? 0) + 1 / (60 + rank + 1),
              tokenCount:
                typeof rawFields["token_count"] === "number" ? rawFields["token_count"] : 1,
              authority: (typeof rawFields["authority"] === "number"
                ? rawFields["authority"]
                : EvidenceAuthority.EpisodicMemory) as SearchHit["authority"],
              namespace:
                typeof rawFields["namespace"] === "string"
                  ? rawFields["namespace"]
                  : "user:default",
              contentHash:
                typeof rawFields["content_hash"] === "string"
                  ? rawFields["content_hash"]
                  : contentHash(record.content),
              metadata: record as unknown as Readonly<Record<string, unknown>>,
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
    const record = adaptLegacyMemory(decodeStoredPayload(stored));
    const currentUser = options.scopeContext?.userId ?? "local";
    const currentTenant = options.scopeContext?.tenantId ?? "local";
    const owner = record.ownership?.userId ?? record.scopeContext?.userId ?? "local";
    const tenant = record.ownership?.tenantId ?? record.scopeContext?.tenantId ?? "local";
    if (options.securityMode === "multi_tenant" && tenant !== currentTenant) return undefined;
    if (owner !== currentUser) return undefined;
    if (options.accessIntent === "explicit_id" && options.securityMode !== "multi_tenant")
      return record;
    if (
      options.scopeContext !== undefined &&
      boundaryKey(record.scopeContext) !== boundaryKey(options.scopeContext)
    )
      return undefined;
    return record;
  }

  async tombstone(id: string, options: MemoryMutationOptions): Promise<boolean> {
    throwIfAborted(options.signal, "memory-tombstone");
    const stored = (await this.#store.fetchVectors("memory", [id])).get(id);
    if (stored === undefined) return false;
    const payload = adaptLegacyMemory(decodeStoredPayload(stored));
    if (boundaryKey(payload.scopeContext) !== boundaryKey(options.scopeContext)) return false;
    const vector = stored.vectors["embedding"];
    if (!(vector instanceof Float32Array) && !Array.isArray(vector)) return false;
    const now = this.#clock.now();
    await this.#store.upsertVectors("memory", [
      this.#record({
        ...payload,
        schemaVersion: 2,
        embedding: vector instanceof Float32Array ? vector : Float32Array.from(vector),
        status: "tombstoned",
        validUntil: now,
        updatedAt: now,
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
    if ((await this.#evidenceIntegrity([evidence], options.scopeContext)) !== "valid")
      return undefined;
    const stored = (await this.#store.fetchVectors("memory", [id])).get(id);
    if (stored === undefined) return undefined;
    const payload = adaptLegacyMemory(decodeStoredPayload(stored));
    if (boundaryKey(payload.scopeContext) !== boundaryKey(options.scopeContext)) return undefined;
    const vector = stored.vectors["embedding"];
    if (!(vector instanceof Float32Array) && !Array.isArray(vector)) return undefined;
    const record: MemoryRecord = {
      ...payload,
      schemaVersion: 2,
      embedding: vector instanceof Float32Array ? vector : Float32Array.from(vector),
      status: "conflicted",
      evidenceRefs: this.#mergeEvidence(payload.evidenceRefs, [evidence]),
      updatedAt: this.#clock.now(),
      revision: payload.revision + 1,
    };
    await this.#store.upsertVectors("memory", [this.#record(record)]);
    return withoutEmbedding(record);
  }

  async abandonBranch(branchId: string, scopeContext: PiScopeContext): Promise<number> {
    const records = await this.#store.filterVectors(
      "memory",
      '(status = "active" OR status = "pending")',
      10_000,
    );
    const updates: StoredVectorRecord[] = [];
    const now = this.#clock.now();
    for (const stored of records) {
      const payload = adaptLegacyMemory(decodeStoredPayload(stored));
      if (
        payload.provenance.epistemicState !== "hypothesis" ||
        payload.provenance.branchLocal !== true ||
        payload.provenance.branchId !== branchId ||
        boundaryKey(payload.scopeContext) !== boundaryKey(scopeContext)
      )
        continue;
      const full = (await this.#store.fetchVectors("memory", [stored.id])).get(stored.id);
      const vector = full?.vectors["embedding"];
      if (full === undefined || (!(vector instanceof Float32Array) && !Array.isArray(vector)))
        continue;
      updates.push(
        this.#record({
          ...payload,
          schemaVersion: 2,
          embedding: vector instanceof Float32Array ? vector : Float32Array.from(vector),
          status: "rejected",
          updatedAt: now,
          revision: payload.revision + 1,
        }),
      );
    }
    if (updates.length > 0) await this.#store.upsertVectors("memory", updates);
    return updates.length;
  }

  async diagnoseLegacyMemory(id: string): Promise<
    | {
        readonly id: string;
        readonly legacy: boolean;
        readonly rawContent: string;
        readonly currentStatus: string;
        readonly legacyMetadata?: NonNullable<MemoryRecord["legacy"]>;
        readonly candidateRelationshipToV2: MemoryRelationship;
        readonly migrationConfidence: number;
        readonly migrationSafe: boolean;
      }
    | undefined
  > {
    const stored = (await this.#store.fetchVectors("memory", [id])).get(id);
    if (stored === undefined) return undefined;
    const raw = decodeStoredPayload(stored);
    const legacy = isLegacyMemory(raw);
    const metadata = legacyMetadata(raw);
    return {
      id,
      legacy,
      rawContent: typeof raw["content"] === "string" ? raw["content"] : "",
      currentStatus: typeof raw["status"] === "string" ? raw["status"] : "unknown",
      ...(metadata === undefined ? {} : { legacyMetadata: metadata }),
      candidateRelationshipToV2: "uncertain",
      migrationConfidence: legacy ? 0.25 : 1,
      migrationSafe: !legacy,
    };
  }

  async diagnoseMemoryScope(id: string): Promise<
    | {
        readonly id: string;
        readonly currentScope: MemoryRecord["scope"];
        readonly recommendedScope: MemoryRecord["scope"];
        readonly confidence: number;
        readonly reason: string;
      }
    | undefined
  > {
    const stored = (await this.#store.fetchVectors("memory", [id])).get(id);
    if (stored === undefined) return undefined;
    const payload = adaptLegacyMemory(decodeStoredPayload(stored));
    const vector = stored.vectors["embedding"];
    if (!(vector instanceof Float32Array) && !Array.isArray(vector)) {
      return {
        id,
        currentScope: payload.scope,
        recommendedScope: payload.scope,
        confidence: 0,
        reason: "record has no embedding",
      };
    }
    const scopeContext = payload.scopeContext ?? {
      tenantId: "local",
      userId: "local",
      appId: "pi",
      agentId: "pi-mentis",
    };
    const decision: ScopeOwnershipDecision = await this.#scopePlanner.decideOwnership(
      {
        content: payload.content,
        embedding: vector instanceof Float32Array ? vector : Float32Array.from(vector),
      },
      scopeContext,
    );
    return {
      id,
      currentScope: payload.scope,
      recommendedScope: memoryScopeForDecision(decision, scopeContext),
      confidence: decision.confidence,
      reason: decision.reason,
    };
  }

  async repairMemoryScope(id: string): Promise<
    | {
        readonly id: string;
        readonly action: "unchanged" | "repaired" | "not_found";
        readonly fromScope?: MemoryRecord["scope"];
        readonly toScope?: MemoryRecord["scope"];
        readonly reason: string;
      }
    | undefined
  > {
    const diagnosis = await this.diagnoseMemoryScope(id);
    if (diagnosis === undefined) return { id, action: "not_found", reason: "record not found" };
    if (
      diagnosis.currentScope.kind === diagnosis.recommendedScope.kind &&
      diagnosis.currentScope.id === diagnosis.recommendedScope.id
    ) {
      return { id, action: "unchanged", reason: diagnosis.reason };
    }
    const stored = (await this.#store.fetchVectors("memory", [id])).get(id);
    if (stored === undefined) return { id, action: "not_found", reason: "record not found" };
    const payload = adaptLegacyMemory(decodeStoredPayload(stored));
    const vector = stored.vectors["embedding"];
    if (!(vector instanceof Float32Array) && !Array.isArray(vector))
      return { id, action: "unchanged", reason: "record has no embedding" };
    const now = this.#clock.now();
    await this.#store.upsertVectors("memory", [
      this.#record({
        ...payload,
        schemaVersion: 2,
        scope: diagnosis.recommendedScope,
        embedding: vector instanceof Float32Array ? vector : Float32Array.from(vector),
        updatedAt: now,
        revision: payload.revision + 1,
      }),
    ]);
    return {
      id,
      action: "repaired",
      fromScope: diagnosis.currentScope,
      toScope: diagnosis.recommendedScope,
      reason: diagnosis.reason,
    };
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

/** @deprecated V1 fact identity no longer exists. Kept only for import compatibility. */
export function deriveFactKey(command: Pick<CommitMemoryCommand, "content">): string {
  return `legacy-content:${contentHash(normalizeText(command.content))}`;
}

export function createMemoryService(options: CreateMemoryServiceOptions): MemoryService {
  return new DefaultMemoryService(options);
}
