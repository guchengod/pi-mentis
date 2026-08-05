import {
  stableHash,
  systemClock,
  type Clock,
  type EvidenceAuthority,
  type OperationOptions,
} from "@pi-mentis/pi-mentis-core";
import {
  StateRevisionConflictError,
  ZvecStateStore,
  type StoredRecord,
  type ZvecStore,
} from "@pi-mentis/pi-mentis-zvec";

import type {
  BranchClaimState,
  MemoryRecord,
  MemoryScope,
  PiScopeContext,
  TemporalCardinality,
  TemporalClaimPointer,
  TemporalHead,
  TemporalRepairResult,
  TemporalState,
} from "./types.js";
import { decodeStoredPayload } from "@pi-mentis/pi-mentis-zvec";

export type MemoryLifecycleStatus =
  | "pending"
  | "active"
  | "superseded"
  | "conflicted"
  | "retracted"
  | "tombstoned"
  | "rejected"
  | "expired";

export type DerivedTemporalState = "current" | "historical" | "conflicted" | "invalid";

/** Centralized temporal state derivation — single source of truth. */
export function deriveTemporalState(status: MemoryLifecycleStatus): DerivedTemporalState {
  switch (status) {
    case "active":
      return "current";
    case "superseded":
    case "retracted":
    case "tombstoned":
    case "expired":
      return "historical";
    case "conflicted":
      return "conflicted";
    case "pending":
    case "rejected":
      return "invalid";
  }
}

export type TemporalDecision =
  | "create"
  | "reinforce"
  | "supersede"
  | "coexist"
  | "historical"
  | "conflict"
  | "retract"
  | "pending"
  | "reject";

export interface TemporalPlan {
  readonly sagaId: string;
  readonly headId: string;
  readonly namespace: string;
  readonly factKey: string;
  readonly cardinality: TemporalCardinality;
  readonly decision: TemporalDecision;
  readonly claim: TemporalClaimPointer;
  readonly previousHead?: TemporalHead;
  readonly nextHead: TemporalHead;
  readonly supersedesIds: readonly string[];
  readonly conflictsWithIds: readonly string[];
  readonly temporalState: TemporalState;
}

interface TemporalSaga {
  readonly sagaId: string;
  readonly plan: TemporalPlan;
  readonly stage:
    | "prepared"
    | "claim-written"
    | "relationships-written"
    | "head-written"
    | "completed"
    | "abandoned"
    | "failed";
  readonly attempts: number;
  readonly failure?: string;
}

function boundary(context: PiScopeContext | undefined): string {
  return [
    context?.tenantId ?? "local",
    context?.userId ?? "local",
    context?.appId ?? "pi",
    context?.agentId ?? "pi-mentis",
  ]
    .map(encodeURIComponent)
    .join(":");
}

export function temporalNamespace(scope: MemoryScope, context?: PiScopeContext): string {
  return `${boundary(context)}::${scope.kind}:${encodeURIComponent(scope.id)}`;
}

function pointerEquals(left: TemporalClaimPointer, right: TemporalClaimPointer): boolean {
  return left.memoryId === right.memoryId || left.contentHash === right.contentHash;
}

function headState(decision: TemporalDecision): TemporalHead["state"] {
  if (decision === "conflict") return "conflicted";
  if (decision === "retract") return "retracted";
  return "resolved";
}

export class TemporalTruthEngine {
  readonly #store: ZvecStore;
  readonly #state: ZvecStateStore;
  readonly #clock: Clock;

  constructor(store: ZvecStore, clock: Clock = systemClock) {
    this.#store = store;
    this.#state = new ZvecStateStore(store);
    this.#clock = clock;
  }

  async head(
    factKey: string,
    scope: MemoryScope,
    context?: PiScopeContext,
  ): Promise<TemporalHead | undefined> {
    const namespace = temporalNamespace(scope, context);
    const state = await this.#state.get<TemporalHead>(this.#headId(namespace, factKey));
    return state?.value;
  }

  async prepare(input: {
    readonly factKey: string;
    readonly cardinality: TemporalCardinality;
    readonly scope: MemoryScope;
    readonly scopeContext?: PiScopeContext;
    readonly memoryId: string;
    readonly contentHash: string;
    readonly authority: EvidenceAuthority;
    readonly observedAt: number;
    readonly retractsFact?: boolean;
    readonly branchClaimState?: BranchClaimState;
  }): Promise<TemporalPlan> {
    const baseNamespace = temporalNamespace(input.scope, input.scopeContext);
    const isUnverifiedBranch = input.branchClaimState === "hypothesis";
    const namespace = isUnverifiedBranch
      ? `${baseNamespace}::branch:${encodeURIComponent(input.scopeContext?.branchId ?? input.scope.id)}`
      : baseNamespace;
    const headId = this.#headId(namespace, input.factKey);
    const previousHead = (await this.#state.get<TemporalHead>(headId))?.value;
    const claim: TemporalClaimPointer = {
      memoryId: input.memoryId,
      contentHash: input.contentHash,
      authority: input.authority,
      observedAt: input.observedAt,
      ...(input.scopeContext?.branchId === undefined
        ? {}
        : { branchId: input.scopeContext.branchId }),
    };
    const current = previousHead?.currentClaims ?? [];
    let decision: TemporalDecision;
    if (input.branchClaimState === "abandoned") decision = "reject";
    else if (isUnverifiedBranch) decision = "pending";
    else if (input.retractsFact === true) decision = "retract";
    else if (current.some((item) => pointerEquals(item, claim))) {
      const competing = current.filter((item) => !pointerEquals(item, claim));
      const strongestCompetitor = Math.max(0, ...competing.map((item) => item.authority));
      decision =
        input.cardinality === "single" &&
        competing.length > 0 &&
        claim.authority > strongestCompetitor
          ? "supersede"
          : "reinforce";
    } else if (current.length === 0) decision = "create";
    else if (input.cardinality !== "single") decision = "coexist";
    else {
      const latest = [...current].sort(
        (left, right) => right.observedAt - left.observedAt || right.authority - left.authority,
      )[0];
      if (latest === undefined) decision = "create";
      else if (claim.observedAt < latest.observedAt) decision = "historical";
      else if (claim.authority > latest.authority) decision = "supersede";
      else if (claim.observedAt > latest.observedAt && claim.authority >= latest.authority) {
        decision = "supersede";
      } else decision = "conflict";
    }
    const nextClaims =
      decision === "retract"
        ? []
        : decision === "supersede" || decision === "create"
          ? [claim]
          : decision === "conflict" || decision === "coexist"
            ? [...current.filter((item) => item.memoryId !== claim.memoryId), claim]
            : decision === "reinforce"
              ? current.map((item) =>
                  pointerEquals(item, claim)
                    ? {
                        ...item,
                        authority: Math.max(item.authority, claim.authority) as EvidenceAuthority,
                        observedAt: Math.max(item.observedAt, claim.observedAt),
                      }
                    : item,
                )
              : current.length === 0 && decision === "pending"
                ? [claim]
                : current;
    const revision =
      (previousHead?.revision ?? 0) +
      (decision === "reinforce" || decision === "historical" ? 0 : 1);
    const nextHead: TemporalHead = {
      id: headId,
      factKey: input.factKey,
      namespace,
      cardinality: input.cardinality,
      state: decision === "reinforce" ? (previousHead?.state ?? "resolved") : headState(decision),
      currentClaims: nextClaims,
      revision,
      updatedAt: this.#clock.now(),
    };
    const supersedesIds =
      decision === "supersede"
        ? current.filter((item) => item.memoryId !== claim.memoryId).map((item) => item.memoryId)
        : [];
    const conflictsWithIds = decision === "conflict" ? current.map((item) => item.memoryId) : [];
    const temporalState: TemporalState =
      decision === "pending"
        ? "pending"
        : decision === "reject"
          ? "rejected"
          : decision === "conflict"
            ? "conflicted"
            : decision === "reinforce" && previousHead?.state === "conflicted"
              ? "conflicted"
              : decision === "retract"
                ? "retracted"
                : decision === "historical"
                  ? "historical"
                  : "current";
    const sagaId = `temporal-saga:${stableHash(
      "temporal-saga:v1",
      namespace,
      input.factKey,
      input.memoryId,
    )}`;
    const plan: TemporalPlan = {
      sagaId,
      headId,
      namespace,
      factKey: input.factKey,
      cardinality: input.cardinality,
      decision,
      claim,
      ...(previousHead === undefined ? {} : { previousHead }),
      nextHead,
      supersedesIds,
      conflictsWithIds,
      temporalState,
    };
    await this.#writeSaga({ sagaId, plan, stage: "prepared", attempts: 0 });
    return plan;
  }

  async claimWritten(plan: TemporalPlan): Promise<void> {
    await this.#writeSaga({ sagaId: plan.sagaId, plan, stage: "claim-written", attempts: 0 });
  }

  async apply(plan: TemporalPlan): Promise<void> {
    if (plan.decision === "reject") {
      await this.#writeSaga({ sagaId: plan.sagaId, plan, stage: "completed", attempts: 1 });
      return;
    }
    if (plan.decision === "historical") {
      await this.#writeSaga({ sagaId: plan.sagaId, plan, stage: "completed", attempts: 1 });
      return;
    }
    const relations: StoredRecord[] = [
      ...plan.supersedesIds.map((target) =>
        this.#relationship(plan, "supersedes", plan.claim.memoryId, target),
      ),
      ...plan.conflictsWithIds.flatMap((target) => [
        this.#relationship(plan, "conflicts", plan.claim.memoryId, target),
        this.#relationship(plan, "conflicts", target, plan.claim.memoryId),
      ]),
    ];
    if (relations.length > 0) await this.#store.upsertScalar("relationships_v1", relations);
    await this.#writeSaga({
      sagaId: plan.sagaId,
      plan,
      stage: "relationships-written",
      attempts: 1,
    });
    const existing = await this.#state.get<TemporalHead>(plan.headId);
    if (
      existing === undefined ||
      JSON.stringify(existing.value) !== JSON.stringify(plan.nextHead)
    ) {
      try {
        await this.#state.put(
          {
            id: plan.headId,
            kind: "temporal-head",
            namespace: plan.namespace,
            value: plan.nextHead as unknown as Readonly<Record<string, unknown>>,
          },
          {
            expectedRevision: existing?.revision ?? 0,
            now: this.#clock.now(),
          },
        );
      } catch (error: unknown) {
        if (!(error instanceof StateRevisionConflictError)) throw error;
        const refreshed = await this.#state.get<TemporalHead>(plan.headId);
        if (
          refreshed?.value.currentClaims.some((item) => item.memoryId === plan.claim.memoryId) !==
          true
        ) {
          throw error;
        }
      }
    }
    await this.#writeSaga({ sagaId: plan.sagaId, plan, stage: "head-written", attempts: 1 });
    await this.#writeSaga({ sagaId: plan.sagaId, plan, stage: "completed", attempts: 1 });
  }

  async repairConsistency(
    store: ZvecStore,
    options?: { signal?: AbortSignal; limit?: number },
  ): Promise<{ inspected: number; repaired: number; errors: string[] }> {
    const records = await store.filterVectors(
      "memory",
      "status != 'tombstoned' AND status != 'rejected'",
      options?.limit ?? 10_000,
    );
    let scanned = 0;
    let repaired = 0;
    const errors: string[] = [];
    const now = this.#clock.now();
    const updates: Array<{
      id: string;
      payload: Record<string, unknown>;
      embedding: Float32Array | number[];
    }> = [];
    for (const stored of records) {
      if (options?.signal?.aborted === true) throw options.signal.reason;
      scanned++;
      try {
        const payload = decodeStoredPayload(stored) as unknown as Omit<MemoryRecord, "embedding">;
        const vector = stored.vectors["embedding"];
        if (!(vector instanceof Float32Array) && !Array.isArray(vector)) continue;
        const expectedTemporalState = deriveTemporalState(payload.status as MemoryLifecycleStatus);
        if (payload.temporalState !== expectedTemporalState) {
          updates.push({
            id: stored.id,
            payload: {
              ...payload,
              temporalState: expectedTemporalState,
              updatedAt: now,
              revision: (payload.revision ?? 0) + 1,
            } as unknown as Record<string, unknown>,
            embedding: vector instanceof Float32Array ? vector : Float32Array.from(vector),
          });
          repaired++;
        }
      } catch (error: unknown) {
        errors.push(
          `Record ${stored.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (updates.length > 0) {
      await store.upsertVectors(
        "memory",
        updates.map((update) => ({
          id: update.id,
          kind: "memory" as const,
          namespace: String(update.payload["namespace"] ?? ""),
          status: (update.payload["status"] as string | undefined) ?? "active",
          payload: update.payload,
          searchableText: String(update.payload["normalizedContent"] ?? ""),
          contentHash: String(update.payload["contentHash"] ?? ""),
          sourceId: String(update.payload["namespace"] ?? update.payload["sourceId"] ?? ""),
          documentId: update.id,
          authority: (update.payload["authority"] as number) ?? 30,
          tokenCount: Math.max(
            1,
            Buffer.byteLength(String(update.payload["normalizedContent"] ?? ""), "utf8"),
          ),
          revision: (update.payload["revision"] as number) ?? 1,
          embedding:
            update.embedding instanceof Float32Array
              ? update.embedding
              : Float32Array.from(update.embedding),
          createdAt: (update.payload["createdAt"] as number) ?? now,
          updatedAt: now,
        })),
      );
    }
    return { inspected: scanned, repaired, errors };
  }

  async repair(
    reconcileClaim: (plan: TemporalPlan) => Promise<boolean>,
    options: OperationOptions = {},
  ): Promise<TemporalRepairResult> {
    const sagas = await this.#state.list<TemporalSaga>({ kind: "temporal-saga", limit: 10_000 });
    let repaired = 0;
    let failed = 0;
    for (const state of sagas) {
      if (state.value.stage === "completed" || state.value.stage === "abandoned") continue;
      if (options.signal?.aborted === true) throw options.signal.reason;
      try {
        const claimExists = await reconcileClaim(state.value.plan);
        if (!claimExists) {
          await this.#writeSaga({
            ...state.value,
            stage: "abandoned",
            attempts: state.value.attempts + 1,
          });
          repaired++;
          continue;
        }
        await this.apply(state.value.plan);
        repaired++;
      } catch (error: unknown) {
        failed++;
        await this.#writeSaga({
          ...state.value,
          stage: "failed",
          attempts: state.value.attempts + 1,
          failure: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { inspected: sagas.length, repaired, failed };
  }

  #headId(namespace: string, factKey: string): string {
    return this.#state.id("temporal-head", namespace, factKey);
  }

  #relationship(
    plan: TemporalPlan,
    kind: "supersedes" | "conflicts",
    from: string,
    to: string,
  ): StoredRecord {
    const now = this.#clock.now();
    const id = `relationship:${stableHash("memory-relationship:v1", kind, from, to)}`;
    return {
      id,
      kind,
      namespace: plan.namespace,
      status: "active",
      payload: { id, kind, from, to, factKey: plan.factKey, createdAt: now },
      createdAt: now,
      updatedAt: now,
    };
  }

  async #writeSaga(saga: TemporalSaga): Promise<void> {
    await this.#state.put(
      {
        id: saga.sagaId,
        kind: "temporal-saga",
        namespace: saga.plan.namespace,
        value: saga as unknown as Readonly<Record<string, unknown>>,
      },
      { status: saga.stage, now: this.#clock.now() },
    );
  }
}
