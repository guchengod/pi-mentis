import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EvidenceAuthority } from "@pi-mentis/pi-mentis-core";
import { createMemoryService, type PiScopeContext } from "@pi-mentis/pi-mentis-memory-core";
import { StateRevisionConflictError, ZvecStateStore, ZvecStore } from "@pi-mentis/pi-mentis-zvec";

import { DeterministicEmbeddingProvider, embeddingSpace, testStorage } from "./helpers.js";

const roots: string[] = [];

async function temporaryStore(): Promise<{ root: string; store: ZvecStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-mentis-intelligence-"));
  roots.push(root);
  const store = new ZvecStore(testStorage(root));
  const space = embeddingSpace();
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
