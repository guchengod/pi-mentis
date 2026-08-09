import {
  EvidenceAuthority,
  contextAffinity,
  type MentisContextSnapshot,
  type SearchHit,
} from "@pi-mentis/pi-mentis-core";
import type {
  MemoryRecord,
  PiScopeContext,
  RecallPrerequisite,
  RuntimeConstraints,
} from "@pi-mentis/pi-mentis-memory-core";

export interface RecallDecision {
  readonly shouldRecall: boolean;
  readonly sources: readonly ("knowledge" | "memory")[];
  readonly budgetTokens: number;
  readonly allowRemoteEmbedding: boolean;
  readonly allowRerank: boolean;
  readonly reason: string;
}

export interface RecallSignals {
  readonly prompt: string;
  readonly queryCacheHit: boolean;
  readonly embeddingCacheHit: boolean;
  readonly remainingContextTokens: number;
  readonly isCommand: boolean;
}

/**
 * Structural fast-recall gate. It deliberately does not classify the prompt:
 * every non-command, non-trivial input gets the same memory lane and budget.
 */
export function decideRecall(signals: RecallSignals): RecallDecision {
  const prompt = signals.prompt.trim();
  if (signals.isCommand) {
    return {
      shouldRecall: false,
      sources: [],
      budgetTokens: 0,
      allowRemoteEmbedding: false,
      allowRerank: false,
      reason: "command-input",
    };
  }
  if (prompt.length < 2) {
    return {
      shouldRecall: false,
      sources: [],
      budgetTokens: 0,
      allowRemoteEmbedding: false,
      allowRerank: false,
      reason: "insufficient-query-signal",
    };
  }
  return {
    shouldRecall: true,
    sources: ["memory"],
    budgetTokens: Math.max(0, Math.min(1_600, signals.remainingContextTokens)),
    allowRemoteEmbedding: signals.remainingContextTokens >= 500,
    allowRerank: false,
    reason: "classless-fast-recall",
  };
}

export interface GateRuntimeContext {
  readonly scope: PiScopeContext;
  readonly snapshot?: MentisContextSnapshot;
  readonly manifestTypes?: readonly string[];
  readonly availableTools?: readonly string[];
  readonly packageManager?: string;
  readonly os?: string;
  readonly architecture?: string;
  readonly runtime?: string;
  readonly runtimeVersion?: string;
  readonly historical?: boolean;
}

export interface GateDecision {
  readonly allowed: boolean;
  readonly scoreMultiplier: number;
  readonly reasons: readonly string[];
  readonly uncheckedPremises: readonly RecallPrerequisite[];
  readonly instructionSafe: boolean;
}

function compareVersion(left: string, right: string): number | undefined {
  const parse = (value: string): readonly number[] | undefined => {
    const match = value.match(/v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    return match === null
      ? undefined
      : [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
  };
  const a = parse(left);
  const b = parse(right);
  if (a === undefined || b === undefined) return undefined;
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

function runtimeConstraintDecision(
  constraints: RuntimeConstraints | undefined,
  context: GateRuntimeContext,
  reasons: string[],
): { readonly allowed: boolean; readonly multiplier: number } {
  if (constraints === undefined) return { allowed: true, multiplier: 0.9 };
  if (
    constraints.repositoryId !== undefined &&
    context.scope.repositoryId !== undefined &&
    constraints.repositoryId !== context.scope.repositoryId
  ) {
    reasons.push("runtime-constraint:repository-mismatch");
    return { allowed: false, multiplier: 0 };
  }
  if (
    constraints.projectId !== undefined &&
    context.scope.projectId !== undefined &&
    constraints.projectId !== context.scope.projectId
  ) {
    reasons.push("runtime-constraint:project-mismatch");
    return { allowed: false, multiplier: 0 };
  }
  let compatibilityMultiplier = 1;
  if (
    constraints.os !== undefined &&
    context.os !== undefined &&
    !constraints.os.includes(context.os)
  ) {
    reasons.push("environment:os-mismatch");
    if (constraints.strictOs === true) return { allowed: false, multiplier: 0 };
    compatibilityMultiplier *= 0.5;
  }
  if (
    constraints.architecture !== undefined &&
    context.architecture !== undefined &&
    !constraints.architecture.includes(context.architecture)
  ) {
    reasons.push("environment:architecture-mismatch");
    if (constraints.strictArchitecture === true) return { allowed: false, multiplier: 0 };
    compatibilityMultiplier *= 0.5;
  }
  if (
    constraints.packageManager !== undefined &&
    context.packageManager !== undefined &&
    constraints.packageManager !== context.packageManager
  ) {
    reasons.push("environment:package-manager-mismatch");
    return { allowed: false, multiplier: 0 };
  }
  if (
    constraints.runtime !== undefined &&
    context.runtime !== undefined &&
    constraints.runtime !== context.runtime
  ) {
    reasons.push("environment:runtime-mismatch");
    return { allowed: false, multiplier: 0 };
  }
  if (context.runtimeVersion !== undefined) {
    const below =
      constraints.runtimeVersionMin === undefined
        ? false
        : (compareVersion(context.runtimeVersion, constraints.runtimeVersionMin) ?? 0) < 0;
    const above =
      constraints.runtimeVersionMax === undefined
        ? false
        : (compareVersion(context.runtimeVersion, constraints.runtimeVersionMax) ?? 0) > 0;
    if (below || above) {
      reasons.push("environment:runtime-version-mismatch");
      return { allowed: false, multiplier: 0 };
    }
  }
  const unknown =
    (constraints.os !== undefined && context.os === undefined) ||
    (constraints.packageManager !== undefined && context.packageManager === undefined) ||
    (constraints.runtime !== undefined && context.runtime === undefined);
  reasons.push(unknown ? "environment:unknown" : "environment:compatible");
  return { allowed: true, multiplier: compatibilityMultiplier * (unknown ? 0.65 : 1) };
}

function prerequisiteDecision(
  prerequisites: readonly RecallPrerequisite[],
  context: GateRuntimeContext,
): { readonly allowed: boolean; readonly unchecked: readonly RecallPrerequisite[] } {
  const unchecked: RecallPrerequisite[] = [];
  for (const premise of prerequisites) {
    const known =
      premise.kind === "manifest"
        ? context.manifestTypes?.includes(premise.value)
        : premise.kind === "tool"
          ? context.availableTools?.includes(premise.value)
          : premise.kind === "package-manager"
            ? context.packageManager === premise.value
            : undefined;
    if (known === false && premise.required) return { allowed: false, unchecked };
    if (known === undefined) unchecked.push(premise);
  }
  return { allowed: true, unchecked };
}

function safeAsInstruction(
  origin: MemoryRecord["provenance"]["origin"],
  authority: number,
): boolean {
  if (origin === "external" || origin === "knowledge" || origin === "model") return false;
  return authority >= EvidenceAuthority.VerifiedToolObservation;
}

export function gateSearchHit(hit: SearchHit, context: GateRuntimeContext): GateDecision {
  const reasons: string[] = [];
  const os = context.os ?? context.snapshot?.environment?.os;
  const architecture = context.architecture ?? context.snapshot?.environment?.architecture;
  const packageManager = context.packageManager ?? context.snapshot?.environment?.packageManager;
  const runtime = context.runtime ?? context.snapshot?.environment?.runtime;
  const runtimeVersion = context.runtimeVersion ?? context.snapshot?.environment?.runtimeVersion;
  const effectiveContext: GateRuntimeContext = {
    ...context,
    ...(os === undefined ? {} : { os }),
    ...(architecture === undefined ? {} : { architecture }),
    ...(packageManager === undefined ? {} : { packageManager }),
    ...(runtime === undefined ? {} : { runtime }),
    ...(runtimeVersion === undefined ? {} : { runtimeVersion }),
  };
  const boundary = [
    context.scope.tenantId,
    context.scope.userId,
    context.scope.appId,
    context.scope.agentId,
  ]
    .map(encodeURIComponent)
    .join(":");
  if (hit.kind !== "memory") {
    if (hit.namespace.includes("::") && !hit.namespace.startsWith(`${boundary}::`)) {
      return {
        allowed: false,
        scoreMultiplier: 0,
        reasons: ["security:knowledge-scope-mismatch"],
        uncheckedPremises: [],
        instructionSafe: false,
      };
    }
    if (
      !hit.namespace.includes("::") &&
      (context.scope.tenantId !== "local" ||
        context.scope.userId !== "local" ||
        context.scope.appId !== "pi")
    ) {
      return {
        allowed: false,
        scoreMultiplier: 0,
        reasons: ["security:unscoped-legacy-knowledge"],
        uncheckedPremises: [],
        instructionSafe: false,
      };
    }
    return {
      allowed: true,
      scoreMultiplier: hit.authority / EvidenceAuthority.UserCurrentInstruction,
      reasons: [
        hit.namespace.includes("::")
          ? "knowledge:security-scope-match"
          : "knowledge:legacy-local-data-only",
      ],
      uncheckedPremises: [],
      instructionSafe: false,
    };
  }
  if (hit.metadata?.["derivedView"] === true) {
    const memberMemoryIds = hit.metadata["memberMemoryIds"];
    if (hit.namespace !== boundary) {
      return {
        allowed: false,
        scoreMultiplier: 0,
        reasons: ["security:view-scope-mismatch"],
        uncheckedPremises: [],
        instructionSafe: false,
      };
    }
    return Array.isArray(memberMemoryIds) && memberMemoryIds.length > 0
      ? {
          allowed: true,
          scoreMultiplier: 1,
          reasons: ["view:atomic-provenance-present"],
          uncheckedPremises: [],
          instructionSafe: false,
        }
      : {
          allowed: false,
          scoreMultiplier: 0,
          reasons: ["view:missing-atomic-provenance"],
          uncheckedPremises: [],
          instructionSafe: false,
        };
  }
  const record = hit.metadata as unknown as Omit<MemoryRecord, "embedding"> | undefined;
  if (record === undefined) {
    return {
      allowed: false,
      scoreMultiplier: 0,
      reasons: ["memory:missing-metadata"],
      uncheckedPremises: [],
      instructionSafe: false,
    };
  }
  const candidateScope = record.scopeContext;
  if (
    candidateScope === undefined ||
    candidateScope.tenantId !== context.scope.tenantId ||
    candidateScope.userId !== context.scope.userId ||
    candidateScope.appId !== context.scope.appId ||
    candidateScope.agentId !== context.scope.agentId
  ) {
    return {
      allowed: false,
      scoreMultiplier: 0,
      reasons: ["security:scope-mismatch"],
      uncheckedPremises: [],
      instructionSafe: false,
    };
  }
  if (
    (record.scope.kind === "repository" &&
      candidateScope.repositoryId !== undefined &&
      context.scope.repositoryId !== undefined &&
      candidateScope.repositoryId !== context.scope.repositoryId) ||
    (record.scope.kind === "project" &&
      candidateScope.projectId !== undefined &&
      context.scope.projectId !== undefined &&
      candidateScope.projectId !== context.scope.projectId)
  ) {
    return {
      allowed: false,
      scoreMultiplier: 0,
      reasons: ["security:project-scope-mismatch"],
      uncheckedPremises: [],
      instructionSafe: false,
    };
  }
  if (
    context.historical !== true &&
    ["superseded", "conflicted", "tombstoned", "rejected"].includes(record.status)
  ) {
    return {
      allowed: false,
      scoreMultiplier: 0,
      reasons: [`temporal:${record.status}`],
      uncheckedPremises: [],
      instructionSafe: false,
    };
  }
  const legacyRecord = record as unknown as Readonly<Record<string, unknown>>;
  const provenance =
    record.provenance ??
    ({
      origin:
        typeof legacyRecord["contentOrigin"] === "string"
          ? (legacyRecord["contentOrigin"] as MemoryRecord["provenance"]["origin"])
          : "external",
      epistemicState: legacyRecord["branchClaimState"] === "hypothesis" ? "hypothesis" : "asserted",
      ...(record.scopeContext?.branchId === undefined
        ? {}
        : { branchId: record.scopeContext.branchId }),
      ...(legacyRecord["branchClaimState"] === "hypothesis" ? { branchLocal: true } : {}),
    } satisfies MemoryRecord["provenance"]);
  if (provenance.epistemicState === "hypothesis" && provenance.branchLocal === true) {
    if (record.scopeContext?.branchId !== context.scope.branchId) {
      return {
        allowed: false,
        scoreMultiplier: 0,
        reasons: ["branch:unverified-hypothesis"],
        uncheckedPremises: [],
        instructionSafe: false,
      };
    }
  }
  let affinityMultiplier = 1;
  if (context.snapshot !== undefined) {
    const affinity = contextAffinity(
      {
        ...candidateScope,
        ...(candidateScope.repositoryId === undefined
          ? {}
          : { repositoryId: candidateScope.repositoryId }),
        ...(candidateScope.projectId === undefined ? {} : { projectId: candidateScope.projectId }),
        ...(candidateScope.taskId === undefined ? {} : { taskId: candidateScope.taskId }),
        ...(candidateScope.topicIds === undefined ? {} : { topicIds: candidateScope.topicIds }),
        ...(candidateScope.environmentFingerprint === undefined
          ? {}
          : { environmentFingerprint: candidateScope.environmentFingerprint }),
        ...(candidateScope.capabilitySnapshotId === undefined
          ? {}
          : { capabilitySnapshotId: candidateScope.capabilitySnapshotId }),
        ...(candidateScope.sessionId === undefined ? {} : { sessionId: candidateScope.sessionId }),
      },
      context.snapshot,
    );
    if (!affinity.allowed) {
      return {
        allowed: false,
        scoreMultiplier: 0,
        reasons: affinity.reasons,
        uncheckedPremises: [],
        instructionSafe: false,
      };
    }
    affinityMultiplier = 0.5 + 0.5 * affinity.score;
    reasons.push(...affinity.reasons);
  }
  const legacyConstraints = legacyRecord["applicability"] as RuntimeConstraints | undefined;
  const applicable = runtimeConstraintDecision(
    record.runtimeConstraints ?? legacyConstraints,
    effectiveContext,
    reasons,
  );
  if (!applicable.allowed) {
    return {
      allowed: false,
      scoreMultiplier: 0,
      reasons,
      uncheckedPremises: [],
      instructionSafe: false,
    };
  }
  const legacyPrerequisites = Array.isArray(legacyRecord["premises"])
    ? (legacyRecord["premises"] as readonly RecallPrerequisite[]).filter(
        (item) => item.kind !== ("context" as RecallPrerequisite["kind"]),
      )
    : [];
  const premise = prerequisiteDecision(
    record.recallPrerequisites ?? legacyPrerequisites,
    effectiveContext,
  );
  if (!premise.allowed) {
    return {
      allowed: false,
      scoreMultiplier: 0,
      reasons: [...reasons, "recall-prerequisite:required-failed"],
      uncheckedPremises: premise.unchecked,
      instructionSafe: false,
    };
  }
  const authorityMultiplier = Math.max(0.1, record.authority / 100);
  const evidenceMultiplier = record.evidenceRefs.length === 0 ? 0.6 : 1;
  if (record.evidenceRefs.length === 0) reasons.push("trust:evidence-missing");
  if (premise.unchecked.length > 0) reasons.push("recall-prerequisite:unchecked");
  return {
    allowed: true,
    scoreMultiplier:
      affinityMultiplier * applicable.multiplier * authorityMultiplier * evidenceMultiplier,
    reasons,
    uncheckedPremises: premise.unchecked,
    instructionSafe: safeAsInstruction(provenance.origin, record.authority),
  };
}
