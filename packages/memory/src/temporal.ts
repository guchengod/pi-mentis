import { stableHash, systemClock, type Clock } from "@pi-mentis/pi-mentis-core";
import type { StoredRecord, ZvecStore } from "@pi-mentis/pi-mentis-zvec";

import type { MemoryDecisionTrace, MemoryRelationship, MemoryRelationships } from "./types.js";

export type MemoryLifecycleStatus =
  "pending" | "active" | "superseded" | "conflicted" | "expired" | "tombstoned" | "rejected";

export type DerivedTemporalState = "current" | "historical" | "conflicted" | "invalid";

export function deriveTemporalState(status: MemoryLifecycleStatus): DerivedTemporalState {
  switch (status) {
    case "active":
      return "current";
    case "superseded":
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

export interface TemporalRelationshipPlan {
  readonly relation: MemoryRelationship;
  readonly incomingStatus: MemoryLifecycleStatus;
  readonly targetStatus?: MemoryLifecycleStatus;
  readonly relationships: MemoryRelationships;
  readonly temporalAction: string;
}

function emptyRelationships(): MemoryRelationships {
  return {
    reinforcesIds: [],
    supersedesIds: [],
    retractsIds: [],
    conflictsWithIds: [],
    coexistsWithIds: [],
  };
}

/**
 * Temporal V2 is deliberately semantic-agnostic. It receives an already made
 * relationship decision and only maps that decision to lifecycle transitions.
 */
export class TemporalRelationshipEngine {
  readonly #store: ZvecStore;
  readonly #clock: Clock;

  constructor(store: ZvecStore, clock: Clock = systemClock) {
    this.#store = store;
    this.#clock = clock;
  }

  plan(relation: MemoryRelationship, targetIds: readonly string[]): TemporalRelationshipPlan {
    const targets = [...new Set(targetIds)];
    const relationships = emptyRelationships();
    switch (relation) {
      case "reinforce":
        return {
          relation,
          incomingStatus: "active",
          relationships: { ...relationships, reinforcesIds: targets },
          temporalAction: "reinforce_existing",
        };
      case "supersede":
        return {
          relation,
          incomingStatus: "active",
          targetStatus: "superseded",
          relationships: { ...relationships, supersedesIds: targets },
          temporalAction: "activate_incoming_supersede_targets",
        };
      case "retract":
        return {
          relation,
          incomingStatus: "active",
          targetStatus: "tombstoned",
          relationships: { ...relationships, retractsIds: targets },
          temporalAction: "activate_retraction_tombstone_targets",
        };
      case "conflict":
        return {
          relation,
          incomingStatus: "active",
          relationships: { ...relationships, conflictsWithIds: targets },
          temporalAction: "preserve_both_mark_relationship_conflicted",
        };
      case "coexist":
        return {
          relation,
          incomingStatus: "active",
          relationships: { ...relationships, coexistsWithIds: targets },
          temporalAction: "activate_incoming_coexist",
        };
      case "unrelated":
      case "uncertain":
        return {
          relation,
          incomingStatus: "active",
          relationships,
          temporalAction:
            relation === "unrelated"
              ? "activate_incoming"
              : "activate_incoming_preserve_uncertainty",
        };
    }
  }

  async persistTrace(
    input: Omit<MemoryDecisionTrace, "id" | "timestamp">,
  ): Promise<MemoryDecisionTrace> {
    const timestamp = this.#clock.now();
    const id = stableHash(
      "memory-decision-trace:v2",
      input.incomingId,
      input.relationDecision,
      String(timestamp),
    );
    const trace: MemoryDecisionTrace = { ...input, id, timestamp };
    const record: StoredRecord = {
      id,
      kind: "memory-decision-trace",
      namespace: input.incomingId,
      status: "active",
      payload: trace as unknown as Readonly<Record<string, unknown>>,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.#store.upsertScalar("relationships_v1", [record]);
    return trace;
  }

  async persistRelationships(
    namespace: string,
    from: string,
    plan: TemporalRelationshipPlan,
  ): Promise<void> {
    const now = this.#clock.now();
    const pairs: Array<readonly [string, string]> = [
      ...plan.relationships.reinforcesIds.map((id) => ["reinforces", id] as const),
      ...plan.relationships.supersedesIds.map((id) => ["supersedes", id] as const),
      ...plan.relationships.retractsIds.map((id) => ["retracts", id] as const),
      ...plan.relationships.conflictsWithIds.map((id) => ["conflicts", id] as const),
      ...plan.relationships.coexistsWithIds.map((id) => ["coexists", id] as const),
    ];
    if (pairs.length === 0) return;
    await this.#store.upsertScalar(
      "relationships_v1",
      pairs.map(([kind, to]) => {
        const id = stableHash("memory-relationship:v2", kind, from, to);
        return {
          id,
          kind,
          namespace,
          status: "active",
          payload: { id, kind, from, to, createdAt: now },
          createdAt: now,
          updatedAt: now,
        } satisfies StoredRecord;
      }),
    );
  }
}
