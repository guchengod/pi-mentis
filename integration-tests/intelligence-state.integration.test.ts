import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EvidenceAuthority } from "@pi-mentis/pi-mentis-core";
import {
  MemoryCandidateService,
  TaskEpisodeService,
  WorkingMemoryService,
  createExperienceLearningService,
  createMemoryService,
  securityNamespaceForScope,
  type OutcomeStatus,
  type PiEpisode,
  type PiEvent,
  type PiScopeContext,
  type RelationshipLearningWork,
} from "@pi-mentis/pi-mentis-memory-core";
import { StateRevisionConflictError, ZvecStateStore, ZvecStore } from "@pi-mentis/pi-mentis-zvec";
import { AdaptivePolicyService } from "@pi-mentis/pi-mentis-retrieval";

import { DeterministicEmbeddingProvider, embeddingSpace, testStorage } from "./helpers.js";

const roots: string[] = [];

async function temporaryStore(dimensions = 768): Promise<{ root: string; store: ZvecStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-mentis-intelligence-"));
  roots.push(root);
  const store = new ZvecStore(testStorage(root));
  const space = embeddingSpace(dimensions);
  await store.start({ knowledge: space, memory: space, capability: space });
  return { root, store };
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })),
  );
});

const scope: PiScopeContext = {
  tenantId: "tenant",
  userId: "user",
  appId: "pi",
  agentId: "mentis",
  repositoryId: "repo:a",
  projectId: "project:a",
  sessionId: "session:a",
  branchId: "feature",
};

function replacementEvidence(targetId: string, oldValue: string, newValue: string) {
  return {
    relation: "supersede" as const,
    targetIds: [targetId],
    confidence: 0.99,
    reasonCodes: ["explicit_replacement"],
    source: "background_consolidation" as const,
    signals: {
      identityEvidence: { referent: "same", attribute: "same", value: "different" } as const,
      explicitNewAssertion: true,
      explicitRetraction: false,
      replacementValuePresent: true,
      compatibleValue: false,
      incompatibleValue: true,
      mutuallyExclusive: false,
    },
    incomingHints: {
      subjectHint: "temporary service",
      relationHint: "current value",
      valueHint: newValue,
    },
    targetHints: {
      [targetId]: {
        subjectHint: "temporary service",
        relationHint: "current value",
        valueHint: oldValue,
      },
    },
  };
}

describe("V2 intelligence state on real Zvec", () => {
  it("promotes reinforced natural preferences and repeatedly verified procedures into retrievable memory", async () => {
    const { store } = await temporaryStore(64);
    const memory = createMemoryService({
      store,
      embedding: new DeterministicEmbeddingProvider(64),
      embeddingSpace: embeddingSpace(64),
      dimensions: 64,
      viewsEnabled: false,
    });
    const candidates = new MemoryCandidateService(store, memory, {
      autoPromotion: true,
      maxCandidatesPerTurn: 3,
      candidateMaxCharacters: 500,
      candidateTtlMs: 86_400_000,
      minimumPreferenceObservations: 2,
      minimumBehaviorObservations: 3,
    });
    const namespace = securityNamespaceForScope(scope);
    const proposal = (evidenceId: string) => ({
      content: "I usually prefer minimal repairs",
      scopeHint: "user" as const,
      confidence: 0.95,
      durability: 0.9,
      evidenceIds: [evidenceId],
      support: [{ evidenceId, relation: "entailed" as const }],
    });
    const observePreference = (sessionId: string, evidenceId: string) =>
      candidates.observe({
        proposal: proposal(evidenceId),
        source: "user_statement",
        scopeContext: { ...scope, sessionId },
        evidence: [
          {
            id: evidenceId,
            ref: { kind: "event", id: evidenceId, observedAt: Date.now() },
            namespace,
            text: "I usually prefer minimal repairs",
            verified: false,
            sourceKind: "user" as const,
            firstPersonPreferenceEvidence: true,
            allowedScopeCeiling: "user" as const,
            authority: EvidenceAuthority.UserHistoricalStatement,
          },
        ],
        observationId: `preference:${sessionId}`,
      });
    expect((await observePreference("session:a", "preference:a")).outcome).toBe("created");
    expect((await observePreference("session:b", "preference:b")).outcome).toBe("promoted");
    const preferenceRecall = await memory.search({
      text: "minimal repair preference",
      scopes: [{ kind: "user", id: "user" }],
      scopeContext: scope,
      temporalMode: "current",
    });
    expect(preferenceRecall.hits.some((hit) => hit.text.includes("minimal repairs"))).toBe(true);

    const experience = createExperienceLearningService({
      store,
      memory,
      minimumOutcomes: 3,
      minimumSuccessEstimate: 0.7,
    });
    const procedure = await experience.observe({
      version: 2,
      goal: "repair shared writer coordination",
      scopeContext: scope,
      environment: { os: "darwin", runtime: "node" },
      prerequisites: ["shared writer failure"],
      steps: ["inspect writer ownership", "repair lifecycle", "run focused tests"],
      generalizedSteps: [
        "inspect writer ownership",
        "repair writer lifecycle",
        "run focused tests",
      ],
      normalizedProblemCues: ["shared writer coordination failure"],
      rawEpisodeIds: ["episode:1"],
      successCriteria: ["focused shared writer tests pass"],
      applicabilityContext: { repositoryId: "repo:a", runtime: "node" },
      cost: 0,
      durationMs: 1,
      appliesWhen: ["shared writer coordination fails"],
      excludesWhen: [],
      capabilityGaps: [],
      generationContext: ["pi-task-episode-cognition-v1"],
      validationPlan: ["run focused shared writer tests"],
    });
    for (let index = 1; index <= 3; index++) {
      await experience.recordOutcome(procedure.id, {
        outcomeId: `outcome:${index}`,
        taskEpisodeId: `task-episode:${index}`,
        episodeIds: [`episode:${index}`],
        sessionId: `session:${index}`,
        branchId: "feature",
        succeeded: true,
        evidence: { kind: "event", id: `procedure:${index}`, observedAt: index },
        verificationEvidenceIds: [`verification:${index}`],
        cost: 0,
        durationMs: 1,
        environment: { os: "darwin", runtime: "node", repositoryId: "repo:a" },
      });
    }
    await experience.qualify(procedure.id);
    await experience.promote(procedure.id);
    const procedureRecall = await memory.search({
      text: "shared writer coordination failure",
      scopes: [{ kind: "repository", id: "repo:a" }],
      scopeContext: scope,
      temporalMode: "current",
    });
    expect(procedureRecall.hits.some((hit) => hit.text.includes("Procedure:"))).toBe(true);
    await store.close();
  }, 60_000);

  it("persists branch-local working memory and task episodes without crossing security namespaces", async () => {
    const { root, store } = await temporaryStore(64);
    const limits = {
      promptTokens: 220,
      hardMaxTokens: 1_200,
      maxConfirmed: 4,
      maxHypotheses: 3,
      maxOpenLoops: 3,
      maxRecentOutcomes: 4,
      maxActiveResources: 4,
    } as const;
    const partial: OutcomeStatus = {
      executionStatus: "partial",
      verificationStatus: "not_run",
      taskStatus: "partial",
    };
    const makeEpisode = (id: string, goal: string, branchId: string): PiEpisode => ({
      id,
      sessionId: "session:a",
      securityNamespace: securityNamespaceForScope(scope),
      branchId,
      taskId: "task:a",
      topicIds: [],
      goal,
      startedAt: 1_000,
      endedAt: 1_100,
      status: "partial",
      firstSequence: 1,
      lastSequence: 1,
    });
    const makeGoalEvent = (id: string, goal: string): PiEvent => ({
      id,
      episodeId: id,
      securityNamespace: securityNamespaceForScope(scope),
      sequence: 1,
      kind: "goal",
      timestamp: 1_000,
      payload: { goal },
    });
    const working = new WorkingMemoryService(store, limits);
    const tasks = new TaskEpisodeService(store);
    const parentEpisode = makeEpisode("episode:parent", "repair durable context", "feature");
    const parentEvent = makeGoalEvent("event:parent", parentEpisode.goal);
    const parent = await working.applyEpisode({
      scopeContext: scope,
      episode: parentEpisode,
      events: [parentEvent],
      outcome: partial,
      taskId: "task:a",
    });
    await tasks.append({
      taskId: "task:a",
      scopeContext: scope,
      episode: parentEpisode,
      events: [parentEvent],
      outcome: partial,
      workingMemory: parent,
    });
    const childScope = { ...scope, branchId: "child", parentBranchId: "feature" };
    const child = await working.loadOrCreate(childScope, "session:a", "child", "feature");
    expect(child.goal?.text).toBe("repair durable context");
    await working.applyEpisode({
      scopeContext: childScope,
      episode: makeEpisode("episode:child", "continue child-only repair", "child"),
      events: [makeGoalEvent("event:child", "continue child-only repair")],
      outcome: partial,
      taskId: "task:a",
    });
    await store.close();

    const reopened = new ZvecStore(testStorage(root));
    const space = embeddingSpace(64);
    await reopened.start({ knowledge: space, memory: space, capability: space });
    const restoredWorking = new WorkingMemoryService(reopened, limits);
    const restoredTasks = new TaskEpisodeService(reopened);
    expect((await restoredWorking.restore(scope, "session:a", "feature"))?.goal?.text).toBe(
      "repair durable context",
    );
    expect((await restoredWorking.restore(childScope, "session:a", "child"))?.branchId).toBe(
      "child",
    );
    expect(
      await restoredWorking.restore({ ...scope, agentId: "other-agent" }, "session:a", "feature"),
    ).toBeUndefined();
    expect(
      await restoredWorking.restore({ ...scope, appId: "other-app" }, "session:a", "feature"),
    ).toBeUndefined();
    expect(
      await restoredTasks.get(securityNamespaceForScope(scope), "task:a", "feature"),
    ).toMatchObject({ taskId: "task:a", branchId: "feature", episodeIds: ["episode:parent"] });
    expect(
      await restoredTasks.get(
        securityNamespaceForScope({ ...scope, agentId: "other-agent" }),
        "task:a",
        "feature",
      ),
    ).toBeUndefined();
    await reopened.close();
  }, 60_000);

  it("rebases persisted adaptive policy when the configured baseline changes", async () => {
    const { store } = await temporaryStore();
    const namespace = "tenant:user:pi:mentis";
    const original = new AdaptivePolicyService(store, namespace, {
      baselineParameters: { contextTokens: 1_600, rerankCandidateLimit: 40 },
    });
    await original.initialize();
    const originalFingerprint = original.active().baselineFingerprint;

    const upgraded = new AdaptivePolicyService(store, namespace, {
      baselineParameters: { contextTokens: 3_000, rerankCandidateLimit: 60 },
    });
    await upgraded.initialize();

    expect(upgraded.active()).toMatchObject({
      parameters: { contextTokens: 3_000, rerankCandidateLimit: 60 },
      parentId: original.active().id,
      policySchemaVersion: 2,
    });
    expect(upgraded.active().baselineFingerprint).not.toBe(originalFingerprint);
  });

  it("persists revisioned state and rejects stale CAS", async () => {
    const { root, store } = await temporaryStore();
    const state = new ZvecStateStore(store);
    const first = await state.put({
      id: "state:tenant/user:job_1",
      kind: "job",
      namespace: "tenant:user",
      value: { phase: "queued" },
    });
    await expect(
      state.put(
        { id: first.id, kind: first.kind, namespace: first.namespace, value: { phase: "running" } },
        { expectedRevision: 0 },
      ),
    ).rejects.toBeInstanceOf(StateRevisionConflictError);
    await store.close();
    const reopened = new ZvecStore(testStorage(root));
    const space = embeddingSpace();
    await reopened.start({ knowledge: space, memory: space, capability: space });
    expect((await new ZvecStateStore(reopened).get(first.id))?.value).toEqual({ phase: "queued" });
    await reopened.close();
  });

  it("recovers an expired relationship lease and serializes a rapid correction chain", async () => {
    const { root, store } = await temporaryStore(64);
    let now = 1_000;
    const clock = { now: () => now };
    const provider = new DeterministicEmbeddingProvider(64);
    const memory = createMemoryService({
      store,
      embedding: provider,
      embeddingSpace: embeddingSpace(64),
      dimensions: 64,
      viewsEnabled: false,
      clock,
    });
    const base = {
      scope: { kind: "user" as const, id: "user" },
      scopeContext: scope,
      authority: EvidenceAuthority.UserCurrentInstruction,
      provenance: { origin: "user" as const, epistemicState: "asserted" as const },
    };
    const old = await memory.commit({
      ...base,
      content: "temporary service current value is old-a",
    });
    now = 2_000;
    const next = await memory.commit({
      ...base,
      content: "temporary service current value is new-b",
      relationshipCandidates: [{ id: old.record!.id, source: "same_turn_recall" }],
    });
    expect(await memory.getRelationshipLearning?.(next.record!.id)).toMatchObject({
      state: "pending",
      attempts: 0,
    });
    expect(
      await memory.claimRelationshipLearning?.(
        next.record!.id,
        { owner: "worker-before-crash", leaseMs: 1_000, recoveryReason: "normal" },
        { scopeContext: scope },
      ),
    ).toMatchObject({ state: "processing", attempts: 1 });
    await store.close();

    now = 4_000;
    const reopened = new ZvecStore(testStorage(root));
    const space = embeddingSpace(64);
    await reopened.start({ knowledge: space, memory: space, capability: space });
    const recovered = createMemoryService({
      store: reopened,
      embedding: new DeterministicEmbeddingProvider(64),
      embeddingSpace: space,
      dimensions: 64,
      viewsEnabled: false,
      clock,
    });
    expect(
      (await recovered.listRecoverableRelationshipLearning?.({ now, limit: 16 }))?.map(
        (work) => work.incomingId,
      ),
    ).toContain(next.record!.id);
    expect(
      await recovered.claimRelationshipLearning?.(
        next.record!.id,
        { owner: "worker-after-restart", leaseMs: 1_000, recoveryReason: "lease_recovery" },
        { scopeContext: scope },
      ),
    ).toMatchObject({ state: "processing", attempts: 2 });
    const recoveredResult = await recovered.consolidateRelationship?.(
      next.record!.id,
      replacementEvidence(old.record!.id, "old-a", "new-b"),
      { scopeContext: scope },
    );
    expect(recoveredResult).toMatchObject({ action: "applied", relationDecision: "supersede" });
    await recovered.resolveRelationshipLearning?.(
      next.record!.id,
      recoveredResult?.operationKey === undefined ? [] : [recoveredResult.operationKey],
      { scopeContext: scope },
    );
    expect(await recovered.getRelationshipLearning?.(next.record!.id)).toMatchObject({
      state: "resolved",
      attempts: 2,
    });
    expect((await recovered.get(old.record!.id, { scopeContext: scope }))?.status).toBe(
      "superseded",
    );

    now = 5_000;
    const third = await recovered.commit({
      ...base,
      content: "temporary service current value is new-c",
      relationshipCandidates: [{ id: next.record!.id, source: "same_turn_recall" }],
    });
    now = 6_000;
    const latest = await recovered.commit({
      ...base,
      content: "temporary service current value is new-d",
      relationshipCandidates: [{ id: third.record!.id, source: "same_turn_recall" }],
    });
    expect(
      await recovered.claimRelationshipLearning?.(
        latest.record!.id,
        { owner: "late-worker", leaseMs: 1_000, recoveryReason: "normal" },
        { scopeContext: scope },
      ),
    ).toBeUndefined();
    const thirdLease = await recovered.claimRelationshipLearning?.(
      third.record!.id,
      { owner: "ordered-worker", leaseMs: 1_000, recoveryReason: "normal" },
      { scopeContext: scope },
    );
    expect(thirdLease).toMatchObject({ state: "processing" });
    const thirdResult = await recovered.consolidateRelationship?.(
      third.record!.id,
      replacementEvidence(next.record!.id, "new-b", "new-c"),
      { scopeContext: scope },
    );
    await recovered.resolveRelationshipLearning?.(
      third.record!.id,
      thirdResult?.operationKey === undefined ? [] : [thirdResult.operationKey],
      { scopeContext: scope },
    );
    expect(
      await recovered.claimRelationshipLearning?.(
        latest.record!.id,
        { owner: "ordered-worker", leaseMs: 1_000, recoveryReason: "retry" },
        { scopeContext: scope },
      ),
    ).toMatchObject({ state: "processing" });
    const latestResult = await recovered.consolidateRelationship?.(
      latest.record!.id,
      replacementEvidence(third.record!.id, "new-c", "new-d"),
      { scopeContext: scope },
    );
    await recovered.resolveRelationshipLearning?.(
      latest.record!.id,
      latestResult?.operationKey === undefined ? [] : [latestResult.operationKey],
      { scopeContext: scope },
    );
    expect((await recovered.get(latest.record!.id, { scopeContext: scope }))?.status).toBe(
      "active",
    );
    expect((await recovered.get(third.record!.id, { scopeContext: scope }))?.status).toBe(
      "superseded",
    );
    expect((await recovered.get(next.record!.id, { scopeContext: scope }))?.status).toBe(
      "superseded",
    );

    now = 7_000;
    const retryable = await recovered.commit({
      ...base,
      content: "temporary service current value is retry-e",
      relationshipCandidates: [{ id: latest.record!.id, source: "same_turn_recall" }],
    });
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const lease = await recovered.claimRelationshipLearning?.(
        retryable.record!.id,
        { owner: `retry-worker-${attempt}`, leaseMs: 1_000, recoveryReason: "retry" },
        { scopeContext: scope },
      );
      expect(lease?.attempts).toBe(attempt);
      const failed = await recovered.failRelationshipLearning?.(
        retryable.record!.id,
        new Error("pairwise provider timeout"),
        { scopeContext: scope },
      );
      if (attempt < 4) {
        expect(failed?.state).toBe("failed_retryable");
        now = (failed?.nextRetryAt ?? now) + 1;
      } else {
        expect(failed?.state).toBe("failed_terminal");
      }
    }
    expect(
      (
        await recovered.listRecoverableRelationshipLearning?.({ now: now + 60_000, limit: 16 })
      )?.map((work) => work.incomingId),
    ).not.toContain(retryable.record!.id);
    expect((await recovered.get(retryable.record!.id, { scopeContext: scope }))?.status).toBe(
      "active",
    );
    await reopened.close();
  }, 180_000);

  it("terminalizes exhausted leases, settles dependencies, and keeps recovery idempotent", async () => {
    const { store } = await temporaryStore(64);
    let now = 1_000;
    const clock = { now: () => now };
    const memory = createMemoryService({
      store,
      embedding: new DeterministicEmbeddingProvider(64),
      embeddingSpace: embeddingSpace(64),
      dimensions: 64,
      viewsEnabled: false,
      clock,
    });
    const base = {
      scope: { kind: "user" as const, id: "user" },
      scopeContext: scope,
      authority: EvidenceAuthority.UserCurrentInstruction,
      provenance: { origin: "user" as const, epistemicState: "asserted" as const },
    };
    const state = new ZvecStateStore(store);
    const namespace = "tenant:user:pi:mentis::user:user";
    const coexist = {
      relation: "coexist" as const,
      targetIds: [],
      confidence: 1,
      reasonCodes: ["test_setup"],
    };
    const createRecord = async (label: string) =>
      memory.commit({
        ...base,
        content: `relationship liveness ${label}`,
        relationshipEvidence: coexist,
      });
    const reclaimable = (await createRecord("reclaimable")).record!;
    const exhausted = (await createRecord("exhausted")).record!;
    const dependent = (await createRecord("dependent")).record!;
    const live = (await createRecord("live")).record!;
    const blocked = (await createRecord("blocked")).record!;
    const retryExhausted = (await createRecord("retry exhausted")).record!;
    const writeWork = async (
      recordId: string,
      value: Omit<RelationshipLearningWork, "incomingId" | "namespace" | "scopeContext">,
    ) => {
      const id = state.id("memory-relationship-learning-v1", namespace, recordId);
      await state.put(
        {
          id,
          kind: "memory-relationship-learning-v1",
          namespace,
          value: { ...value, incomingId: recordId, namespace, scopeContext: scope },
        },
        { status: value.state, now },
      );
      return id;
    };
    const processing = (
      attempts: number,
    ): Omit<RelationshipLearningWork, "incomingId" | "namespace" | "scopeContext"> => ({
      state: "processing",
      candidates: [],
      attempts,
      maxAttempts: 4,
      updatedAt: now - 2_000,
      processingOwner: "crashed-worker",
      processingStartedAt: now - 2_000,
      leaseExpiresAt: now - 1,
      operationKeys: [],
    });
    await writeWork(reclaimable.id, processing(3));
    await writeWork(exhausted.id, processing(4));
    await writeWork(dependent.id, {
      state: "pending",
      candidates: [{ id: exhausted.id, source: "same_turn_recall" }],
      attempts: 0,
      maxAttempts: 4,
      updatedAt: now,
      operationKeys: [],
    });
    await writeWork(live.id, { ...processing(1), leaseExpiresAt: now + 10_000 });
    await writeWork(blocked.id, {
      state: "pending",
      candidates: [{ id: live.id, source: "same_turn_recall" }],
      attempts: 0,
      maxAttempts: 4,
      updatedAt: now,
      operationKeys: [],
    });
    const retryStateId = await writeWork(retryExhausted.id, {
      state: "failed_retryable",
      candidates: [],
      attempts: 4,
      maxAttempts: 4,
      updatedAt: now - 2_000,
      nextRetryAt: now - 1,
      lastError: "pairwise provider timeout",
      operationKeys: [],
    });
    const crossScope = { ...scope, agentId: "other-agent" };
    const crossNamespace = "tenant:user:pi:other-agent::user:user";
    await state.put(
      {
        id: state.id("memory-relationship-learning-v1", crossNamespace, "cross-agent-work"),
        kind: "memory-relationship-learning-v1",
        namespace: crossNamespace,
        value: {
          incomingId: "cross-agent-work",
          namespace: crossNamespace,
          scopeContext: crossScope,
          state: "pending",
          candidates: [],
          attempts: 0,
          maxAttempts: 4,
          updatedAt: now,
          operationKeys: [],
        },
      },
      { status: "pending", now },
    );
    expect(
      await state.list<RelationshipLearningWork>({
        kind: "memory-relationship-learning-v1",
        status: "processing",
      }),
    ).toHaveLength(3);

    const recoverable = await memory.listRecoverableRelationshipLearning?.({ now, limit: 32 });
    expect(recoverable?.map((work) => work.incomingId)).toContain(reclaimable.id);
    expect(recoverable?.map((work) => work.incomingId)).not.toContain(exhausted.id);
    expect(recoverable?.map((work) => work.incomingId)).not.toContain(retryExhausted.id);
    const startupPending = await memory.listPendingRelationshipLearning?.({
      limit: 32,
      scopeContext: scope,
    });
    expect(startupPending?.map((work) => work.incomingId)).toContain(reclaimable.id);
    expect(startupPending?.map((work) => work.incomingId)).not.toContain(exhausted.id);
    expect(startupPending?.map((work) => work.incomingId)).not.toContain(retryExhausted.id);
    expect(startupPending?.map((work) => work.incomingId)).not.toContain("cross-agent-work");
    expect(await memory.getRelationshipLearning?.(exhausted.id)).toMatchObject({
      state: "failed_terminal",
      attempts: 4,
      lastError: "lease_expired_after_max_attempts",
    });
    expect(await memory.getRelationshipLearning?.(retryExhausted.id)).toMatchObject({
      state: "failed_terminal",
      attempts: 4,
      lastError: "retry_exhausted",
    });
    expect(
      await memory.claimRelationshipLearning?.(
        reclaimable.id,
        { owner: "reclaimable-recovered", leaseMs: 1_000, recoveryReason: "lease_recovery" },
        { scopeContext: scope },
      ),
    ).toMatchObject({ state: "processing", attempts: 4 });
    expect(
      await memory.claimRelationshipLearning?.(
        dependent.id,
        { owner: "dependent", leaseMs: 1_000, recoveryReason: "normal" },
        { scopeContext: scope },
      ),
    ).toMatchObject({ state: "processing", attempts: 1 });
    await expect(
      memory.claimRelationshipLearning?.(
        blocked.id,
        { owner: "blocked", leaseMs: 1_000, recoveryReason: "normal" },
        { scopeContext: scope },
      ),
    ).resolves.toBeUndefined();

    const terminal = await state.get<RelationshipLearningWork>(retryStateId);
    const revision = terminal!.revision;
    await memory.listRecoverableRelationshipLearning?.({ now: now + 60_000, limit: 32 });
    expect((await state.get(retryStateId))?.revision).toBe(revision);
    await store.close();
  }, 180_000);

  it("persists relationship evolution, exact ID reads, views and current recall across restart", async () => {
    const { root, store } = await temporaryStore();
    const provider = new DeterministicEmbeddingProvider();
    const memory = createMemoryService({
      store,
      embedding: provider,
      embeddingSpace: embeddingSpace(),
      dimensions: 768,
    });
    const base = {
      scope: { kind: "project" as const, id: "project:a" },
      scopeContext: scope,
      authority: EvidenceAuthority.UserCurrentInstruction,
      provenance: {
        origin: "user" as const,
        epistemicState: "asserted" as const,
        branchId: "feature",
      },
    };
    const first = await memory.commit({
      ...base,
      content: "默认端口 46321。",
      idempotencyKey: "port:1",
    });
    const duplicate = await memory.commit({
      ...base,
      content: "默认端口 46321。",
      idempotencyKey: "port:1",
    });
    expect(duplicate).toEqual(first);
    const second = await memory.commit({
      ...base,
      content: "改成 51842。",
      idempotencyKey: "port:2",
      relationshipEvidence: {
        relation: "supersede",
        targetIds: [first.record!.id],
        confidence: 1,
        reasonCodes: ["explicit_current_correction", "same_referent"],
      },
    });
    expect(second).toMatchObject({ outcome: "superseded", relationDecision: "supersede" });
    expect(
      (await memory.get(first.record!.id, { scopeContext: scope, accessIntent: "explicit_id" }))
        ?.status,
    ).toBe("superseded");
    await memory.flushBackground?.();
    expect((await memory.getView?.("project", "project:a", scope))?.memberMemoryIds).toContain(
      second.record!.id,
    );
    await store.close();

    const reopened = new ZvecStore(testStorage(root));
    const space = embeddingSpace();
    await reopened.start({ knowledge: space, memory: space, capability: space });
    const restored = createMemoryService({
      store: reopened,
      embedding: new DeterministicEmbeddingProvider(),
      embeddingSpace: space,
      dimensions: 768,
    });
    expect(
      (await restored.get(second.record!.id, { scopeContext: scope, accessIntent: "explicit_id" }))
        ?.content,
    ).toContain("51842");
    const current = await restored.search({
      text: "默认端口",
      scopes: [base.scope],
      scopeContext: scope,
      temporalMode: "current",
    });
    expect(current.hits.map((hit) => hit.id)).toContain(second.record!.id);
    expect(current.hits.map((hit) => hit.id)).not.toContain(first.record!.id);
    await reopened.close();
  }, 60_000);

  it("steer abandons only branch-local hypotheses", async () => {
    const { store } = await temporaryStore();
    const memory = createMemoryService({
      store,
      embedding: new DeterministicEmbeddingProvider(),
      embeddingSpace: embeddingSpace(),
      dimensions: 768,
      viewsEnabled: false,
    });
    const base = { scope: { kind: "user" as const, id: "user" }, scopeContext: scope };
    const asserted = await memory.commit({
      ...base,
      content: "我的测试代号是 Orion。",
      authority: EvidenceAuthority.UserCurrentInstruction,
      provenance: { origin: "user", epistemicState: "asserted", branchId: "feature" },
    });
    const hypothesis = await memory.commit({
      ...base,
      content: "也许测试代号是 Nova。",
      authority: EvidenceAuthority.AssistantInference,
      provenance: {
        origin: "model",
        epistemicState: "hypothesis",
        branchId: "feature",
        branchLocal: true,
      },
    });
    expect(await memory.abandonBranch?.("feature", scope)).toBe(1);
    expect((await memory.get(asserted.record!.id, { scopeContext: scope }))?.status).toBe("active");
    expect((await memory.get(hypothesis.record!.id, { scopeContext: scope }))?.status).toBe(
      "rejected",
    );
    await store.close();
  }, 60_000);
});
