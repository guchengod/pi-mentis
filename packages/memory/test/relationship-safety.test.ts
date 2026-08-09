import { describe, expect, it } from "vitest";

import {
  CurrentTurnMemoryEvidence,
  RelationshipEvidenceProducer,
  acceptsRelationshipProposal,
  conflictGate,
  reinforceGate,
  retractGate,
  supersedeGate,
  type PairwiseRelationshipJudgment,
  type PairwiseRelationshipReasoner,
} from "../src/index.js";

const signals = {
  sameReferent: true,
  sameAttribute: true,
  explicitNewAssertion: false,
  explicitRetraction: false,
  replacementValuePresent: false,
  compatibleValue: false,
  incompatibleValue: false,
};

describe("relationship mutation safety", () => {
  it("accepts reinforcement without requiring a new assertion", () => {
    const proposal = {
      relation: "reinforce" as const,
      confidence: 0.95,
      signals: { ...signals, compatibleValue: true },
    };
    expect(reinforceGate(proposal)).toBe(true);
    expect(acceptsRelationshipProposal(proposal)).toBe(true);
    expect(
      reinforceGate({
        ...proposal,
        signals: { ...proposal.signals, explicitRetraction: true },
      }),
    ).toBe(false);
  });

  it("requires relation-specific destructive evidence", () => {
    const supersede = {
      relation: "supersede" as const,
      confidence: 0.96,
      signals: {
        ...signals,
        explicitNewAssertion: true,
        replacementValuePresent: true,
        incompatibleValue: true,
      },
    };
    expect(supersedeGate(supersede)).toBe(true);
    expect(
      supersedeGate({
        ...supersede,
        signals: { ...supersede.signals, replacementValuePresent: false },
      }),
    ).toBe(false);

    const retract = {
      relation: "retract" as const,
      confidence: 0.97,
      signals: { ...signals, explicitRetraction: true },
    };
    expect(retractGate(retract)).toBe(true);
    expect(
      retractGate({
        ...retract,
        signals: { ...retract.signals, replacementValuePresent: true },
      }),
    ).toBe(false);

    const conflict = {
      relation: "conflict" as const,
      confidence: 0.98,
      signals: { ...signals, incompatibleValue: true },
    };
    expect(conflictGate(conflict)).toBe(true);
    expect(
      conflictGate({
        ...conflict,
        signals: { ...conflict.signals, explicitNewAssertion: true },
      }),
    ).toBe(false);
  });

  it("rejects ambiguous pairwise targets and structurally weak proposals", async () => {
    const producer = new RelationshipEvidenceProducer();
    const judgment: PairwiseRelationshipJudgment = {
      relation: "supersede",
      confidence: 0.97,
      signals: {
        ...signals,
        explicitNewAssertion: true,
        replacementValuePresent: true,
        incompatibleValue: true,
      },
      reasonCodes: ["same_subject_attribute"],
    };
    const reasoner: PairwiseRelationshipReasoner = {
      async judge() {
        return judgment;
      },
    };
    const candidates = ["a", "b"].map((id) => ({
      id,
      content: `candidate ${id}`,
      status: "current" as const,
      match: "semantic" as const,
    }));

    expect(
      await producer.produce(
        "incoming",
        [{ ...candidates[0]!, evidenceSource: "semantic_candidate" }],
        reasoner,
      ),
    ).toMatchObject({ relation: "supersede", targetIds: ["a"] });
    expect(await producer.produce("incoming", candidates, reasoner)).toBeUndefined();

    const weak: PairwiseRelationshipReasoner = {
      async judge() {
        return { ...judgment, signals: { ...judgment.signals, sameAttribute: false } };
      },
    };
    expect(await producer.produce("incoming", [candidates[0]!], weak)).toBeUndefined();
  });

  it("keeps relationship candidates turn-local and current-only", () => {
    const turn = new CurrentTurnMemoryEvidence();
    turn.beginTurn();
    turn.recordRecall([
      { id: "current", content: "current", status: "current", match: "semantic" },
      { id: "old", content: "old", status: "historical", match: "anchored" },
    ]);
    expect(turn.snapshot().map((item) => item.id)).toEqual(["current"]);
    turn.beginTurn();
    expect(turn.snapshot()).toEqual([]);
  });
});
