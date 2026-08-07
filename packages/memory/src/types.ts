import type {
  EvidenceAuthority,
  EvidenceRef,
  OperationOptions,
  SearchResult,
} from "@pi-mentis/pi-mentis-core";
import type { EmbeddingVector } from "@pi-mentis/pi-mentis-inference";
import type { MaterializedView, ViewKind } from "./views.js";

// ─── Ownership & Relevance Split ─────────────────────────────────

export interface ResourceOwnership {
  readonly tenantId: string | undefined;
  readonly userId: string;
  readonly appId: string | undefined;
  readonly agentId: string | undefined;
}

export type RelevanceScope =
  | { readonly kind: "global" }
  | { readonly kind: "repository"; readonly repositoryId: string }
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "task"; readonly taskId: string }
  | { readonly kind: "topic"; readonly topicId: string }
  | { readonly kind: "session"; readonly sessionId: string };

export interface MentisResourceScope {
  readonly ownership: ResourceOwnership;
  readonly relevance: RelevanceScope;
}

export function ownershipFromContext(ctx?: PiScopeContext): ResourceOwnership {
  return {
    tenantId: ctx?.tenantId,
    userId: ctx?.userId ?? "local",
    appId: ctx?.appId,
    agentId: ctx?.agentId,
  };
}

// ─── Security Mode ────────────────────────────────────────────────

export type MentisSecurityMode = "personal" | "team" | "multi_tenant";

// ─── Access Intent ────────────────────────────────────────────────

export type ResourceAccessIntent =
  "automatic_recall" | "semantic_search" | "explicit_id" | "maintenance";

export interface CrossScopeNotice {
  readonly crossScope: boolean;
  readonly sourceScopeKind?: string;
  readonly sourceScopeLabel?: string;
}

// ─── Sensitivity Classification ───────────────────────────────────

export type Sensitivity = "public" | "internal" | "sensitive" | "secret";

export interface SensitiveClassification {
  readonly sensitivity: Sensitivity;
  readonly categories: readonly string[];
  readonly confidence: number;
}

export type RemoteContentPolicy = "allow" | "redact" | "drop" | "local_only";

export interface RemoteSafeContent {
  readonly originalSensitivity: Sensitivity;
  readonly policy: RemoteContentPolicy;
  readonly text: string | undefined;
  readonly redacted: boolean;
}

// ─── Memory Scope (existing) ──────────────────────────────────────

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

export type TemporalCardinality = "single" | "set" | "ordered" | "event";
export type TemporalState =
  "current" | "historical" | "conflicted" | "retracted" | "pending" | "rejected";
export type BranchClaimState = "global" | "hypothesis" | "verified" | "merged" | "abandoned";

export interface MemoryRecord {
  readonly id: string;
  readonly content: string;
  readonly normalizedContent: string;
  readonly contentHash: string;
  readonly type: MemoryType;
  readonly domain: MemoryDomain;
  readonly scope: MemoryScope;
  readonly scopeContext?: PiScopeContext;
  readonly ownership?: ResourceOwnership;
  readonly relevance?: RelevanceScope;
  readonly sensitivity?: Sensitivity;
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
  readonly factKey?: string;
  readonly cardinality?: TemporalCardinality;
  readonly temporalState?: TemporalState;
  readonly branchClaimState?: BranchClaimState;
  readonly idempotencyKey?: string;
  readonly applicability?: MemoryApplicability;
  readonly premises?: readonly MemoryPremise[];
  readonly contentOrigin?: MemoryContentOrigin;
  readonly evidenceIntegrity?: "valid" | "missing" | "invalid";
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
  readonly factKey?: string;
  readonly cardinality?: TemporalCardinality;
  readonly observedAt?: number;
  readonly retractsFact?: boolean;
  readonly branchClaimState?: BranchClaimState;
  readonly idempotencyKey?: string;
  readonly applicability?: MemoryApplicability;
  readonly premises?: readonly MemoryPremise[];
  readonly contentOrigin?: MemoryContentOrigin;
}

export type MemoryContentOrigin =
  "user" | "workspace" | "tool" | "knowledge" | "external" | "model";

export interface MemoryApplicability {
  readonly os?: readonly string[];
  readonly strictOs?: boolean;
  readonly architecture?: readonly string[];
  readonly strictArchitecture?: boolean;
  readonly runtime?: string;
  readonly runtimeVersionMin?: string;
  readonly runtimeVersionMax?: string;
  readonly packageManager?: string;
  readonly repositoryId?: string;
  readonly projectId?: string;
}

export interface MemoryPremise {
  readonly kind: "manifest" | "tool" | "package-manager" | "context";
  readonly value: string;
  readonly required: boolean;
}

export interface CommitMemoryResult {
  readonly outcome:
    | "created"
    | "reinforced"
    | "corrected"
    | "superseded"
    | "conflict"
    | "rejected"
    | "rejected_sensitive";
  readonly record?: Omit<MemoryRecord, "embedding">;
  readonly relatedIds: readonly string[];
}

export interface MemoryQuery {
  readonly text: string;
  /** Reuses the caller's remote-safe query embedding for dense search. */
  readonly queryEmbedding?: EmbeddingVector;
  readonly scopes?: readonly MemoryScope[];
  readonly scopeContext?: PiScopeContext;
  readonly limit?: number;
  readonly temporalMode?: "current" | "historical" | "all";
  readonly accessIntent?: ResourceAccessIntent;
}

export interface MemorySearchOptions extends OperationOptions {
  readonly timeoutMs?: number;
}

export interface MemoryGetOptions extends OperationOptions {
  readonly scopeContext?: Pick<PiScopeContext, "tenantId" | "userId" | "appId" | "agentId">;
  readonly accessIntent?: ResourceAccessIntent;
  /** Security mode override for access control */
  readonly securityMode?: MentisSecurityMode;
}

export interface MemoryMutationOptions extends OperationOptions {
  readonly scopeContext: Pick<PiScopeContext, "tenantId" | "userId" | "appId" | "agentId">;
}

export interface MemoryService {
  commit(command: CommitMemoryCommand, options?: OperationOptions): Promise<CommitMemoryResult>;
  search(query: MemoryQuery, options?: MemorySearchOptions): Promise<SearchResult>;
  get(id: string, options?: MemoryGetOptions): Promise<Omit<MemoryRecord, "embedding"> | undefined>;
  markConflicted?(
    id: string,
    evidence: EvidenceRef,
    options: MemoryMutationOptions,
  ): Promise<Omit<MemoryRecord, "embedding"> | undefined>;
  tombstone(id: string, options: MemoryMutationOptions): Promise<boolean>;
  temporalHead?(
    factKey: string,
    scope: MemoryScope,
    scopeContext?: PiScopeContext,
  ): Promise<TemporalHead | undefined>;
  repairTemporal?(options?: OperationOptions): Promise<TemporalRepairResult>;
  getView?(
    kind: ViewKind,
    scopeId: string,
    scopeContext?: PiScopeContext,
  ): Promise<MaterializedView | undefined>;
  repairViews?(): Promise<{
    readonly inspected: number;
    readonly repaired: number;
    readonly failed: number;
  }>;
  flushBackground?(): Promise<void>;
  abandonBranch?(branchId: string, scopeContext: PiScopeContext): Promise<number>;
}

export interface TemporalClaimPointer {
  readonly memoryId: string;
  readonly contentHash: string;
  readonly authority: EvidenceAuthority;
  readonly observedAt: number;
  readonly branchId?: string;
}

export interface TemporalHead {
  readonly id: string;
  readonly factKey: string;
  readonly namespace: string;
  readonly cardinality: TemporalCardinality;
  readonly state: "resolved" | "conflicted" | "retracted";
  readonly currentClaims: readonly TemporalClaimPointer[];
  readonly revision: number;
  readonly updatedAt: number;
}

export interface TemporalRepairResult {
  readonly inspected: number;
  readonly repaired: number;
  readonly failed: number;
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
  readonly securityNamespace: string;
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
  readonly securityNamespace: string;
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

export type TaskNodeState = "pending" | "running" | "succeeded" | "failed" | "blocked" | "aborted";

export interface TaskNode {
  readonly id: string;
  readonly namespace: string;
  readonly goal: string;
  readonly state: TaskNodeState;
  readonly dependencies: readonly string[];
  readonly branchId?: string;
  readonly parentId?: string;
  readonly attempts: number;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
}

export interface TaskGraphService {
  create(input: {
    readonly namespace: string;
    readonly goal: string;
    readonly branchId?: string;
    readonly parentId?: string;
    readonly dependencies?: readonly string[];
    readonly id?: string;
  }): Promise<TaskNode>;
  transition(
    id: string,
    next: TaskNodeState,
    evidenceRefs?: readonly EvidenceRef[],
  ): Promise<TaskNode>;
  addDependency(id: string, dependencyId: string): Promise<TaskNode>;
  get(id: string): Promise<TaskNode | undefined>;
  list(namespace: string): Promise<readonly TaskNode[]>;
  abortBranch(branchId: string, namespace: string): Promise<number>;
  mermaid(namespace: string): Promise<string>;
}

export interface ArtifactRecord {
  readonly id: string;
  readonly episodeId: string;
  readonly securityNamespace: string;
  readonly ownership?: ResourceOwnership;
  readonly relevance?: RelevanceScope;
  readonly sourceSessionId?: string;
  readonly sourceToolName?: string;
  readonly eventId?: string;
  readonly toolCallId?: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly contentHash: string;
  readonly relativePath: string;
  readonly state: "pending" | "persisting" | "ready" | "failed" | "expired" | "deleted";
  readonly chunks: readonly ArtifactChunk[];
  readonly expiresAt?: number;
  readonly failure?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly captureIntegrity?: {
    readonly complete: boolean;
    readonly lossy: boolean;
    readonly capturedBytes: number;
    readonly storedBytes: number;
    readonly truncationStage?: "tool" | "host" | "extension" | "unknown";
  };
}

export interface ArtifactChunk {
  readonly ordinal: number;
  readonly relativePath: string;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly contentHash: string;
}

export interface ArtifactSecurityScope {
  readonly tenantId?: string;
  readonly userId: string;
  readonly appId?: string;
  readonly agentId?: string;
  readonly repositoryId?: string;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly scopeKind: "user" | "repository" | "project" | "task" | "session";
  readonly scopeId: string;
}

export interface ArtifactReadOptions extends OperationOptions {
  readonly scopeContext?: PiScopeContext;
  readonly securityScope?: ArtifactSecurityScope;
  readonly offset?: number;
  readonly length?: number;
}

export interface ArtifactQueryHit {
  readonly resourceType: "artifact";
  readonly artifactId: string;
  readonly chunkIndex: number;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly match: "exact" | "lexical";
  readonly content: string;
}

export interface ArtifactRange {
  readonly content: string;
  readonly offset: number;
  readonly nextOffset: number;
  readonly byteLength: number;
  readonly eof: boolean;
}

export interface EvidenceReadOptions extends OperationOptions {
  readonly scopeContext?: PiScopeContext;
  readonly artifactMaxBytes?: number;
}

export interface EvidenceSearchMatch {
  readonly kind: "event" | "artifact";
  readonly id: string;
  readonly text: string;
  readonly artifactOffset?: number;
}

export interface ArtifactCaptureIntegrity {
  readonly complete: boolean;
  readonly lossy: boolean;
  readonly sourceReportedBytes?: number;
  readonly capturedBytes: number;
  readonly truncationStage?: "tool" | "host" | "extension" | "unknown";
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
  readonly captureIntegrity?: ArtifactCaptureIntegrity;
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
  readonly tokenAccounting: ToolResultTokenAccounting;
  readonly artifact?: ArtifactRecord;
}

export interface ToolResultTokenAccounting {
  readonly estimator: "conservative-utf8-v1";
  readonly originalTokens: number;
  readonly retainedTokens: number;
  readonly offloadedTokens: number;
}

export interface PiEvidenceStore {
  createEpisode(episode: PiEpisode, options?: OperationOptions): Promise<void>;
  updateEpisode(episode: PiEpisode, options?: OperationOptions): Promise<void>;
  appendEvent(event: PiEvent, options?: OperationOptions): Promise<void>;
  writeArtifact(
    input: Omit<
      ArtifactRecord,
      | "id"
      | "contentHash"
      | "relativePath"
      | "byteLength"
      | "state"
      | "chunks"
      | "failure"
      | "createdAt"
      | "updatedAt"
      | "securityNamespace"
    > & {
      readonly content: string;
    },
    options?: OperationOptions,
  ): Promise<ArtifactRecord>;
  getEpisode(id: string, options?: EvidenceReadOptions): Promise<PiEpisode | undefined>;
  getEvent(id: string, options?: EvidenceReadOptions): Promise<PiEvent | undefined>;
  getArtifact(id: string, options?: EvidenceReadOptions): Promise<ArtifactRecord | undefined>;
  readArtifact(id: string, options?: ArtifactReadOptions): Promise<string | undefined>;
  readArtifactRange(id: string, options?: ArtifactReadOptions): Promise<ArtifactRange | undefined>;
  recoverArtifacts(options?: OperationOptions): Promise<{
    readonly inspected: number;
    readonly recovered: number;
    readonly failed: number;
  }>;
  deleteArtifact(id: string, options?: ArtifactReadOptions): Promise<boolean>;
  collectExpiredArtifacts(now?: number, options?: OperationOptions): Promise<number>;
  readEvidence(
    refs: readonly EvidenceRef[],
    options?: EvidenceReadOptions,
  ): Promise<readonly unknown[]>;
  searchEvidence(
    refs: readonly EvidenceRef[],
    query: string,
    options?: EvidenceReadOptions,
  ): Promise<readonly EvidenceSearchMatch[]>;
}

export interface ExperienceCandidate {
  readonly id: string;
  readonly goal: string;
  readonly scopeContext?: PiScopeContext;
  readonly branchClaimState?: BranchClaimState;
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
