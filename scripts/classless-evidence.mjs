import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { EvidenceAuthority } from "../packages/core/dist/index.js";
import { createMemoryService } from "../packages/memory/dist/index.js";
import { ZvecStore } from "../packages/zvec-storage/dist/index.js";

const dimensions = 16;
const space = {
  providerId: "classless-evidence",
  modelId: "deterministic",
  dimensions,
  normalization: "none",
  preprocessingVersion: "v1",
  inputKindVersion: "v1",
};
const embedding = {
  id: "classless-evidence",
  async capabilities() {
    return { models: [] };
  },
  async health() {
    return { status: "healthy", checkedAt: Date.now() };
  },
  async embed(request) {
    return {
      model: { providerId: this.id, modelId: "deterministic", capabilityVersion: "1" },
      vectors: request.inputs.map(() => {
        const values = new Float32Array(dimensions);
        values[0] = 1;
        return { values, dimensions, normalized: true };
      }),
      usage: { inputTokens: request.inputs.length },
    };
  },
};

const root = await mkdtemp(path.join(tmpdir(), "pi-mentis-classless-evidence-"));
const store = new ZvecStore({
  rootDir: root,
  readOnly: false,
  lockTimeoutMs: 1_000,
  generationRetentionMs: 60_000,
  writeBatch: { maxOperations: 256, maxBytes: 8 * 1024 * 1024, maxWaitMs: 5 },
});
const context = {
  tenantId: "evidence",
  userId: "user",
  appId: "pi",
  agentId: "mentis",
  sessionId: "session",
  branchId: "feature",
};
let observedAt = Date.UTC(2026, 7, 8);

function command(content, scopeId, extra = {}) {
  return {
    content,
    scope: { kind: "user", id: scopeId },
    scopeContext: context,
    authority: EvidenceAuthority.UserCurrentInstruction,
    observedAt: observedAt++,
    provenance: { origin: "user", epistemicState: "asserted", branchId: "feature" },
    ...extra,
  };
}

function result(commit) {
  return {
    id: commit.record?.id,
    status: commit.record?.status,
    relationship: commit.relationDecision,
    outcome: commit.outcome,
    traceId: commit.traceId,
  };
}

try {
  await store.start({ knowledge: space, memory: space, capability: space });
  const memory = createMemoryService({ store, embedding, embeddingSpace: space, dimensions });
  const evidence = {};

  const nivora = await memory.commit(command("我的临时编辑器主题代号是 Nivora。", "shape"));
  evidence.classless = {
    input: nivora.record?.content,
    commit: result(nivora),
    absentFields: ["predicate", "type", "domain", "cardinality", "factKey", "semanticKey"].filter(
      (key) => key in (nivora.record ?? {}),
    ),
  };

  const helixora = await memory.commit(
    command("我的临时编辑器默认配置代号是 Helixora。", "correction"),
  );
  const zedrune = await memory.commit(command("改成 Zedrune，以后以 Zedrune 为准。", "correction"));
  const correctionConsolidation = await memory.consolidateRelationship(
    zedrune.record.id,
    {
      relation: "supersede",
      targetIds: [helixora.record.id],
      confidence: 0.97,
      source: "background_consolidation",
      signals: {
        sameReferent: true,
        sameAttribute: true,
        explicitNewAssertion: true,
        explicitRetraction: false,
        replacementValuePresent: true,
        compatibleValue: false,
        incompatibleValue: true,
      },
      reasonCodes: ["pairwise_memory_reasoning", "same_referent", "same_attribute"],
      incomingHints: {
        subjectHint: "临时编辑器默认配置代号",
        relationHint: "使用",
        valueHint: "Zedrune",
      },
    },
    { scopeContext: context },
  );
  const correctionRecall = await memory.search({
    text: "编辑器默认配置代号",
    scopes: [{ kind: "user", id: "correction" }],
    scopeContext: context,
    temporalMode: "current",
  });
  evidence.arbitraryCorrection = {
    inputs: [helixora.record.content, zedrune.record.content],
    rawCommits: [result(helixora), result(zedrune)],
    slowConsolidation: correctionConsolidation,
    finalStatuses: {
      [helixora.record.id]: (await memory.get(helixora.record.id, { scopeContext: context }))
        .status,
      [zedrune.record.id]: (await memory.get(zedrune.record.id, { scopeContext: context })).status,
    },
    recallIds: correctionRecall.hits.map(({ id }) => id),
    recallContents: correctionRecall.hits.map(({ text }) => text),
  };

  const editor = await memory.commit(command("我的临时编辑器主题代号是 Nivora。", "same-value"));
  const terminal = await memory.commit(command("我的临时终端主题代号也是 Nivora。", "same-value"));
  evidence.sameValueDifferentFacts = { commits: [result(editor), result(terminal)] };

  const kotlin = await memory.commit(command("我喜欢 Kotlin。", "languages"));
  const elixir = await memory.commit(command("我喜欢 Elixir。", "languages"));
  const zig = await memory.commit(command("我喜欢 Zig。", "languages"));
  const retract = await memory.commit(command("Kotlin 现在不算我喜欢的编程语言了。", "languages"));
  const retractionConsolidation = await memory.consolidateRelationship(
    retract.record.id,
    {
      relation: "retract",
      targetIds: [kotlin.record.id],
      confidence: 0.97,
      source: "background_consolidation",
      signals: {
        sameReferent: true,
        sameAttribute: true,
        explicitNewAssertion: false,
        explicitRetraction: true,
        replacementValuePresent: false,
        compatibleValue: false,
        incompatibleValue: false,
      },
      reasonCodes: ["pairwise_memory_reasoning", "explicit_withdrawal"],
    },
    { scopeContext: context },
  );
  evidence.multiValueRetraction = {
    rawCommits: [kotlin, elixir, zig, retract].map(result),
    slowConsolidation: retractionConsolidation,
    finalStatuses: Object.fromEntries(
      await Promise.all(
        [kotlin, elixir, zig].map(async (item) => [
          item.record.id,
          (await memory.get(item.record.id, { scopeContext: context })).status,
        ]),
      ),
    ),
  };

  const ordered = await memory.commit(command("我的流程是：\n青灯\n→ 折线\n→ 封卷", "ordered"));
  evidence.ordered = { commit: result(ordered), orderedItems: ordered.record.orderedItems };

  const positive = await memory.commit(command("我喜欢 Kotlin。", "cross-target"));
  const negative = await memory.commit(command("我不喜欢 Elixir。", "cross-target"));
  evidence.crossTargetPolarity = { commits: [result(positive), result(negative)] };

  const branchAssertion = await memory.commit(command("我的测试代号是 Orion。", "branch"));
  const verified = await memory.commit(
    command("工具验证测试代号为 Orion。", "branch", {
      authority: EvidenceAuthority.VerifiedToolObservation,
      provenance: { origin: "tool", epistemicState: "verified", branchId: "feature" },
    }),
  );
  const hypothesis = await memory.commit(
    command("一个尚未验证的候选代号。", "branch", {
      authority: EvidenceAuthority.AssistantInference,
      provenance: {
        origin: "model",
        epistemicState: "hypothesis",
        branchId: "feature",
        branchLocal: true,
      },
    }),
  );
  const abandoned = await memory.abandonBranch("feature", context);
  evidence.branchSteer = {
    abandoned,
    statuses: Object.fromEntries(
      await Promise.all(
        [branchAssertion, verified, hypothesis].map(async (item) => [
          item.record.id,
          (await memory.get(item.record.id, { scopeContext: context })).status,
        ]),
      ),
    ),
  };

  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await store.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
