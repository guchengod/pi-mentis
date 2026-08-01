import type {
  EvidenceAuthority,
  EvidenceRef,
  OperationOptions,
  SearchResult,
} from "@pi-mentis/pi-mentis-core";

export interface MemoryScope {
  readonly kind:
    | "user"
    | "workspace"
    | "project"
    | "repository"
    | "topic"
    | "task"
    | "session"
    | "branch"
    | "run";
  readonly id: string;
}

/** Complete Mentis provenance. Code-related fields are optional context affinity, not identity. */
export interface PiScopeContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly appId: string;
  readonly agentId: string;
  readonly workspacePath?: string;
  readonly projectId?: string;
  readonly repositoryId?: string;
  readonly sessionId?: string;
  readonly branchId?: string;
  readonly parentBranchId?: string;
  readonly runId?: string;
  readonly contextSnapshotId?: string;
  readonly taskId?: string;
  readonly topicIds?: readonly string[];
  readonly interactionMode?:
    "coding" | "research" | "planning" | "conversation" | "operation" | "unknown";
  readonly environmentFingerprint?: string;
  readonly capabilitySnapshotId?: string;
}

export type MemoryDomain =
  "user" | "project" | "environment" | "procedure" | "capability" | "task" | "topic" | "episodic";

export type MemoryType =
  "preference" | "requirement" | "fact" | "decision" | "procedural" | "episodic" | "task";

export interface MemoryRecord {
  readonly id: string;
  readonly content: string;
  readonly normalizedContent: string;
  readonly contentHash: string;
  readonly type: MemoryType;
  readonly domain: MemoryDomain;
  readonly scope: MemoryScope;
  readonly scopeContext?: PiScopeContext;
  readonly confidence: number;
  readonly importance: number;
  readonly authority: EvidenceAuthority;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly supersedesIds: readonly string[];
  readonly conflictsWithIds: readonly string[];
  readonly status:
    "pending" | "active" | "superseded" | "conflicted" | "expired" | "tombstoned" | "rejected";
  readonly embeddingSpaceId: string;
  readonly embedding: Float32Array;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly observedAt: number;
  readonly validFrom?: number;
  readonly validUntil?: number;
  readonly supersededById?: string;
  readonly lastAccessedAt: number;
  readonly reinforceCount: number;
  readonly revision: number;
}

export interface CommitMemoryCommand {
  readonly content: string;
  readonly type: MemoryType;
  readonly domain?: MemoryDomain;
  readonly scope: MemoryScope;
  readonly scopeContext?: PiScopeContext;
  readonly confidence?: number;
  readonly importance?: number;
  readonly authority: EvidenceAuthority;
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly supersedesIds?: readonly string[];
}

export interface CommitMemoryResult {
  readonly outcome: "created" | "reinforced" | "corrected" | "superseded" | "conflict" | "rejected";
  readonly record: Omit<MemoryRecord, "embedding">;
  readonly relatedIds: readonly string[];
}

export interface MemoryQuery {
  readonly text: string;
  readonly scopes?: readonly MemoryScope[];
  readonly scopeContext?: Pick<PiScopeContext, "tenantId" | "userId" | "appId" | "agentId">;
  readonly limit?: number;
}

export interface MemorySearchOptions extends OperationOptions {
  readonly timeoutMs?: number;
}

export interface MemoryGetOptions extends OperationOptions {
  readonly scopeContext?: Pick<PiScopeContext, "tenantId" | "userId" | "appId" | "agentId">;
}

export interface MemoryService {
  commit(command: CommitMemoryCommand, options?: OperationOptions): Promise<CommitMemoryResult>;
  search(query: MemoryQuery, options?: MemorySearchOptions): Promise<SearchResult>;
  get(id: string, options?: MemoryGetOptions): Promise<Omit<MemoryRecord, "embedding"> | undefined>;
  markConflicted?(
    id: string,
    evidence: EvidenceRef,
    options?: OperationOptions,
  ): Promise<Omit<MemoryRecord, "embedding"> | undefined>;
  tombstone(id: string, options?: OperationOptions): Promise<boolean>;
}

export interface CapturedToolEvent {
  readonly sequence?: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: "started" | "completed" | "failed";
  readonly timestamp: number;
  readonly durationMs?: number;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly output?: ToolSymbolicResult;
  readonly artifactRef?: EvidenceRef;
  readonly filePaths?: readonly string[];
  readonly symbols?: readonly string[];
  readonly summary?: string;
}

export interface TurnCapture {
  readonly turnIndex: number;
  readonly events: readonly CapturedToolEvent[];
  readonly sealedAt: number;
}

export type PiEpisodeStatus = "running" | "completed" | "failed" | "aborted" | "partial";

export interface PiEpisode {
  readonly id: string;
  readonly sessionId: string;
  readonly branchId?: string;
  readonly parentBranchId?: string;
  readonly runId?: string;
  readonly projectId?: string;
  readonly repositoryId?: string;
  readonly workspacePath?: string;
  readonly contextSnapshotId?: string;
  readonly taskId?: string;
  readonly topicIds: readonly string[];
  readonly interactionMode?: PiScopeContext["interactionMode"];
  readonly goal: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly status: PiEpisodeStatus;
  readonly firstSequence: number;
  readonly lastSequence: number;
}

export type PiEventKind =
  | "goal"
  | "steering"
  | "tool_call"
  | "tool_result"
  | "file_edit"
  | "verification"
  | "compaction"
  | "outcome";

export interface PiEvent {
  readonly id: string;
  readonly episodeId: string;
  readonly sequence: number;
  readonly kind: PiEventKind;
  readonly timestamp: number;
  readonly toolCallId?: string;
  readonly parentEventId?: string;
  readonly artifactRef?: EvidenceRef;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface SteeringEvent {
  readonly id: string;
  readonly episodeId: string;
  readonly sequence: number;
  readonly previousGoal?: string;
  readonly updatedGoal: string;
  readonly invalidatedPlanIds: readonly string[];
  readonly timestamp: number;
}

export interface OutcomeStatus {
  readonly executionStatus: "success" | "failed" | "partial";
  readonly verificationStatus: "passed" | "failed" | "not_run" | "unknown";
  readonly taskStatus: "completed" | "failed" | "partial" | "aborted";
}

export interface ArtifactRecord {
  readonly id: string;
  readonly episodeId: string;
  readonly eventId?: string;
  readonly toolCallId?: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly contentHash: string;
  readonly relativePath: string;
  readonly createdAt: number;
}

export interface ToolSymbolicResult {
  readonly tool: string;
  readonly status: "completed" | "failed";
  readonly command?: string;
  readonly cwd?: string;
  readonly exitCode?: number | null;
  readonly durationMs?: number;
  readonly errorCount: number;
  readonly keyErrors: readonly string[];
  readonly files: readonly string[];
  readonly artifactId?: string;
  readonly truncated: boolean;
  readonly originalBytes: number;
  readonly preview?: string;
}

export interface ToolResultOffloadPolicy {
  readonly inlineMaxBytes: number;
  readonly truncateMaxBytes: number;
  readonly previewBytes: number;
}

export interface ToolResultEnvelope {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly text: string;
  readonly details?: unknown;
  readonly isError: boolean;
  readonly cwd: string;
  readonly startedAt?: number;
  readonly completedAt: number;
}

export interface OffloadedToolResult {
  readonly mode: "inline" | "truncated" | "artifact";
  readonly symbolic: ToolSymbolicResult;
  readonly modelText: string;
  readonly artifact?: ArtifactRecord;
}

export interface PiEvidenceStore {
  createEpisode(episode: PiEpisode, options?: OperationOptions): Promise<void>;
  updateEpisode(episode: PiEpisode, options?: OperationOptions): Promise<void>;
  appendEvent(event: PiEvent, options?: OperationOptions): Promise<void>;
  writeArtifact(
    input: Omit<
      ArtifactRecord,
      "id" | "contentHash" | "relativePath" | "byteLength" | "createdAt"
    > & {
      readonly content: string;
    },
    options?: OperationOptions,
  ): Promise<ArtifactRecord>;
  getEpisode(id: string, options?: OperationOptions): Promise<PiEpisode | undefined>;
  getEvent(id: string, options?: OperationOptions): Promise<PiEvent | undefined>;
  getArtifact(id: string, options?: OperationOptions): Promise<ArtifactRecord | undefined>;
  readEvidence(
    refs: readonly EvidenceRef[],
    options?: OperationOptions,
  ): Promise<readonly unknown[]>;
}

export interface ExperienceCandidate {
  readonly id: string;
  readonly goal: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly prerequisites: readonly string[];
  readonly steps: readonly string[];
  readonly successEvidence: readonly EvidenceRef[];
  readonly failureEvidence: readonly EvidenceRef[];
  readonly cost: number;
  readonly durationMs: number;
  readonly appliesWhen: readonly string[];
  readonly excludesWhen: readonly string[];
  readonly successes: number;
  readonly failures: number;
  readonly state: "observed" | "evaluating" | "qualified" | "promoted" | "rejected";
  readonly capabilityGaps: readonly string[];
  readonly generationContext: readonly string[];
  readonly validationPlan: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ExperienceOutcome {
  readonly succeeded: boolean;
  readonly evidence: EvidenceRef;
  readonly cost: number;
  readonly durationMs: number;
  readonly environment: Readonly<Record<string, string>>;
}

export interface ExperienceLearningService {
  observe(
    candidate: Omit<
      ExperienceCandidate,
      | "id"
      | "successes"
      | "failures"
      | "state"
      | "successEvidence"
      | "failureEvidence"
      | "createdAt"
      | "updatedAt"
    >,
    options?: OperationOptions,
  ): Promise<ExperienceCandidate>;
  recordOutcome(
    id: string,
    outcome: ExperienceOutcome,
    options?: OperationOptions,
  ): Promise<ExperienceCandidate>;
  qualify(id: string, options?: OperationOptions): Promise<ExperienceCandidate>;
  promote(id: string, options?: OperationOptions): Promise<CommitMemoryResult>;
  get(id: string, options?: OperationOptions): Promise<ExperienceCandidate | undefined>;
}

export function betaSuccessEstimate(
  experience: Pick<ExperienceCandidate, "successes" | "failures">,
  alpha = 1,
  beta = 1,
): number {
  return (
    (alpha + experience.successes) / (alpha + beta + experience.successes + experience.failures)
  );
}
