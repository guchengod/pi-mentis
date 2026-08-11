import { describe, expect, it } from "vitest";

import {
  CurrentTurnMemoryEvidence,
  DeferredRelationshipLearningScheduler,
  MentisBackgroundQueue,
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
  it("bounds shutdown without starting queued durable work", async () => {
    const queue = new MentisBackgroundQueue({ maxConcurrency: 1 });
    let releaseRunning!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const running = new Promise<void>((resolve) => {
      releaseRunning = resolve;
    });
    queue.enqueue({
      kind: "memory.consolidate",
      execute: async () => {
        markStarted();
        await running;
      },
    });
    await started;
    let queuedRan = false;
    queue.enqueue({
      kind: "memory.consolidate",
      execute: async () => {
        queuedRan = true;
      },
    });

    const drained = await queue.drain({ timeoutMs: 10, cancelPending: true });
    expect(drained).toBe(false);
    expect(queuedRan).toBe(false);
    expect(queue.pendingCount).toBe(0);

    releaseRunning();
  });

  it("starts relationship work without waiting for agent_settled", async () => {
    const scheduled: string[] = [];
    const target = {
      schedule(work: { readonly incomingId: string }) {
        scheduled.push(work.incomingId);
      },
      async recover() {
        return 0;
      },
    };
    const deferred = new DeferredRelationshipLearningScheduler(target, { delayMs: 0 });
    const work = {
      incomingId: "new-memory",
      namespace: "local:local:pi:pi-mentis",
      state: "pending" as const,
      candidates: [],
      scopeContext: {
        tenantId: "local",
        userId: "local",
        appId: "pi",
        agentId: "pi-mentis",
      },
      attempts: 0,
      maxAttempts: 3,
      updatedAt: 1,
      operationKeys: [],
    };
    const reasoner: PairwiseRelationshipReasoner = {
      async judge() {
        throw new Error("not used");
      },
    };

    deferred.schedule(work, reasoner);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(scheduled).toEqual(["new-memory"]);
    deferred.close();
  });

  it("runs startup recovery without a user turn", async () => {
    let recoveries = 0;
    const target = {
      schedule() {},
      async recover() {
        recoveries += 1;
        return 0;
      },
    };
    const deferred = new DeferredRelationshipLearningScheduler(target, { delayMs: 0 });
    const reasoner: PairwiseRelationshipReasoner = {
      async judge() {
        throw new Error("not used");
      },
    };

    deferred.recover(reasoner);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(recoveries).toBe(1);
    deferred.close();
  });

  it("prioritizes fresh work while giving backlog bounded service", async () => {
    const queue = new MentisBackgroundQueue({
      maxConcurrency: 1,
      maxQueueLength: 32,
      freshBurstLimit: 4,
    });
    const order: string[] = [];
    let releaseBlocker!: () => void;
    let blockerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      blockerStarted = resolve;
    });
    const blocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    queue.enqueue({
      kind: "memory.consolidate",
      execute: async () => {
        blockerStarted();
        await blocker;
      },
    });
    await started;

    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const enqueue = (id: string, priority: "fresh" | "normal") => {
      queue.enqueue({
        kind: "memory.consolidate",
        priority,
        execute: async () => {
          order.push(id);
          if (order.length === 7) complete();
        },
      });
    };
    enqueue("backlog-1", "normal");
    enqueue("backlog-2", "normal");
    for (let index = 1; index <= 5; index += 1) enqueue(`fresh-${index}`, "fresh");

    releaseBlocker();
    await completed;
    expect(order).toEqual([
      "fresh-1",
      "fresh-2",
      "fresh-3",
      "fresh-4",
      "backlog-1",
      "fresh-5",
      "backlog-2",
    ]);
  });

  it("does not let work that cannot claim block a later ready item", async () => {
    const queue = new MentisBackgroundQueue({ maxConcurrency: 1 });
    const order: string[] = [];
    let releaseBlocker!: () => void;
    let blockerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      blockerStarted = resolve;
    });
    const blocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let readyFinished!: () => void;
    const ready = new Promise<void>((resolve) => {
      readyFinished = resolve;
    });
    queue.enqueue({
      kind: "memory.consolidate",
      execute: async () => {
        blockerStarted();
        await blocker;
      },
    });
    await started;
    for (const id of ["blocked-1", "blocked-2"]) {
      queue.enqueue({
        kind: "memory.consolidate",
        execute: async () => {
          // A durable claim can legitimately return no work while an active
          // dependency is still unresolved. It must release the queue slot.
          order.push(id);
        },
      });
    }
    queue.enqueue({
      kind: "memory.consolidate",
      execute: async () => {
        order.push("ready");
        readyFinished();
      },
    });

    releaseBlocker();
    await ready;
    expect(order).toEqual(["blocked-1", "blocked-2", "ready"]);
  });

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
