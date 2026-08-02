import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";

import { EvidenceAuthority, type Clock, type SearchHit } from "@pi-mentis/pi-mentis-core";
import {
  TemporalTruthEngine,
  createMemoryService,
  createTaskGraphService,
  type PiScopeContext,
} from "@pi-mentis/pi-mentis-memory-core";
import {
  AdaptivePolicyService,
  EffectivenessService,
  evaluateReplayCandidate,
} from "@pi-mentis/pi-mentis-retrieval";
import { StateRevisionConflictError, ZvecStateStore, ZvecStore } from "@pi-mentis/pi-mentis-zvec";

import { DeterministicEmbeddingProvider, embeddingSpace, testStorage } from "./helpers.js";

const roots: string[] = [];

class VirtualClock implements Clock {
  constructor(private value = Date.UTC(2026, 0, 1)) {}
  now(): number {
    return this.value;
  }
  advance(milliseconds: number): void {
    this.value += milliseconds;
  }
}

async function temporaryStore(): Promise<{ root: string; store: ZvecStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-mentis-intelligence-"));
  roots.push(root);
  const store = new ZvecStore(testStorage(root));
  const space = embeddingSpace();
  await store.start({ knowledge: space, memory: space, capability: space });
  return { root, store };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const scope: PiScopeContext = {
  tenantId: "tenant",
  userId: "user",
  appId: "pi",
  agentId: "mentis",
  repositoryId: "repo:a",
  projectId: "project:a",
  sessionId: "session:a",
  branchId: "main",
};

describe("P8-P13 real-Zvec invariant runtime", () => {
  it("persists revisioned state with rich logical ids and rejects stale CAS", async () => {
    const { root, store } = await temporaryStore();
    const state = new ZvecStateStore(store);
    const first = await state.put({
      id: "state:tenant/user:job_1",
      kind: "job",
      namespace: "tenant:user",
      value: { phase: "queued" },
    });
    expect(first.revision).toBe(1);
    await expect(
      state.put(
        {
          id: first.id,
          kind: first.kind,
          namespace: first.namespace,
          value: { phase: "running" },
        },
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

  it("single-flights concurrent first opens of the same Zvec collection", async () => {
    const { store } = await temporaryStore();
    const now = Date.UTC(2026, 0, 1);
    await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        store.upsertScalar("events_v1", [
          {
            id: `concurrent:event:${index}`,
            kind: "event",
            namespace: "tenant:user:pi:mentis",
            status: "completed",
            payload: { id: `concurrent:event:${index}`, index },
            createdAt: now,
            updatedAt: now,
          },
        ]),
      ),
    );
    const records = await store.filterScalar("events_v1", "kind = 'event'", 64);
    expect(records).toHaveLength(32);
    await store.close();
  });

  it("preserves one current temporal head, history, conflicts, branch isolation, and repair", async () => {
    const { store } = await temporaryStore();
    const clock = new VirtualClock();
    const temporal = new TemporalTruthEngine(store, clock);
    const memoryScope = { kind: "project" as const, id: "project:a" };
    const prepare = (input: {
      id: string;
      hash: string;
      observedAt: number;
      authority: (typeof EvidenceAuthority)[keyof typeof EvidenceAuthority];
      branchClaimState?: "hypothesis" | "abandoned";
      retractsFact?: boolean;
    }) =>
      temporal.prepare({
        factKey: "package_manager",
        cardinality: "single",
        scope: memoryScope,
        scopeContext: scope,
        memoryId: input.id,
        contentHash: input.hash,
        authority: input.authority,
        observedAt: input.observedAt,
        ...(input.branchClaimState === undefined
          ? {}
          : { branchClaimState: input.branchClaimState }),
        ...(input.retractsFact === undefined ? {} : { retractsFact: input.retractsFact }),
      });

    const initial = await prepare({
      id: "memory:npm",
      hash: "npm",
      observedAt: 100,
      authority: EvidenceAuthority.WorkspaceCurrent,
    });
    expect(initial.decision).toBe("create");
    await temporal.apply(initial);
    const newer = await prepare({
      id: "memory:pnpm",
      hash: "pnpm",
      observedAt: 200,
      authority: EvidenceAuthority.WorkspaceCurrent,
    });
    expect(newer.decision).toBe("supersede");
    await temporal.apply(newer);
    const historical = await prepare({
      id: "memory:yarn-old",
      hash: "yarn",
      observedAt: 50,
      authority: EvidenceAuthority.WorkspaceCurrent,
    });
    expect(historical.decision).toBe("historical");
    await temporal.apply(historical);
    expect((await temporal.head("package_manager", memoryScope, scope))?.currentClaims).toEqual([
      expect.objectContaining({ memoryId: "memory:pnpm" }),
    ]);

    const conflict = await prepare({
      id: "memory:bun",
      hash: "bun",
      observedAt: 300,
      authority: EvidenceAuthority.UserKnowledge,
    });
    expect(conflict.decision).toBe("conflict");
    await temporal.apply(conflict);
    expect(await temporal.head("package_manager", memoryScope, scope)).toMatchObject({
      state: "conflicted",
      currentClaims: [
        expect.objectContaining({ memoryId: "memory:pnpm" }),
        expect.objectContaining({ memoryId: "memory:bun" }),
      ],
    });

    const hypothesis = await prepare({
      id: "memory:branch",
      hash: "branch",
      observedAt: 400,
      authority: EvidenceAuthority.UserCurrentInstruction,
      branchClaimState: "hypothesis",
    });
    expect(hypothesis).toMatchObject({ decision: "pending", temporalState: "pending" });
    await temporal.apply(hypothesis);
    expect(
      (await temporal.head("package_manager", memoryScope, scope))?.currentClaims,
    ).toHaveLength(2);

    const interrupted = await temporal.prepare({
      factKey: "node_version",
      cardinality: "single",
      scope: memoryScope,
      scopeContext: scope,
      memoryId: "memory:node26",
      contentHash: "node26",
      authority: EvidenceAuthority.WorkspaceCurrent,
      observedAt: 500,
    });
    await temporal.claimWritten(interrupted);
    expect(await temporal.repair(async (plan) => plan.claim.memoryId === "memory:node26")).toEqual({
      inspected: expect.any(Number),
      repaired: 1,
      failed: 0,
    });
    expect(await temporal.head("node_version", memoryScope, scope)).toMatchObject({
      state: "resolved",
      currentClaims: [expect.objectContaining({ memoryId: "memory:node26" })],
    });
    await store.close();
  });

  it("maintains temporal invariants for arbitrary event orderings", async () => {
    const { store } = await temporaryStore();
    let caseIndex = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            value: fc.constantFrom("npm", "pnpm", "yarn", "bun"),
            observedAt: fc.integer({ min: 1, max: 1_000 }),
            authority: fc.constantFrom(
              EvidenceAuthority.AssistantInference,
              EvidenceAuthority.VerifiedToolObservation,
              EvidenceAuthority.WorkspaceCurrent,
            ),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        async (events) => {
          const engine = new TemporalTruthEngine(store, new VirtualClock());
          const project = { kind: "project" as const, id: `property:${caseIndex++}` };
          let previousRevision = 0;
          const known = new Set<string>();
          for (const [index, event] of events.entries()) {
            const id = `memory:${project.id}:${index}`;
            known.add(id);
            const plan = await engine.prepare({
              factKey: "package_manager",
              cardinality: "single",
              scope: project,
              scopeContext: scope,
              memoryId: id,
              contentHash: event.value,
              authority: event.authority,
              observedAt: event.observedAt,
            });
            await engine.apply(plan);
            const head = await engine.head("package_manager", project, scope);
            expect(head).toBeDefined();
            expect(head?.revision).toBeGreaterThanOrEqual(previousRevision);
            previousRevision = head?.revision ?? previousRevision;
            expect(head?.currentClaims.every((claim) => known.has(claim.memoryId))).toBe(true);
            if (head?.state === "resolved")
              expect(head.currentClaims.length).toBeLessThanOrEqual(1);
            if ((head?.currentClaims.length ?? 0) > 1) expect(head?.state).toBe("conflicted");
          }
        },
      ),
      { numRuns: 30 },
    );
    await store.close();
  });

  it("applies idempotent memory evolution and builds evidence-backed views across restart", async () => {
    const { root, store } = await temporaryStore();
    const clock = new VirtualClock();
    const provider = new DeterministicEmbeddingProvider();
    const memory = createMemoryService({
      store,
      embedding: provider,
      embeddingSpace: embeddingSpace(),
      dimensions: 768,
      clock,
      viewTtlMs: 100,
    });
    await store.upsertScalar("events_v1", [
      {
        id: "event:package-json",
        kind: "event",
        namespace: "tenant:user:pi:mentis",
        status: "completed",
        payload: {
          id: "event:package-json",
          securityNamespace: "tenant:user:pi:mentis",
          payload: { path: "package.json" },
        },
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    ]);
    const base = {
      type: "fact" as const,
      domain: "project" as const,
      scope: { kind: "project" as const, id: "project:a" },
      scopeContext: scope,
      confidence: 0.9,
      importance: 0.8,
      authority: EvidenceAuthority.WorkspaceCurrent,
      evidenceRefs: [{ kind: "tool" as const, id: "event:package-json", observedAt: clock.now() }],
      factKey: "package_manager",
      cardinality: "single" as const,
      contentOrigin: "workspace" as const,
    };
    const first = await memory.commit({ ...base, content: "npm", idempotencyKey: "commit:1" });
    const duplicate = await memory.commit({ ...base, content: "npm", idempotencyKey: "commit:1" });
    expect(duplicate).toEqual(first);
    expect(provider.calls).toBe(1);
    clock.advance(1_000);
    const second = await memory.commit({ ...base, content: "pnpm", idempotencyKey: "commit:2" });
    expect(second.outcome).toBe("superseded");
    await memory.flushBackground?.();
    const view = await memory.getView?.("project", "project:a", scope);
    expect(view?.facts["package_manager"]).toMatchObject({
      value: "pnpm",
      currentMemoryIds: [second.record.id],
      historicalMemoryIds: expect.arrayContaining([first.record.id]),
    });
    const current = await memory.search({
      text: "package manager",
      scopes: [base.scope],
      scopeContext: scope,
      temporalMode: "current",
    });
    expect(current.hits.some((hit) => hit.id === first.record.id)).toBe(false);
    const historical = await memory.search({
      text: "npm",
      scopes: [base.scope],
      scopeContext: scope,
      temporalMode: "historical",
    });
    expect(historical.hits.some((hit) => hit.id === first.record.id)).toBe(true);
    await memory.flushBackground?.();
    await store.close();

    const reopened = new ZvecStore(testStorage(root));
    const space = embeddingSpace();
    await reopened.start({ knowledge: space, memory: space, capability: space });
    const restored = createMemoryService({
      store: reopened,
      embedding: new DeterministicEmbeddingProvider(),
      embeddingSpace: space,
      dimensions: 768,
      clock,
    });
    expect(await restored.temporalHead?.("package_manager", base.scope, scope)).toMatchObject({
      state: "resolved",
      currentClaims: [expect.objectContaining({ memoryId: second.record.id })],
    });
    await reopened.close();
  });

  it("enforces task dependencies, legal transitions, cycle detection, and branch abort", async () => {
    const { store } = await temporaryStore();
    const graph = createTaskGraphService(store);
    const build = await graph.create({ namespace: "tenant:user", goal: "build", id: "task:build" });
    const test = await graph.create({
      namespace: "tenant:user",
      goal: "test",
      id: "task:test",
      dependencies: [build.id],
      branchId: "experiment",
    });
    await expect(graph.transition(test.id, "running")).rejects.toThrow("unfinished dependencies");
    await graph.transition(build.id, "running");
    await graph.transition(build.id, "succeeded", [
      { kind: "event", id: "verification:build", observedAt: 1 },
    ]);
    await graph.transition(test.id, "running");
    await expect(graph.transition(test.id, "pending")).rejects.toThrow("Illegal task transition");
    const deploy = await graph.create({
      namespace: "tenant:user",
      goal: "deploy",
      id: "task:deploy",
      dependencies: [test.id],
    });
    await expect(graph.addDependency(build.id, deploy.id)).rejects.toThrow("cycle detected");
    expect(await graph.abortBranch("experiment", "tenant:user")).toBe(1);
    expect(await graph.get(test.id)).toMatchObject({ state: "aborted" });
    expect(await graph.mermaid("tenant:user")).toContain("graph TD");
    await store.close();
  });

  it("buffers effectiveness traces off the foreground path and assigns causal credit", async () => {
    const { store } = await temporaryStore();
    const service = new EffectivenessService(store, { flushIntervalMs: 60_000, maxBatch: 64 });
    const hit = (id: string): SearchHit => ({
      id,
      kind: "memory",
      text: `memory ${id}`,
      score: 1,
      tokenCount: 10,
      authority: EvidenceAuthority.VerifiedToolObservation,
      namespace: "tenant:user:pi:mentis",
      contentHash: id,
    });
    const started = performance.now();
    const trace = service.recordRetrieval({
      namespace: "tenant:user:pi:mentis",
      traceId: "trace:causal",
      query: "build",
      hits: [hit("used"), hit("exposed")],
      durationMs: 12,
      stages: { gate: 1 },
      policyId: "policy:default",
    });
    expect(performance.now() - started).toBeLessThan(20);
    expect(service.bufferStatus()).toMatchObject({ buffered: 1, flushing: false });
    await service.recordOutcome("tenant:user:pi:mentis", {
      traceId: trace.traceId,
      execution: "success",
      verification: "passed",
      toolArgumentMemoryIds: ["used"],
      evidenceIds: ["verification:1"],
    });
    const used = await service.utility("tenant:user:pi:mentis", "used");
    const exposed = await service.utility("tenant:user:pi:mentis", "exposed");
    expect(used?.utility).toBeGreaterThan(exposed?.utility ?? 1);
    expect(used?.confidence).toBeLessThan(0.1);
    expect(
      service.diagnose({
        recall: 0.9,
        useRate: 0.1,
        failureRate: 0.3,
        correctionRate: 0.2,
        projectMismatchRate: 0.01,
        rerankGain: 0,
        viewUseRate: 0.8,
      }),
    ).toHaveLength(5);
    await service.close();
    await store.close();
  });

  it("protects policy invariants through shadow, canary, rollback, cooldown, and restart", async () => {
    const { root, store } = await temporaryStore();
    const clock = new VirtualClock();
    const policy = new AdaptivePolicyService(store, "tenant:user:pi:mentis", {
      clock,
      cooldownMs: 1_000,
    });
    await policy.initialize();
    await expect(policy.createCandidate({ topK: 10, contextTokens: 2_000 })).rejects.toThrow(
      "exactly one parameter",
    );
    const shadow = await policy.createCandidate({ topK: 22 }, "shadow");
    const replayCase = {
      id: "case:1",
      positiveMemoryIds: ["required"],
      negativeMemoryIds: ["forbidden"],
      requiredEvidenceIds: [],
      candidateFeatures: [
        {
          id: "required",
          kind: "memory" as const,
          score: 1,
          tokenCount: 10,
          authority: 80,
          termHashes: ["required"],
        },
        {
          id: "forbidden",
          kind: "memory" as const,
          score: 2,
          tokenCount: 10,
          authority: 0,
          termHashes: ["forbidden"],
        },
      ],
    };
    expect(await policy.replay(shadow, [replayCase], evaluateReplayCandidate)).toMatchObject({
      recall: 1,
      forbiddenExposure: 0,
    });
    const canary = await policy.promoteToCanary(shadow);
    expect(policy.forRequest("force-canary", 100).id).toBe(canary.id);
    expect(
      await policy.observeCanary(canary, {
        verificationFailureRate: 0.2,
        projectMismatchRate: 0,
        p95LatencyMs: 100,
        correctionRate: 0,
      }),
    ).toBe("rollback");
    expect(policy.canary()).toBeUndefined();
    await expect(policy.promoteToCanary(shadow)).rejects.toThrow("rollback cooldown");
    clock.advance(1_001);
    const next = await policy.createCandidate({ topK: 24 }, "shadow");
    expect((await policy.promoteToCanary(next)).state).toBe("canary");
    await store.close();

    const reopened = new ZvecStore(testStorage(root));
    const space = embeddingSpace();
    await reopened.start({ knowledge: space, memory: space, capability: space });
    const restored = new AdaptivePolicyService(reopened, "tenant:user:pi:mentis", { clock });
    await restored.initialize();
    expect(restored.canary()?.id).toBe(next.id);
    expect(restored.active().invariants.securityScopeEnabled).toBe(true);
    await reopened.close();
  });
});
