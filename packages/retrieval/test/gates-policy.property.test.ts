import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  EvidenceAuthority,
  MentisContextResolver,
  PI_COMPATIBILITY,
  type FastMentisContext,
  type SearchHit,
} from "@pi-mentis/pi-mentis-core";
import type { MemoryRecord, PiScopeContext } from "@pi-mentis/pi-mentis-memory-core";

import {
  evaluateReplayCandidate,
  gateSearchHit,
  validatePolicy,
  type AdaptivePolicy,
} from "../src/index.js";

const scope: PiScopeContext = {
  tenantId: "tenant",
  userId: "user",
  appId: "pi",
  agentId: "mentis",
  repositoryId: "repo:a",
  projectId: "project:a",
  branchId: "main",
};

const fastContext: FastMentisContext = {
  runtimeKey: "gate:test",
  identity: { tenantId: "tenant", userId: "user", appId: "pi", agentId: "mentis" },
  conversation: { sessionId: "session:a", branchId: "main", sessionMode: "persistent" },
  workspace: {
    workspaceId: "workspace:a",
    repositoryId: "repo:a",
    projectId: "project:a",
    canonicalPath: "/workspace/a",
    manifestTypes: ["package.json"],
  },
  situation: { taskId: "task:a", topicIds: ["topic:a"], interactionMode: "coding", startedAt: 1 },
  environment: {
    os: "darwin",
    architecture: "arm64",
    runtime: "node",
    runtimeVersion: "24.1.0",
    packageManager: "pnpm",
  },
  capability: {
    piVersion: PI_COMPATIBILITY.minVersion,
    extensionsHash: "extensions",
    skillsHash: "skills",
    mcpHash: "mcp",
    toolsHash: "tools",
    snapshotId: "capability:a",
  },
};
const snapshot = new MentisContextResolver({ now: () => 1 }).resolve(fastContext).snapshot;

function knowledgeHit(namespace: string): SearchHit {
  return {
    id: "knowledge:a",
    kind: "knowledge",
    text: "Pi uses Zvec",
    score: 1,
    tokenCount: 4,
    authority: EvidenceAuthority.UserKnowledge,
    namespace,
    contentHash: "knowledge-hash",
  };
}

function expectDenied(decision: ReturnType<typeof gateSearchHit>, reason: string): void {
  expect(decision).toEqual({
    allowed: false,
    scoreMultiplier: 0,
    reasons: [reason],
    uncheckedPremises: [],
    instructionSafe: false,
  });
}

function memoryHit(overrides: Partial<Omit<MemoryRecord, "embedding">> = {}): SearchHit {
  const metadata: Omit<MemoryRecord, "embedding"> = {
    id: "memory:a",
    content: "Run pnpm build",
    normalizedContent: "run pnpm build",
    contentHash: "hash",
    type: "procedural",
    domain: "procedure",
    scope: { kind: "project", id: "project:a" },
    scopeContext: scope,
    confidence: 0.9,
    importance: 0.8,
    authority: EvidenceAuthority.VerifiedToolObservation,
    evidenceRefs: [{ kind: "event", id: "event:a", observedAt: 1 }],
    supersedesIds: [],
    conflictsWithIds: [],
    status: "active",
    embeddingSpaceId: "test",
    createdAt: 1,
    updatedAt: 1,
    observedAt: 1,
    lastAccessedAt: 1,
    reinforceCount: 0,
    revision: 1,
    contentOrigin: "tool",
    ...overrides,
  };
  return {
    id: metadata.id,
    kind: "memory",
    text: metadata.content,
    score: 1,
    tokenCount: 5,
    authority: metadata.authority,
    namespace: "tenant:user:pi:mentis",
    contentHash: metadata.contentHash,
    metadata,
  };
}

const policy: AdaptivePolicy = {
  id: "policy:test",
  state: "active",
  parameters: {
    topK: 2,
    rerankCandidateLimit: 4,
    minimumAuthority: 20,
    affinityWeight: 1,
    freshnessWeight: 0.1,
    diversityLambda: 0.75,
    contextTokens: 100,
  },
  invariants: {
    securityScopeEnabled: true,
    instructionSafetyEnabled: true,
    evidenceRequiredForAuthority: true,
    deletionRulesAdaptive: false,
    minimumTrustFloor: 20,
  },
  createdAt: 1,
};

describe("retrieval gates and adaptive-policy invariants", () => {
  it("hard rejects every cross-identity memory even when text and score are identical", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("tenantId", "userId", "appId", "agentId"),
        fc
          .string({ minLength: 1 })
          .filter((value) => !["tenant", "user", "pi", "mentis"].includes(value)),
        (key, value) => {
          const decision = gateSearchHit(memoryHit({ scopeContext: { ...scope, [key]: value } }), {
            scope,
          });
          expect(decision).toMatchObject({ allowed: false, scoreMultiplier: 0 });
          expect(decision.reasons).toContain("security:scope-mismatch");
        },
      ),
      { numRuns: 200 },
    );
  });

  it("rejects wrong project, package manager, required premises, and unverified branches", () => {
    expect(
      gateSearchHit(memoryHit({ applicability: { repositoryId: "repo:b" } }), { scope }).allowed,
    ).toBe(false);
    expect(
      gateSearchHit(memoryHit({ applicability: { packageManager: "pnpm" } }), {
        scope,
        packageManager: "npm",
      }).allowed,
    ).toBe(false);
    expect(
      gateSearchHit(
        memoryHit({ premises: [{ kind: "manifest", value: "package.json", required: true }] }),
        { scope, manifestTypes: [] },
      ).allowed,
    ).toBe(false);
    expect(
      gateSearchHit(
        memoryHit({ branchClaimState: "hypothesis", scopeContext: { ...scope, branchId: "exp" } }),
        { scope },
      ).allowed,
    ).toBe(false);
  });

  it("enforces scoped and legacy knowledge boundaries", () => {
    expectDenied(
      gateSearchHit(knowledgeHit("other:user:pi:mentis::docs"), { scope }),
      "security:knowledge-scope-mismatch",
    );
    expect(gateSearchHit(knowledgeHit("tenant:user:pi:mentis::docs"), { scope })).toEqual({
      allowed: true,
      scoreMultiplier: 0.8,
      reasons: ["knowledge:security-scope-match"],
      uncheckedPremises: [],
      instructionSafe: false,
    });
    expectDenied(
      gateSearchHit(knowledgeHit("legacy"), { scope }),
      "security:unscoped-legacy-knowledge",
    );
    expect(
      gateSearchHit(knowledgeHit("legacy"), {
        scope: { ...scope, tenantId: "local", userId: "local", appId: "pi" },
      }),
    ).toEqual({
      allowed: true,
      scoreMultiplier: 0.8,
      reasons: ["knowledge:legacy-local-data-only"],
      uncheckedPremises: [],
      instructionSafe: false,
    });
  });

  it("rejects malformed, retired, and cross-boundary memory variants", () => {
    expectDenied(
      gateSearchHit({ ...memoryHit(), metadata: undefined }, { scope }),
      "memory:missing-metadata",
    );
    for (const status of ["superseded", "conflicted", "tombstoned", "rejected"] as const) {
      expectDenied(gateSearchHit(memoryHit({ status }), { scope }), `temporal:${status}`);
      expect(gateSearchHit(memoryHit({ status }), { scope, historical: true }).allowed).toBe(true);
    }
    expectDenied(
      gateSearchHit(memoryHit({ scopeContext: undefined }), { scope }),
      "security:scope-mismatch",
    );
    expect(
      gateSearchHit(
        memoryHit({ branchClaimState: "abandoned", scopeContext: { ...scope, branchId: "main" } }),
        { scope },
      ).allowed,
    ).toBe(true);
  });

  it("returns stable complete denial contracts for every hard gate", () => {
    expectDenied(
      gateSearchHit(memoryHit({ scopeContext: { ...scope, projectId: "project:b" } }), { scope }),
      "security:project-scope-mismatch",
    );
    expectDenied(
      gateSearchHit(
        memoryHit({
          branchClaimState: "hypothesis",
          scopeContext: { ...scope, branchId: "other" },
        }),
        { scope },
      ),
      "branch:unverified-hypothesis",
    );
    expectDenied(
      gateSearchHit(memoryHit({ applicability: { repositoryId: "repo:b" } }), { scope }),
      "applicability:repository-mismatch",
    );
    expectDenied(
      gateSearchHit(memoryHit({ applicability: { projectId: "project:b" } }), { scope }),
      "applicability:project-mismatch",
    );
    expectDenied(
      gateSearchHit(memoryHit({ applicability: { packageManager: "pnpm" } }), {
        scope,
        packageManager: "npm",
      }),
      "environment:package-manager-mismatch",
    );
    expectDenied(
      gateSearchHit(memoryHit({ applicability: { runtime: "bun" } }), { scope, runtime: "node" }),
      "environment:runtime-mismatch",
    );
    expectDenied(
      gateSearchHit(memoryHit({ applicability: { os: ["linux"], strictOs: true } }), {
        scope,
        os: "darwin",
      }),
      "environment:os-mismatch",
    );
    expectDenied(
      gateSearchHit(
        memoryHit({ applicability: { architecture: ["x64"], strictArchitecture: true } }),
        { scope, architecture: "arm64" },
      ),
      "environment:architecture-mismatch",
    );
    expectDenied(
      gateSearchHit(memoryHit({ applicability: { runtimeVersionMin: "25.0.0" } }), {
        scope,
        runtimeVersion: "24.0.0",
      }),
      "environment:runtime-version-mismatch",
    );
    expectDenied(
      gateSearchHit(
        memoryHit({ premises: [{ kind: "manifest", value: "package.json", required: true }] }),
        { scope, manifestTypes: [] },
      ),
      "premise:required-failed",
    );
  });

  it("evaluates every applicability compatibility path", () => {
    expect(
      gateSearchHit(memoryHit({ applicability: { projectId: "project:b" } }), { scope }).reasons,
    ).toContain("applicability:project-mismatch");
    const softEnvironment = gateSearchHit(
      memoryHit({ applicability: { os: ["linux"], architecture: ["x64"] } }),
      { scope, os: "darwin", architecture: "arm64" },
    );
    expect(softEnvironment.allowed).toBe(true);
    expect(softEnvironment.scoreMultiplier).toBeCloseTo(0.15);
    expect(softEnvironment.reasons).toEqual([
      "environment:os-mismatch",
      "environment:architecture-mismatch",
      "environment:compatible",
    ]);
    expect(
      gateSearchHit(memoryHit({ applicability: { os: ["linux"], strictOs: true } }), {
        scope,
        os: "darwin",
      }).allowed,
    ).toBe(false);
    expect(
      gateSearchHit(
        memoryHit({ applicability: { architecture: ["x64"], strictArchitecture: true } }),
        { scope, architecture: "arm64" },
      ).allowed,
    ).toBe(false);
    expect(
      gateSearchHit(memoryHit({ applicability: { runtime: "bun" } }), { scope, runtime: "node" })
        .allowed,
    ).toBe(false);
    for (const [runtimeVersion, applicability] of [
      ["19.0.0", { runtimeVersionMin: "20.0.0" }],
      ["27.0.0", { runtimeVersionMax: "26.0.0" }],
    ] as const) {
      expect(
        gateSearchHit(memoryHit({ applicability }), { scope, runtimeVersion }).reasons,
      ).toContain("environment:runtime-version-mismatch");
    }
    expect(
      gateSearchHit(memoryHit({ applicability: { runtimeVersionMin: "not-a-version" } }), {
        scope,
        runtimeVersion: "also-invalid",
      }).allowed,
    ).toBe(true);
    const unknownEnvironment = gateSearchHit(memoryHit({ applicability: { os: ["darwin"] } }), {
      scope,
    });
    expect(unknownEnvironment.reasons).toContain("environment:unknown");
    expect(unknownEnvironment.scoreMultiplier).toBeCloseTo(0.39);
    expect(
      gateSearchHit(
        memoryHit({ applicability: { runtimeVersionMin: "24.0.0", runtimeVersionMax: "24.1.0" } }),
        {
          scope,
          runtimeVersion: "v24.1",
        },
      ).reasons,
    ).toContain("environment:compatible");
    for (const [runtimeVersion, applicability, allowed] of [
      ["24.0.0", { runtimeVersionMin: "24.0.0", runtimeVersionMax: "24.0.0" }, true],
      ["24.1.1", { runtimeVersionMin: "24.1.2" }, false],
      ["24.1.3", { runtimeVersionMax: "24.1.2" }, false],
      ["24.2.0", { runtimeVersionMax: "24.1.9" }, false],
      ["23.9.9", { runtimeVersionMin: "24.0.0" }, false],
    ] as const) {
      expect(gateSearchHit(memoryHit({ applicability }), { scope, runtimeVersion }).allowed).toBe(
        allowed,
      );
    }
    for (const [applicability, context] of [
      [{ repositoryId: "repo:a" }, { scope }],
      [{ repositoryId: "repo:a" }, { scope: { ...scope, repositoryId: undefined } }],
      [{ projectId: "project:a" }, { scope }],
      [{ projectId: "project:a" }, { scope: { ...scope, projectId: undefined } }],
      [{ os: ["darwin"] }, { scope, os: "darwin" }],
      [{ architecture: ["arm64"] }, { scope, architecture: "arm64" }],
      [{ packageManager: "pnpm" }, { scope, packageManager: "pnpm" }],
      [{ runtime: "node" }, { scope, runtime: "node" }],
    ] as const) {
      expect(gateSearchHit(memoryHit({ applicability }), context).allowed).toBe(true);
    }
  });

  it("evaluates snapshot affinity, premises, evidence, and trust multipliers", () => {
    const contextual = memoryHit({
      scopeContext: {
        ...scope,
        sessionId: "session:a",
        taskId: "task:a",
        topicIds: ["topic:a"],
        environmentFingerprint: snapshot.environmentFingerprint,
        capabilitySnapshotId: "capability:a",
      },
      applicability: { packageManager: "pnpm", runtime: "node" },
      premises: [
        { kind: "manifest", value: "package.json", required: true },
        { kind: "tool", value: "read", required: true },
        { kind: "package-manager", value: "pnpm", required: true },
        { kind: "context", value: "manual-check", required: false },
      ],
    });
    const accepted = gateSearchHit(contextual, {
      scope,
      snapshot,
      manifestTypes: ["package.json"],
      availableTools: ["read"],
    });
    expect(accepted.allowed).toBe(true);
    expect(accepted.scoreMultiplier).toBeCloseTo(0.6);
    expect(accepted.reasons).toContain("premise:unchecked");
    expect(accepted.uncheckedPremises).toEqual([
      { kind: "context", value: "manual-check", required: false },
    ]);
    expect(
      gateSearchHit(memoryHit({ premises: [{ kind: "tool", value: "bash", required: true }] }), {
        scope,
        availableTools: [],
      }).reasons,
    ).toContain("premise:required-failed");
    const noEvidence = gateSearchHit(memoryHit({ evidenceRefs: [], authority: 10 }), { scope });
    expect(noEvidence).toMatchObject({ allowed: true, instructionSafe: false });
    expect(noEvidence.reasons).toContain("trust:evidence-missing");
    expect(noEvidence.scoreMultiplier).toBeCloseTo(0.054);
    expect(
      gateSearchHit(memoryHit({ scopeContext: { ...scope, projectId: "project:b" } }), {
        scope,
        snapshot,
      }).allowed,
    ).toBe(false);
  });

  it("covers known, unknown, required, and optional premise truth tables", () => {
    for (const [premise, context, expected] of [
      [
        { kind: "manifest", value: "package.json", required: true },
        { manifestTypes: ["package.json"] },
        true,
      ],
      [{ kind: "manifest", value: "missing", required: false }, { manifestTypes: [] }, true],
      [{ kind: "tool", value: "read", required: true }, { availableTools: ["read"] }, true],
      [{ kind: "tool", value: "bash", required: false }, { availableTools: [] }, true],
      [
        { kind: "package-manager", value: "pnpm", required: true },
        { packageManager: "pnpm" },
        true,
      ],
      [
        { kind: "package-manager", value: "npm", required: true },
        { packageManager: "pnpm" },
        false,
      ],
      [{ kind: "context", value: "manual", required: true }, {}, true],
    ] as const) {
      const decision = gateSearchHit(memoryHit({ premises: [premise] }), { scope, ...context });
      expect(decision.allowed).toBe(expected);
      if (premise.kind === "context") {
        expect(decision.uncheckedPremises).toEqual([premise]);
        expect(decision.reasons).toContain("premise:unchecked");
      }
    }
  });

  it("keeps external content as data and accepts verified tool observations as instructions", () => {
    expect(gateSearchHit(memoryHit({ contentOrigin: "external" }), { scope }).instructionSafe).toBe(
      false,
    );
    expect(gateSearchHit(memoryHit(), { scope }).instructionSafe).toBe(true);
    expect(gateSearchHit(memoryHit(), { scope })).toEqual({
      allowed: true,
      scoreMultiplier: 0.54,
      reasons: [],
      uncheckedPremises: [],
      instructionSafe: true,
    });
  });

  it("requires atomic provenance for a derived view", () => {
    const base: SearchHit = {
      ...memoryHit(),
      id: "view:a",
      namespace: "tenant:user:pi:mentis",
      metadata: { derivedView: true, memberMemoryIds: [] },
    };
    expectDenied(gateSearchHit(base, { scope }), "view:missing-atomic-provenance");
    expect(
      gateSearchHit(
        { ...base, metadata: { derivedView: true, memberMemoryIds: ["memory:a"] } },
        { scope },
      ),
    ).toEqual({
      allowed: true,
      scoreMultiplier: 1,
      reasons: ["view:atomic-provenance-present"],
      uncheckedPremises: [],
      instructionSafe: false,
    });
    expectDenied(
      gateSearchHit({ ...base, namespace: "other:user:pi:mentis" }, { scope }),
      "security:view-scope-mismatch",
    );
  });

  it("rejects mutation of protected policy invariants and evaluates replay deterministically", () => {
    expect(() =>
      validatePolicy({
        ...policy,
        invariants: { ...policy.invariants, securityScopeEnabled: false as true },
      }),
    ).toThrow("protected safety invariant");
    const replay = {
      id: "case",
      positiveMemoryIds: ["a"],
      negativeMemoryIds: ["evil"],
      requiredEvidenceIds: [],
      candidateFeatures: [
        {
          id: "a",
          kind: "memory" as const,
          score: 1,
          tokenCount: 20,
          authority: 80,
          termHashes: ["x"],
        },
        {
          id: "b",
          kind: "memory" as const,
          score: 0.9,
          tokenCount: 20,
          authority: 80,
          termHashes: ["x"],
        },
        {
          id: "c",
          kind: "memory" as const,
          score: 0.8,
          tokenCount: 20,
          authority: 80,
          termHashes: ["y"],
        },
        {
          id: "evil",
          kind: "memory" as const,
          score: 2,
          tokenCount: 20,
          authority: 0,
          termHashes: ["z"],
        },
      ],
    };
    expect(evaluateReplayCandidate(policy, replay)).toEqual(["a", "c"]);
    expect(evaluateReplayCandidate(policy, replay)).toEqual(
      evaluateReplayCandidate(policy, replay),
    );
  });
});
