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
  identityEvidence: { referent: "same", attribute: "same", value: "uncertain" } as const,
  explicitNewAssertion: false,
  explicitRetraction: false,
  replacementValuePresent: false,
  compatibleValue: false,
  incompatibleValue: false,
  mutuallyExclusive: false,
};

const sameHints = {
  incomingHints: { subjectHint: "default shell", relationHint: "uses", valueHint: "zsh" },
  targetHints: { subjectHint: "default shell", relationHint: "uses", valueHint: "zsh" },
};

describe("relationship mutation safety", () => {
  it("accepts reinforcement without requiring a new assertion", () => {
    const proposal = {
      relation: "reinforce" as const,
      confidence: 0.95,
      signals: {
        ...signals,
        identityEvidence: { ...signals.identityEvidence, value: "same" as const },
        compatibleValue: true,
      },
      ...sameHints,
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
        identityEvidence: { ...signals.identityEvidence, value: "different" as const },
        explicitNewAssertion: true,
        replacementValuePresent: true,
        incompatibleValue: true,
      },
      incomingHints: { subjectHint: "default port", relationHint: "uses", valueHint: "51842" },
      targetHints: { subjectHint: "default port", relationHint: "uses", valueHint: "46321" },
    };
    expect(supersedeGate(supersede)).toBe(true);
    expect(
      supersedeGate({
        ...supersede,
        incomingHints: {
          subjectHint: "runtime code",
          relationHint: "final runtime code is new-value",
          valueHint: "new-value",
        },
        targetHints: {
          subjectHint: "runtime code",
          relationHint: "current runtime code is old-value",
          valueHint: "old-value",
        },
      }),
    ).toBe(true);
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
      ...sameHints,
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
      signals: {
        ...signals,
        identityEvidence: { ...signals.identityEvidence, value: "different" as const },
        incompatibleValue: true,
        mutuallyExclusive: true,
      },
      ...sameHints,
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
        identityEvidence: { ...signals.identityEvidence, value: "different" as const },
        explicitNewAssertion: true,
        replacementValuePresent: true,
        incompatibleValue: true,
      },
      incomingHints: { subjectHint: "runtime code", relationHint: "uses", valueHint: "new" },
      targetHints: { subjectHint: "runtime code", relationHint: "uses", valueHint: "old" },
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
    expect(await producer.produce("incoming", candidates, reasoner)).toMatchObject({
      relation: "supersede",
      gateAccepted: false,
      gateRejectReasons: ["ambiguous_competing_relationship_targets"],
    });

    const weak: PairwiseRelationshipReasoner = {
      async judge() {
        return {
          ...judgment,
          signals: {
            ...judgment.signals,
            identityEvidence: { ...judgment.signals.identityEvidence, attribute: "different" },
          },
        };
      },
    };
    expect(await producer.produce("incoming", [candidates[0]!], weak)).toMatchObject({
      relation: "supersede",
      gateAccepted: false,
      gateRejectReasons: expect.arrayContaining(["attribute_identity_not_same"]),
    });

    await expect(
      producer.produce("incoming", [candidates[0]!], {
        async judge() {
          throw new Error("pairwise provider timeout");
        },
      }),
    ).rejects.toThrow("pairwise provider timeout");
  });

  it.each([
    ["editor theme", "terminal theme", "same-color"],
    ["service A port", "service B port", "43117"],
    ["project Alpha codename", "project Beta codename", "same-code"],
    ["favorite label", "temporary environment label", "same-label"],
    ["file A checksum", "file B checksum", "same-checksum"],
  ])("rejects same-value reinforcement for different subjects: %s / %s", (left, right, value) => {
    const proposal = {
      relation: "reinforce" as const,
      confidence: 0.99,
      signals: {
        ...signals,
        identityEvidence: { referent: "different", attribute: "same", value: "same" } as const,
        compatibleValue: true,
      },
      incomingHints: { subjectHint: right, relationHint: "value", valueHint: value },
      targetHints: { subjectHint: left, relationHint: "value", valueHint: value },
    };
    expect(reinforceGate(proposal)).toBe(false);
    expect(acceptsRelationshipProposal(proposal)).toBe(false);
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
