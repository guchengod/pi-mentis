import type {
  MemoryRelationship,
  MemoryRelationshipEvidence,
  MemorySemanticHints,
  PairwiseRelationshipSignals,
} from "./types.js";

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
}

export function reinforceGate(proposal: RelationshipProposal): boolean {
  const { confidence, signals } = proposal;
  return (
    proposal.relation === "reinforce" &&
    signals !== undefined &&
    confidence >= 0.9 &&
    signals.sameReferent &&
    signals.sameAttribute &&
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
    confidence >= 0.92 &&
    signals.sameReferent &&
    signals.sameAttribute &&
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
    confidence >= 0.94 &&
    signals.sameReferent &&
    signals.sameAttribute &&
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
    confidence >= 0.95 &&
    signals.sameReferent &&
    signals.sameAttribute &&
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
    const acceptedJudgments = judgments
      .flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
      .filter(({ judgment }) => acceptsRelationshipProposal(judgment))
      .sort((left, right) => right.judgment.confidence - left.judgment.confidence);
    const strongest = acceptedJudgments[0];
    if (strongest === undefined) return undefined;
    const runnerUp = acceptedJudgments[1];
    if (
      runnerUp !== undefined &&
      runnerUp.judgment.confidence >= strongest.judgment.confidence - 0.03
    ) {
      return undefined;
    }
    const targetHints =
      strongest.judgment.targetHints === undefined
        ? undefined
        : { [strongest.candidate.id]: strongest.judgment.targetHints };
    const candidateReason =
      strongest.candidate.evidenceSource === "semantic_candidate"
        ? "semantic_candidate_pairwise_review"
        : "same_turn_recalled_target";
    return {
      relation: strongest.judgment.relation as MemoryRelationshipEvidence["relation"],
      targetIds: [strongest.candidate.id],
      confidence: strongest.judgment.confidence,
      reasonCodes: [
        "pairwise_memory_reasoning",
        candidateReason,
        ...strongest.judgment.reasonCodes,
      ],
      source: "background_consolidation",
      signals: strongest.judgment.signals,
      ...(strongest.judgment.incomingHints === undefined
        ? {}
        : { incomingHints: strongest.judgment.incomingHints }),
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
  ): Promise<import("./types.js").RelationshipConsolidationResult | undefined> {
    if (this.#memory.consolidateRelationship === undefined || recalled.length === 0) {
      return undefined;
    }
    const incoming = await this.#memory.get(incomingId, {
      scopeContext,
      accessIntent: "explicit_id",
    });
    if (incoming === undefined || incoming.status !== "active") return undefined;
    const fresh: RecalledMemoryEvidence[] = [];
    for (const candidate of recalled) {
      if (candidate.id === incomingId) continue;
      const record = await this.#memory.get(candidate.id, {
        scopeContext,
        accessIntent: "explicit_id",
      });
      if (record?.status !== "active") continue;
      fresh.push({ ...candidate, content: record.content, status: "current" });
    }
    const evidence = await this.#producer.produce(incoming.content, fresh, reasoner);
    if (evidence === undefined) return undefined;
    return this.#memory.consolidateRelationship(incomingId, evidence, { scopeContext });
  }
}
