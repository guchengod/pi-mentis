import type {
  MemoryRelationship,
  MemoryRelationshipEvidence,
  MemorySemanticHints,
  PairwiseRelationshipSignals,
} from "./types.js";
import type { MentisBackgroundQueue } from "./background-queue.js";

export interface RecalledMemoryEvidence {
  readonly id: string;
  readonly content: string;
  readonly status: "current" | "historical" | "conflicted";
  readonly match: "exact" | "profile" | "view" | "lexical" | "semantic" | "anchored";
  readonly evidenceSource?: "same_turn_recall" | "semantic_candidate";
}

export interface PairwiseRelationshipJudgment {
  readonly relation: MemoryRelationship;
  readonly confidence: number;
  readonly signals: PairwiseRelationshipSignals;
  readonly incomingHints?: MemorySemanticHints;
  readonly targetHints?: MemorySemanticHints;
  readonly reasonCodes: readonly string[];
}

export interface PairwiseRelationshipReasoner {
  judge(
    incomingContent: string,
    candidate: RecalledMemoryEvidence,
    signal?: AbortSignal,
  ): Promise<PairwiseRelationshipJudgment>;
}

/**
 * The model's pairwise output is an untrusted semantic proposal. Only these
 * deterministic, relationship-specific gates can authorize persistent state
 * transitions.
 */
export interface RelationshipProposal {
  readonly relation: MemoryRelationship;
  readonly confidence: number;
  readonly signals?: PairwiseRelationshipSignals;
  readonly incomingHints?: MemorySemanticHints;
  readonly targetHints?: MemorySemanticHints;
}

export interface RelationshipEvidenceValidation {
  readonly valid: boolean;
  readonly gateName?: "reinforceGate" | "supersedeGate" | "retractGate" | "conflictGate";
  readonly rejectReasons: readonly string[];
}

function canonicalHint(value: string | undefined): string | undefined {
  const normalized = value
    ?.normalize("NFKC")
    .toLocaleLowerCase()
    .replaceAll(/[\p{P}\p{S}\s]+/gu, "");
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function corroboratesSameIdentity(
  incoming: string | undefined,
  target: string | undefined,
): boolean {
  const left = canonicalHint(incoming);
  const right = canonicalHint(target);
  return left !== undefined && right !== undefined && left === right;
}

function hasCanonicalHint(value: string | undefined): boolean {
  return canonicalHint(value) !== undefined;
}

/**
 * Rejects internally contradictory model proposals before a relationship gate
 * can authorize a persistent transition. Pairwise hints are open text, not a
 * subject registry; they only corroborate that both sides name the same target.
 */
export function validateRelationshipEvidence(
  proposal: RelationshipProposal,
): RelationshipEvidenceValidation {
  const signals = proposal.signals;
  if (signals === undefined) return { valid: false, rejectReasons: ["signals_missing"] };
  const identity = signals.identityEvidence;
  if (identity === undefined) {
    return { valid: false, rejectReasons: ["identity_evidence_missing"] };
  }
  const rejectReasons: string[] = [];
  const gateName =
    proposal.relation === "reinforce"
      ? "reinforceGate"
      : proposal.relation === "supersede"
        ? "supersedeGate"
        : proposal.relation === "retract"
          ? "retractGate"
          : proposal.relation === "conflict"
            ? "conflictGate"
            : undefined;
  if (gateName === undefined) {
    return { valid: false, rejectReasons: ["relationship_is_non_mutating"] };
  }
  const threshold =
    proposal.relation === "reinforce"
      ? 0.9
      : proposal.relation === "supersede"
        ? 0.92
        : proposal.relation === "retract"
          ? 0.94
          : 0.95;
  if (proposal.confidence < threshold) rejectReasons.push("confidence_below_gate_threshold");
  if (identity.referent !== "same") rejectReasons.push("referent_identity_not_same");
  if (identity.attribute !== "same") rejectReasons.push("attribute_identity_not_same");
  if (
    identity.referent === "same" &&
    !corroboratesSameIdentity(
      proposal.incomingHints?.subjectHint,
      proposal.targetHints?.subjectHint,
    )
  ) {
    rejectReasons.push("referent_identity_not_corroborated");
  }
  if (
    identity.attribute === "same" &&
    !(
      corroboratesSameIdentity(
        proposal.incomingHints?.relationHint,
        proposal.targetHints?.relationHint,
      ) ||
      (corroboratesSameIdentity(
        proposal.incomingHints?.subjectHint,
        proposal.targetHints?.subjectHint,
      ) &&
        hasCanonicalHint(proposal.incomingHints?.relationHint) &&
        hasCanonicalHint(proposal.targetHints?.relationHint))
    )
  ) {
    rejectReasons.push("attribute_identity_not_corroborated");
  }

  switch (proposal.relation) {
    case "reinforce":
      if (identity.value !== "same") rejectReasons.push("reinforcement_value_not_same");
      if (!signals.compatibleValue || signals.incompatibleValue) {
        rejectReasons.push("reinforcement_value_signals_inconsistent");
      }
      if (
        signals.replacementValuePresent ||
        signals.explicitRetraction ||
        signals.mutuallyExclusive
      ) {
        rejectReasons.push("reinforcement_contains_destructive_semantics");
      }
      break;
    case "supersede":
      if (identity.value !== "different") rejectReasons.push("replacement_value_not_different");
      if (
        !signals.explicitNewAssertion ||
        signals.explicitRetraction ||
        !signals.replacementValuePresent ||
        !signals.incompatibleValue ||
        signals.compatibleValue
      ) {
        rejectReasons.push("replacement_evidence_inconsistent");
      }
      break;
    case "retract":
      if (
        !signals.explicitRetraction ||
        signals.replacementValuePresent ||
        signals.compatibleValue ||
        signals.mutuallyExclusive
      ) {
        rejectReasons.push("withdrawal_evidence_inconsistent");
      }
      break;
    case "conflict":
      if (identity.value !== "different") rejectReasons.push("conflict_value_not_different");
      if (
        !signals.mutuallyExclusive ||
        !signals.incompatibleValue ||
        signals.compatibleValue ||
        signals.explicitNewAssertion ||
        signals.explicitRetraction ||
        signals.replacementValuePresent
      ) {
        rejectReasons.push("conflict_evidence_inconsistent");
      }
      break;
    default:
      break;
  }
  return { valid: rejectReasons.length === 0, gateName, rejectReasons };
}

export function reinforceGate(proposal: RelationshipProposal): boolean {
  const { confidence, signals } = proposal;
  return (
    proposal.relation === "reinforce" &&
    signals !== undefined &&
    validateRelationshipEvidence(proposal).valid &&
    confidence >= 0.9 &&
    signals.compatibleValue &&
    !signals.incompatibleValue &&
    !signals.replacementValuePresent &&
    !signals.explicitRetraction
  );
}

export function supersedeGate(proposal: RelationshipProposal): boolean {
  const { confidence, signals } = proposal;
  return (
    proposal.relation === "supersede" &&
    signals !== undefined &&
    validateRelationshipEvidence(proposal).valid &&
    confidence >= 0.92 &&
    signals.explicitNewAssertion &&
    !signals.explicitRetraction &&
    signals.replacementValuePresent &&
    signals.incompatibleValue &&
    !signals.compatibleValue
  );
}

export function retractGate(proposal: RelationshipProposal): boolean {
  const { confidence, signals } = proposal;
  return (
    proposal.relation === "retract" &&
    signals !== undefined &&
    validateRelationshipEvidence(proposal).valid &&
    confidence >= 0.94 &&
    signals.explicitRetraction &&
    !signals.replacementValuePresent &&
    !signals.compatibleValue
  );
}

export function conflictGate(proposal: RelationshipProposal): boolean {
  const { confidence, signals } = proposal;
  return (
    proposal.relation === "conflict" &&
    signals !== undefined &&
    validateRelationshipEvidence(proposal).valid &&
    confidence >= 0.95 &&
    signals.incompatibleValue &&
    !signals.compatibleValue &&
    !signals.explicitNewAssertion &&
    !signals.explicitRetraction &&
    !signals.replacementValuePresent
  );
}

export function acceptsRelationshipProposal(proposal: RelationshipProposal): boolean {
  switch (proposal.relation) {
    case "reinforce":
      return reinforceGate(proposal);
    case "supersede":
      return supersedeGate(proposal);
    case "retract":
      return retractGate(proposal);
    case "conflict":
      return conflictGate(proposal);
    default:
      return false;
  }
}

/** Turn-local evidence is cleared by the extension whenever a new user input begins. */
export class CurrentTurnMemoryEvidence {
  #recalled: RecalledMemoryEvidence[] = [];
  #turn = 0;

  beginTurn(): void {
    this.#turn += 1;
    this.#recalled = [];
  }

  recordRecall(hits: readonly RecalledMemoryEvidence[]): void {
    const current = hits.filter((hit) => hit.status === "current");
    const ids = new Set(current.map((hit) => hit.id));
    this.#recalled = [...current, ...this.#recalled.filter((hit) => !ids.has(hit.id))].slice(0, 24);
  }

  snapshot(limit: number = 6): readonly RecalledMemoryEvidence[] {
    return this.#recalled.slice(0, Math.max(0, limit));
  }

  get turn(): number {
    return this.#turn;
  }
}

/**
 * Produces evidence only from concrete recalled pairs. Similarity is never an
 * input here, and ambiguous multi-target judgments are deliberately discarded.
 */
export class RelationshipEvidenceProducer {
  async produce(
    incomingContent: string,
    candidates: readonly RecalledMemoryEvidence[],
    reasoner: PairwiseRelationshipReasoner,
  ): Promise<MemoryRelationshipEvidence | undefined> {
    const current = candidates.filter((candidate) => candidate.status === "current").slice(0, 3);
    const judgments = await Promise.allSettled(
      current.map(async (candidate) => ({
        candidate,
        judgment: await reasoner.judge(incomingContent, candidate),
      })),
    );
    const fulfilledJudgments = judgments.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    if (fulfilledJudgments.length === 0) {
      const failure = judgments.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      return undefined;
    }
    const acceptedJudgments = fulfilledJudgments
      .filter(({ judgment }) => acceptsRelationshipProposal(judgment))
      .sort((left, right) => right.judgment.confidence - left.judgment.confidence);
    const strongest = acceptedJudgments[0];
    const runnerUp = acceptedJudgments[1];
    const ambiguous =
      strongest !== undefined &&
      runnerUp !== undefined &&
      runnerUp.judgment.confidence >= strongest.judgment.confidence - 0.03;
    const selected =
      strongest === undefined || ambiguous
        ? fulfilledJudgments.toSorted(
            (left, right) => right.judgment.confidence - left.judgment.confidence,
          )[0]
        : strongest;
    if (selected === undefined) return undefined;
    const targetHints =
      selected.judgment.targetHints === undefined
        ? undefined
        : { [selected.candidate.id]: selected.judgment.targetHints };
    const candidateReason =
      selected.candidate.evidenceSource === "semantic_candidate"
        ? "semantic_candidate_pairwise_review"
        : "same_turn_recalled_target";
    const validation = validateRelationshipEvidence(selected.judgment);
    const gateAccepted = strongest !== undefined && !ambiguous;
    const gateRejectReasons = gateAccepted
      ? []
      : ambiguous
        ? ["ambiguous_competing_relationship_targets"]
        : validation.rejectReasons;
    return {
      relation: selected.judgment.relation,
      targetIds: [selected.candidate.id],
      confidence: selected.judgment.confidence,
      reasonCodes: [
        "pairwise_memory_reasoning",
        candidateReason,
        ...selected.judgment.reasonCodes,
        ...(gateAccepted ? [] : ["deterministic_gate_rejected"]),
      ],
      source: "background_consolidation",
      signals: selected.judgment.signals,
      proposalRelationship: selected.judgment.relation,
      proposalConfidence: selected.judgment.confidence,
      ...(validation.gateName === undefined ? {} : { gateName: validation.gateName }),
      gateAccepted,
      gateRejectReasons,
      ...(selected.judgment.incomingHints === undefined
        ? {}
        : { incomingHints: selected.judgment.incomingHints }),
      ...(targetHints === undefined ? {} : { targetHints }),
    };
  }
}

export interface RelationshipConsolidationCoordinatorOptions {
  readonly memory: import("./types.js").MemoryService;
  readonly producer?: RelationshipEvidenceProducer;
}

export class RelationshipConsolidationCoordinator {
  readonly #memory: import("./types.js").MemoryService;
  readonly #producer: RelationshipEvidenceProducer;

  constructor(options: RelationshipConsolidationCoordinatorOptions) {
    this.#memory = options.memory;
    this.#producer = options.producer ?? new RelationshipEvidenceProducer();
  }

  async consolidate(
    incomingId: string,
    recalled: readonly RecalledMemoryEvidence[],
    reasoner: PairwiseRelationshipReasoner,
    scopeContext: import("./types.js").PiScopeContext,
    execution: {
      readonly owner?: string;
      readonly recoveryReason?: import("./types.js").RelationshipRecoveryReason;
      readonly leaseMs?: number;
    } = {},
  ): Promise<import("./types.js").RelationshipConsolidationResult | undefined> {
    if (this.#memory.consolidateRelationship === undefined || recalled.length === 0) {
      return undefined;
    }
    let candidates = recalled;
    let claimed = false;
    let failed = false;
    let operationKeys: readonly string[] = [];
    if (this.#memory.claimRelationshipLearning !== undefined) {
      const lease = await this.#memory.claimRelationshipLearning(
        incomingId,
        {
          owner: execution.owner ?? `pi-mentis:${process.pid}`,
          leaseMs: execution.leaseMs ?? 45_000,
          recoveryReason: execution.recoveryReason ?? "normal",
        },
        { scopeContext },
      );
      if (lease === undefined) return undefined;
      claimed = true;
      const supplied = new Map(recalled.map((candidate) => [candidate.id, candidate]));
      candidates = lease.candidates.map(
        (candidate) =>
          supplied.get(candidate.id) ?? {
            id: candidate.id,
            content: "",
            status: "current" as const,
            match: "semantic" as const,
            evidenceSource: candidate.source,
          },
      );
    }
    try {
      const incoming = await this.#memory.get(incomingId, {
        scopeContext,
        accessIntent: "explicit_id",
      });
      if (incoming === undefined || incoming.status !== "active") return undefined;
      const fresh: RecalledMemoryEvidence[] = [];
      for (const candidate of candidates) {
        if (candidate.id === incomingId) continue;
        const record = await this.#memory.get(candidate.id, {
          scopeContext,
          accessIntent: "explicit_id",
        });
        if (record?.status !== "active") continue;
        fresh.push({ ...candidate, content: record.content, status: "current" });
      }
      const evidence = await this.#producer.produce(incoming.content, fresh, reasoner);
      const result =
        evidence === undefined
          ? undefined
          : await this.#memory.consolidateRelationship(incomingId, evidence, { scopeContext });
      operationKeys = result?.operationKey === undefined ? [] : [result.operationKey];
      return result;
    } catch (error) {
      failed = true;
      await this.#memory.failRelationshipLearning?.(incomingId, error, { scopeContext });
      throw error;
    } finally {
      if (claimed && !failed) {
        await this.#memory.resolveRelationshipLearning?.(incomingId, operationKeys, {
          scopeContext,
        });
      }
    }
  }
}

export interface DurableRelationshipLearningCoordinatorOptions {
  readonly memory: import("./types.js").MemoryService;
  readonly queue: MentisBackgroundQueue;
  readonly owner?: string;
  readonly leaseMs?: number;
}

export interface RelationshipLearningSchedulingTarget {
  schedule(
    work: import("./types.js").RelationshipLearningWork,
    reasoner: PairwiseRelationshipReasoner,
    recoveryReason?: import("./types.js").RelationshipRecoveryReason,
    onResolved?: (incomingId: string) => void,
  ): void;
  recover(
    reasoner: PairwiseRelationshipReasoner,
    limit?: number,
    onResolved?: (incomingId: string) => void,
  ): Promise<number>;
}

export interface DeferredRelationshipLearningSchedulerOptions {
  readonly delayMs?: number;
}

/**
 * Keeps remote pairwise reasoning out of the active Agent turn. Durable work is
 * already persisted before it reaches this scheduler, so cancelling an idle
 * timer on CLI shutdown never loses the relationship task.
 */
export class DeferredRelationshipLearningScheduler {
  readonly #target: RelationshipLearningSchedulingTarget;
  readonly #delayMs: number;
  readonly #pending = new Map<
    string,
    {
      readonly work: import("./types.js").RelationshipLearningWork;
      readonly reasoner: PairwiseRelationshipReasoner;
      readonly recoveryReason: import("./types.js").RelationshipRecoveryReason;
      readonly onResolved?: (incomingId: string) => void;
    }
  >();
  #recovery:
    | {
        readonly reasoner: PairwiseRelationshipReasoner;
        readonly limit: number;
        readonly onResolved?: (incomingId: string) => void;
      }
    | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #settled = false;
  #closed = false;

  constructor(
    target: RelationshipLearningSchedulingTarget,
    options: DeferredRelationshipLearningSchedulerOptions = {},
  ) {
    this.#target = target;
    this.#delayMs = Math.max(0, options.delayMs ?? 250);
  }

  schedule(
    work: import("./types.js").RelationshipLearningWork,
    reasoner: PairwiseRelationshipReasoner,
    recoveryReason: import("./types.js").RelationshipRecoveryReason = "normal",
    onResolved?: (incomingId: string) => void,
  ): void {
    if (this.#closed) return;
    this.#pending.set(work.incomingId, {
      work,
      reasoner,
      recoveryReason,
      ...(onResolved === undefined ? {} : { onResolved }),
    });
    this.#arm();
  }

  recover(
    reasoner: PairwiseRelationshipReasoner,
    limit = 128,
    onResolved?: (incomingId: string) => void,
  ): void {
    if (this.#closed) return;
    this.#recovery = {
      reasoner,
      limit,
      ...(onResolved === undefined ? {} : { onResolved }),
    };
    this.#arm();
  }

  activity(): void {
    this.#settled = false;
    this.#cancelTimer();
  }

  settled(): void {
    this.#settled = true;
    this.#arm();
  }

  close(): void {
    this.#closed = true;
    this.#cancelTimer();
    this.#pending.clear();
    this.#recovery = undefined;
  }

  get pendingCount(): number {
    return this.#pending.size + (this.#recovery === undefined ? 0 : 1);
  }

  #arm(): void {
    if (
      this.#closed ||
      !this.#settled ||
      this.#timer !== undefined ||
      (this.#pending.size === 0 && this.#recovery === undefined)
    ) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#flush();
    }, this.#delayMs);
    this.#timer.unref?.();
  }

  async #flush(): Promise<void> {
    if (this.#closed || !this.#settled) return;
    const recovery = this.#recovery;
    this.#recovery = undefined;
    if (recovery !== undefined) {
      await this.#target
        .recover(recovery.reasoner, recovery.limit, recovery.onResolved)
        .catch(() => undefined);
    }
    if (this.#closed || !this.#settled) return;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const item of pending) {
      this.#target.schedule(item.work, item.reasoner, item.recoveryReason, item.onResolved);
    }
    this.#arm();
  }

  #cancelTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

/** Schedules durable work, recovers expired leases, and applies bounded retry backoff. */
export class DurableRelationshipLearningCoordinator {
  readonly #memory: import("./types.js").MemoryService;
  readonly #queue: MentisBackgroundQueue;
  readonly #consolidation: RelationshipConsolidationCoordinator;
  readonly #owner: string;
  readonly #leaseMs: number;
  readonly #retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #activeControllers = new Set<AbortController>();
  #closed = false;

  constructor(options: DurableRelationshipLearningCoordinatorOptions) {
    this.#memory = options.memory;
    this.#queue = options.queue;
    this.#consolidation = new RelationshipConsolidationCoordinator({ memory: options.memory });
    this.#owner = options.owner ?? `pi-mentis:${process.pid}`;
    this.#leaseMs = options.leaseMs ?? 45_000;
  }

  schedule(
    work: import("./types.js").RelationshipLearningWork,
    reasoner: PairwiseRelationshipReasoner,
    recoveryReason: import("./types.js").RelationshipRecoveryReason = "normal",
    onResolved?: (incomingId: string) => void,
  ): void {
    if (this.#closed) return;
    const candidates: RecalledMemoryEvidence[] = work.candidates.map((candidate) => ({
      id: candidate.id,
      content: "",
      status: "current",
      match: "semantic",
      evidenceSource: candidate.source,
    }));
    this.#queue.enqueue({
      kind: "memory.consolidate",
      coalesceKey: `memory.consolidate:${work.incomingId}`,
      execute: async () => {
        if (this.#closed) return;
        const controller = new AbortController();
        this.#activeControllers.add(controller);
        const cancellableReasoner: PairwiseRelationshipReasoner = {
          judge: (incomingContent, candidate) =>
            reasoner.judge(incomingContent, candidate, controller.signal),
        };
        try {
          await this.#consolidation.consolidate(
            work.incomingId,
            candidates,
            cancellableReasoner,
            work.scopeContext,
            { owner: this.#owner, leaseMs: this.#leaseMs, recoveryReason },
          );
          const latest = await this.#memory.getRelationshipLearning?.(work.incomingId);
          if (latest?.state === "resolved") onResolved?.(work.incomingId);
          else if (latest?.state === "pending" || latest?.state === "processing") {
            this.#scheduleDeferred(latest, reasoner, onResolved);
          } else if (latest?.state === "failed_retryable") {
            await this.#scheduleRetry(work.incomingId, reasoner, onResolved);
          }
        } catch {
          await this.#scheduleRetry(work.incomingId, reasoner, onResolved);
        } finally {
          this.#activeControllers.delete(controller);
        }
      },
    });
  }

  async recover(
    reasoner: PairwiseRelationshipReasoner,
    limit = 128,
    onResolved?: (incomingId: string) => void,
  ): Promise<number> {
    const recoverable = (await this.#memory.listPendingRelationshipLearning?.({ limit })) ?? [];
    for (const work of recoverable) {
      const recoveryReason =
        work.state === "processing"
          ? "lease_recovery"
          : work.state === "failed_retryable"
            ? "retry"
            : "startup_reconciliation";
      this.schedule(work, reasoner, recoveryReason, onResolved);
    }
    return recoverable.length;
  }

  close(): void {
    this.#closed = true;
    for (const controller of this.#activeControllers) controller.abort();
    this.#activeControllers.clear();
    for (const timer of this.#retryTimers.values()) clearTimeout(timer);
    this.#retryTimers.clear();
  }

  async #scheduleRetry(
    incomingId: string,
    reasoner: PairwiseRelationshipReasoner,
    onResolved?: (incomingId: string) => void,
  ): Promise<void> {
    if (this.#closed || this.#retryTimers.has(incomingId)) return;
    const work = await this.#memory.getRelationshipLearning?.(incomingId);
    if (work?.state !== "failed_retryable") return;
    const delay = Math.max(0, (work.nextRetryAt ?? Date.now()) - Date.now());
    const timer = setTimeout(() => {
      this.#retryTimers.delete(incomingId);
      if (!this.#closed) this.schedule(work, reasoner, "retry", onResolved);
    }, delay);
    timer.unref?.();
    this.#retryTimers.set(incomingId, timer);
  }

  #scheduleDeferred(
    work: import("./types.js").RelationshipLearningWork,
    reasoner: PairwiseRelationshipReasoner,
    onResolved?: (incomingId: string) => void,
  ): void {
    if (this.#closed || this.#retryTimers.has(work.incomingId)) return;
    const delay =
      work.state === "processing"
        ? Math.max(1_000, (work.leaseExpiresAt ?? Date.now() + 1_000) - Date.now())
        : 1_000;
    const timer = setTimeout(() => {
      this.#retryTimers.delete(work.incomingId);
      if (!this.#closed) this.schedule(work, reasoner, "retry", onResolved);
    }, delay);
    timer.unref?.();
    this.#retryTimers.set(work.incomingId, timer);
  }
}
