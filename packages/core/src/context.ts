import { stableHash } from "./hash.js";

export interface IdentityFacet {
  readonly tenantId: string;
  readonly userId: string;
  readonly appId: string;
  readonly agentId: string;
}

export interface ConversationFacet {
  readonly sessionId: string;
  readonly branchId?: string;
  readonly parentBranchId?: string;
  readonly runId?: string;
  readonly sessionMode: "persistent" | "ephemeral" | "imported" | "forked";
  readonly currentEntryId?: string;
}

export interface WorkspaceFacet {
  readonly workspaceId?: string;
  readonly repositoryId?: string;
  readonly projectId?: string;
  readonly canonicalPath?: string;
  readonly repositoryRoot?: string;
  readonly branchName?: string;
  readonly commitId?: string;
  readonly dirty?: boolean;
  readonly manifestTypes: readonly string[];
  readonly manifestHash?: string;
}

export interface SituationFacet {
  readonly taskId?: string;
  readonly taskKind?: string;
  readonly topicIds: readonly string[];
  readonly activeGoal?: string;
  readonly interactionMode:
    "coding" | "research" | "planning" | "conversation" | "operation" | "unknown";
  readonly startedAt: number;
}

export interface EnvironmentFacet {
  readonly os?: string;
  readonly architecture?: string;
  readonly shell?: string;
  readonly language?: string;
  readonly runtime?: string;
  readonly runtimeVersion?: string;
  readonly packageManager?: string;
  readonly packageManagerVersion?: string;
  readonly toolchainHash?: string;
}

export interface CapabilityFacet {
  readonly piVersion: string;
  readonly provider?: string;
  readonly model?: string;
  readonly extensionsHash: string;
  readonly skillsHash: string;
  readonly mcpHash: string;
  readonly toolsHash: string;
  readonly snapshotId: string;
}

export interface MentisContextSnapshot {
  readonly id: string;
  readonly revision: number;
  readonly identity: IdentityFacet;
  readonly conversation: ConversationFacet;
  readonly workspace?: WorkspaceFacet;
  readonly situation: SituationFacet;
  readonly environment?: EnvironmentFacet;
  readonly capability: CapabilityFacet;
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly fingerprint: string;
}

export interface FastMentisContext {
  readonly runtimeKey: string;
  readonly identity: IdentityFacet;
  readonly conversation: ConversationFacet;
  readonly workspace?: WorkspaceFacet;
  readonly situation: SituationFacet;
  readonly environment?: EnvironmentFacet;
  readonly capability: CapabilityFacet;
}

export interface ContextResolution {
  readonly snapshot: MentisContextSnapshot;
  readonly reused: boolean;
}

export interface TopicIdentity {
  readonly topicId: string;
  readonly label: string;
  readonly domain?: string;
  readonly embedding?: readonly number[];
  readonly confidence: number;
}

export interface TopicMatchThresholds {
  readonly calibratedLow: number;
  readonly calibratedHigh: number;
}

export interface TopicMatchCandidate {
  readonly topic: TopicIdentity;
  readonly score: number;
}

export type TopicResolution =
  | { readonly decision: "reuse"; readonly topic: TopicIdentity; readonly reason: string }
  | {
      readonly decision: "pending";
      readonly label?: string;
      readonly candidate?: TopicMatchCandidate;
      readonly reason: string;
    }
  | { readonly decision: "new_candidate"; readonly topic: TopicIdentity; readonly reason: string };

export interface ContextAffinityCandidate {
  readonly tenantId: string;
  readonly userId: string;
  readonly appId: string;
  readonly agentId: string;
  readonly domain?: string;
  readonly repositoryId?: string;
  readonly projectId?: string;
  readonly workspaceId?: string;
  readonly taskId?: string;
  readonly topicIds?: readonly string[];
  readonly environmentFingerprint?: string;
  readonly capabilitySnapshotId?: string;
  readonly sessionId?: string;
}

export interface ContextAffinityResult {
  readonly allowed: boolean;
  readonly hardReject: boolean;
  readonly score: number;
  readonly matchedWeight: number;
  readonly applicableWeight: number;
  readonly reasons: readonly string[];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

export function contextFingerprint(input: Omit<FastMentisContext, "runtimeKey">): string {
  return stableHash("mentis-context-fast:v1", JSON.stringify(canonical(input)));
}

export function environmentFingerprint(
  environment: EnvironmentFacet | undefined,
): string | undefined {
  return environment === undefined
    ? undefined
    : stableHash("mentis-environment:v1", JSON.stringify(canonical(environment)));
}

/**
 * Resolves a topic without inventing one per turn. Vector thresholds are mandatory calibrated
 * inputs rather than universal constants.
 */
export function resolveTopicIdentity(input: {
  readonly explicitTopic?: string;
  readonly activeTopics?: readonly TopicIdentity[];
  readonly taskTitle?: string;
  readonly recurringEntities?: readonly string[];
  readonly vectorMatches?: readonly TopicMatchCandidate[];
  readonly thresholds?: TopicMatchThresholds;
}): TopicResolution {
  const explicit = input.explicitTopic?.trim();
  if (explicit !== undefined && explicit !== "") {
    const existing = input.activeTopics?.find(
      (topic) => topic.label.localeCompare(explicit, undefined, { sensitivity: "accent" }) === 0,
    );
    if (existing !== undefined)
      return { decision: "reuse", topic: existing, reason: "explicit_topic_matches_active" };
    return {
      decision: "new_candidate",
      topic: {
        topicId: `topic:${stableHash("mentis-topic:v1", explicit.toLocaleLowerCase())}`,
        label: explicit,
        confidence: 1,
      },
      reason: "user_explicit_topic",
    };
  }
  const active = input.activeTopics?.[0];
  if (active !== undefined)
    return { decision: "reuse", topic: active, reason: "active_memory_topic" };

  const label =
    input.taskTitle?.trim() || input.recurringEntities?.find((item) => item.trim() !== "");
  const best = [...(input.vectorMatches ?? [])].sort((left, right) => right.score - left.score)[0];
  if (best === undefined) {
    return {
      decision: "pending",
      ...(label === undefined ? {} : { label }),
      reason: "insufficient_topic_evidence",
    };
  }
  if (input.thresholds === undefined) {
    throw new Error("Calibrated topic thresholds are required for vector topic matching");
  }
  const { calibratedLow, calibratedHigh } = input.thresholds;
  if (!(calibratedLow >= 0 && calibratedLow < calibratedHigh && calibratedHigh <= 1)) {
    throw new Error("Topic thresholds must satisfy 0 <= calibratedLow < calibratedHigh <= 1");
  }
  if (best.score >= calibratedHigh)
    return { decision: "reuse", topic: best.topic, reason: "calibrated_high_match" };
  if (best.score >= calibratedLow)
    return {
      decision: "pending",
      ...(label === undefined ? {} : { label }),
      candidate: best,
      reason: "ambiguous_vector_match",
    };
  if (label === undefined) return { decision: "pending", reason: "no_stable_topic_label" };
  return {
    decision: "new_candidate",
    topic: {
      topicId: `topic:${stableHash("mentis-topic:v1", label.toLocaleLowerCase())}`,
      label,
      confidence: Math.max(0, 1 - best.score),
    },
    reason: "below_calibrated_low",
  };
}

const affinityWeights = {
  repository: 1,
  project: 0.9,
  task: 0.85,
  topic: 0.75,
  environment: 0.7,
  capability: 0.65,
  workspace: 0.5,
  session: 0.25,
} as const;

/** Security identity is a hard boundary; absent code facets do not reduce a general memory. */
export function contextAffinity(
  candidate: ContextAffinityCandidate,
  context: MentisContextSnapshot,
): ContextAffinityResult {
  const reasons: string[] = [];
  for (const key of ["tenantId", "userId", "appId", "agentId"] as const) {
    if (candidate[key] !== context.identity[key]) {
      return {
        allowed: false,
        hardReject: true,
        score: 0,
        matchedWeight: 0,
        applicableWeight: 0,
        reasons: [`security_identity_mismatch:${key}`],
      };
    }
  }
  if (
    candidate.domain === "project" &&
    candidate.repositoryId !== undefined &&
    context.workspace?.repositoryId !== undefined &&
    candidate.repositoryId !== context.workspace.repositoryId
  ) {
    return {
      allowed: false,
      hardReject: true,
      score: 0,
      matchedWeight: 0,
      applicableWeight: affinityWeights.repository,
      reasons: ["project_repository_mismatch"],
    };
  }

  let matchedWeight = 0;
  let applicableWeight = 0;
  const compare = (
    name: keyof typeof affinityWeights,
    candidateValue: string | undefined,
    contextValue: string | undefined,
  ): void => {
    if (candidateValue === undefined || contextValue === undefined) return;
    const weight = affinityWeights[name];
    applicableWeight += weight;
    if (candidateValue === contextValue) {
      matchedWeight += weight;
      reasons.push(`${name}_match`);
    } else reasons.push(`${name}_mismatch`);
  };
  compare("repository", candidate.repositoryId, context.workspace?.repositoryId);
  compare("project", candidate.projectId, context.workspace?.projectId);
  compare("task", candidate.taskId, context.situation.taskId);
  compare(
    "environment",
    candidate.environmentFingerprint,
    environmentFingerprint(context.environment),
  );
  compare("capability", candidate.capabilitySnapshotId, context.capability.snapshotId);
  compare("workspace", candidate.workspaceId, context.workspace?.workspaceId);
  compare("session", candidate.sessionId, context.conversation.sessionId);

  const candidateTopics = candidate.topicIds ?? [];
  if (candidateTopics.length > 0 && context.situation.topicIds.length > 0) {
    const current = new Set(context.situation.topicIds);
    const overlap = candidateTopics.filter((topic) => current.has(topic)).length;
    applicableWeight += affinityWeights.topic;
    matchedWeight += affinityWeights.topic * (overlap / candidateTopics.length);
    reasons.push(overlap > 0 ? "topic_overlap" : "topic_mismatch");
  }
  const score = applicableWeight === 0 ? 1 : matchedWeight / applicableWeight;
  return { allowed: true, hardReject: false, score, matchedWeight, applicableWeight, reasons };
}

/** Synchronous minimum-snapshot resolver; slow repository/capability scans stay outside this path. */
export class MentisContextResolver {
  readonly #cache = new Map<string, MentisContextSnapshot>();

  resolve(input: FastMentisContext): ContextResolution {
    const { runtimeKey, ...facets } = input;
    const fingerprint = contextFingerprint(facets);
    const cached = this.#cache.get(runtimeKey);
    if (cached?.fingerprint === fingerprint) return { snapshot: cached, reused: true };
    const revision = (cached?.revision ?? 0) + 1;
    const createdAt = Date.now();
    const snapshot: MentisContextSnapshot = {
      id: stableHash("mentis-context-snapshot:v1", runtimeKey, String(revision), fingerprint),
      revision,
      ...facets,
      createdAt,
      fingerprint,
    };
    this.#cache.set(runtimeKey, snapshot);
    return { snapshot, reused: false };
  }

  get(runtimeKey: string): MentisContextSnapshot | undefined {
    return this.#cache.get(runtimeKey);
  }

  clear(runtimeKey?: string): void {
    if (runtimeKey === undefined) this.#cache.clear();
    else this.#cache.delete(runtimeKey);
  }
}

export function inferInteractionMode(
  prompt: string,
  hasWorkspace: boolean,
): SituationFacet["interactionMode"] {
  if (/\b(?:research|investigate|compare sources|paper|study)\b|研究|调研|查资料/i.test(prompt))
    return "research";
  if (/\b(?:plan|roadmap|schedule|organize)\b|计划|规划|安排/i.test(prompt)) return "planning";
  if (/^\s*[!/]|\b(?:deploy|restart|install|run command)\b|部署|重启|安装/i.test(prompt))
    return "operation";
  if (hasWorkspace) return "coding";
  return prompt.trim() === "" ? "unknown" : "conversation";
}
