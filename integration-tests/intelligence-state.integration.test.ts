import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EvidenceAuthority } from "@pi-mentis/pi-mentis-core";
import {
  createMemoryService,
  type PiScopeContext,
  type RelationshipLearningWork,
} from "@pi-mentis/pi-mentis-memory-core";
import { StateRevisionConflictError, ZvecStateStore, ZvecStore } from "@pi-mentis/pi-mentis-zvec";

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
    const startupPending = await memory.listPendingRelationshipLearning?.({ limit: 32 });
    expect(startupPending?.map((work) => work.incomingId)).toContain(reclaimable.id);
    expect(startupPending?.map((work) => work.incomingId)).not.toContain(exhausted.id);
    expect(startupPending?.map((work) => work.incomingId)).not.toContain(retryExhausted.id);
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
