import {
  EvidenceAuthority,
  contextAffinity,
  type MentisContextSnapshot,
  type SearchHit,
} from "@pi-mentis/pi-mentis-core";
import type {
  MemoryApplicability,
  MemoryContentOrigin,
  MemoryPremise,
  MemoryRecord,
  PiScopeContext,
} from "@pi-mentis/pi-mentis-memory-core";

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
  readonly uncheckedPremises: readonly MemoryPremise[];
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

function applicationDecision(
  applicability: MemoryApplicability | undefined,
  context: GateRuntimeContext,
  reasons: string[],
): { readonly allowed: boolean; readonly multiplier: number } {
  if (applicability === undefined) return { allowed: true, multiplier: 0.9 };
  if (
    applicability.repositoryId !== undefined &&
    context.scope.repositoryId !== undefined &&
    applicability.repositoryId !== context.scope.repositoryId
  ) {
    reasons.push("applicability:repository-mismatch");
    return { allowed: false, multiplier: 0 };
  }
  if (
    applicability.projectId !== undefined &&
    context.scope.projectId !== undefined &&
    applicability.projectId !== context.scope.projectId
  ) {
    reasons.push("applicability:project-mismatch");
    return { allowed: false, multiplier: 0 };
  }
  let compatibilityMultiplier = 1;
  if (
    applicability.os !== undefined &&
    context.os !== undefined &&
    !applicability.os.includes(context.os)
  ) {
    reasons.push("environment:os-mismatch");
    if (applicability.strictOs === true) return { allowed: false, multiplier: 0 };
    compatibilityMultiplier *= 0.5;
  }
  if (
    applicability.architecture !== undefined &&
    context.architecture !== undefined &&
    !applicability.architecture.includes(context.architecture)
  ) {
    reasons.push("environment:architecture-mismatch");
    if (applicability.strictArchitecture === true) return { allowed: false, multiplier: 0 };
    compatibilityMultiplier *= 0.5;
  }
  if (
    applicability.packageManager !== undefined &&
    context.packageManager !== undefined &&
    applicability.packageManager !== context.packageManager
  ) {
    reasons.push("environment:package-manager-mismatch");
    return { allowed: false, multiplier: 0 };
  }
  if (
    applicability.runtime !== undefined &&
    context.runtime !== undefined &&
    applicability.runtime !== context.runtime
  ) {
    reasons.push("environment:runtime-mismatch");
    return { allowed: false, multiplier: 0 };
  }
  if (context.runtimeVersion !== undefined) {
    const below =
      applicability.runtimeVersionMin === undefined
        ? false
        : (compareVersion(context.runtimeVersion, applicability.runtimeVersionMin) ?? 0) < 0;
    const above =
      applicability.runtimeVersionMax === undefined
        ? false
        : (compareVersion(context.runtimeVersion, applicability.runtimeVersionMax) ?? 0) > 0;
    if (below || above) {
      reasons.push("environment:runtime-version-mismatch");
      return { allowed: false, multiplier: 0 };
    }
  }
  const unknown =
    (applicability.os !== undefined && context.os === undefined) ||
    (applicability.packageManager !== undefined && context.packageManager === undefined) ||
    (applicability.runtime !== undefined && context.runtime === undefined);
  reasons.push(unknown ? "environment:unknown" : "environment:compatible");
  return { allowed: true, multiplier: compatibilityMultiplier * (unknown ? 0.65 : 1) };
}

function premiseDecision(
  premises: readonly MemoryPremise[],
  context: GateRuntimeContext,
): { readonly allowed: boolean; readonly unchecked: readonly MemoryPremise[] } {
  const unchecked: MemoryPremise[] = [];
  for (const premise of premises) {
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

function safeAsInstruction(origin: MemoryContentOrigin | undefined, authority: number): boolean {
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
  if (record.branchClaimState === "hypothesis" || record.branchClaimState === "abandoned") {
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
        domain: record.domain,
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
  const applicable = applicationDecision(record.applicability, effectiveContext, reasons);
  if (!applicable.allowed) {
    return {
      allowed: false,
      scoreMultiplier: 0,
      reasons,
      uncheckedPremises: [],
      instructionSafe: false,
    };
  }
  const premise = premiseDecision(record.premises ?? [], effectiveContext);
  if (!premise.allowed) {
    return {
      allowed: false,
      scoreMultiplier: 0,
      reasons: [...reasons, "premise:required-failed"],
      uncheckedPremises: premise.unchecked,
      instructionSafe: false,
    };
  }
  const authorityMultiplier = Math.max(0.1, record.authority / 100);
  const evidenceMultiplier = record.evidenceRefs.length === 0 ? 0.6 : 1;
  if (record.evidenceRefs.length === 0) reasons.push("trust:evidence-missing");
  if (premise.unchecked.length > 0) reasons.push("premise:unchecked");
  return {
    allowed: true,
    scoreMultiplier:
      affinityMultiplier * applicable.multiplier * authorityMultiplier * evidenceMultiplier,
    reasons,
    uncheckedPremises: premise.unchecked,
    instructionSafe: safeAsInstruction(record.contentOrigin, record.authority),
  };
}
