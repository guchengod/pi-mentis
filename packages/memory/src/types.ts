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

/** V2 records are assertions, not members of a semantic class hierarchy. */
export type MemorySchemaVersion = 2;
export type EpistemicState = "asserted" | "verified" | "hypothesis";
export type MemoryRelationship =
  "reinforce" | "supersede" | "retract" | "conflict" | "coexist" | "unrelated" | "uncertain";

export type PairwiseIdentityDecision = "same" | "different" | "uncertain";

/** Pairwise identity is evidence about two concrete assertions, never a memory category. */
export interface PairwiseIdentityEvidence {
  readonly referent: PairwiseIdentityDecision;
  readonly attribute: PairwiseIdentityDecision;
  readonly value: PairwiseIdentityDecision;
}

/** Optional, non-authoritative structure extracted while comparing two memories. */
export interface MemorySemanticHints {
  readonly subjectHint?: string;
  readonly relationHint?: string;
  readonly valueHint?: string;
}

/**
 * Positive pairwise signals. They describe a relationship between two concrete
 * records; they are not a class assigned to either memory.
 */
export interface PairwiseRelationshipSignals {
  readonly identityEvidence: PairwiseIdentityEvidence;
  /** Legacy proposal fields are retained only for trace compatibility. Gates ignore them. */
  readonly sameReferent?: boolean;
  readonly sameAttribute?: boolean;
  readonly explicitNewAssertion: boolean;
  readonly explicitRetraction: boolean;
  /** A concrete new value is installed in place of the older value. */
  readonly replacementValuePresent: boolean;
  readonly compatibleValue: boolean;
  readonly incompatibleValue: boolean;
  readonly mutuallyExclusive: boolean;
}

export interface MemoryRelationshipEvidence {
  /** The model proposal, including safe/non-mutating outcomes retained for audit. */
  readonly relation: MemoryRelationship;
  readonly targetIds: readonly string[];
  readonly confidence: number;
  readonly reasonCodes: readonly string[];
  readonly source?: "explicit_internal" | "same_turn_recall" | "background_consolidation";
  readonly signals?: PairwiseRelationshipSignals;
  readonly proposalRelationship?: MemoryRelationship;
  readonly proposalConfidence?: number;
  readonly gateName?: "reinforceGate" | "supersedeGate" | "retractGate" | "conflictGate";
  readonly gateAccepted?: boolean;
  readonly gateRejectReasons?: readonly string[];
  readonly incomingHints?: MemorySemanticHints;
  readonly targetHints?: Readonly<Record<string, MemorySemanticHints>>;
}

export interface MemoryProvenance {
  readonly origin: "user" | "workspace" | "tool" | "knowledge" | "external" | "model";
  readonly epistemicState: EpistemicState;
  readonly branchId?: string;
  /** Only true for a speculative assertion whose lifetime is the branch. */
  readonly branchLocal?: boolean;
}

export interface MemoryRelationships {
  readonly reinforcesIds: readonly string[];
  readonly supersedesIds: readonly string[];
  readonly retractsIds: readonly string[];
  readonly conflictsWithIds: readonly string[];
  readonly coexistsWithIds: readonly string[];
}

export interface OrderedMemoryItem {
  readonly position: number;
  readonly value: string;
}

/** Deterministic runtime constraints only; unknown values fail open at recall. */
export interface RuntimeConstraints {
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

export interface RecallPrerequisite {
  readonly kind: "manifest" | "tool" | "package-manager";
  readonly value: string;
  readonly required: boolean;
}

export interface MemoryDecisionTrace {
  readonly id: string;
  readonly incomingId: string;
  readonly candidateIds: readonly string[];
  readonly relationDecision: MemoryRelationship;
  readonly confidence: number;
  readonly reasonCodes: readonly string[];
  readonly signals?: PairwiseRelationshipSignals;
  readonly proposalRelationship?: MemoryRelationship;
  readonly proposalConfidence?: number;
  readonly gateName?: string;
  readonly gateAccepted?: boolean;
  readonly gateRejectReasons?: readonly string[];
  readonly incomingHints?: MemorySemanticHints;
  readonly targetHints?: Readonly<Record<string, MemorySemanticHints>>;
  readonly temporalAction: string;
  readonly temporalPreState?: Readonly<Record<string, string>>;
  readonly temporalPostState?: Readonly<Record<string, string>>;
  readonly operationKey?: string;
  readonly recoveryReason?: RelationshipRecoveryReason;
  readonly timestamp: number;
}

export type RelationshipLearningState =
  "pending" | "processing" | "resolved" | "failed_retryable" | "failed_terminal";

export type RelationshipRecoveryReason =
  "normal" | "retry" | "startup_reconciliation" | "lease_recovery";

export interface RelationshipLearningCandidate {
  readonly id: string;
  readonly source: "same_turn_recall" | "semantic_candidate";
}

export interface RelationshipLearningWork {
  readonly incomingId: string;
  readonly namespace: string;
  readonly state: RelationshipLearningState;
  readonly candidates: readonly RelationshipLearningCandidate[];
  readonly scopeContext: PiScopeContext;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly updatedAt: number;
  readonly nextRetryAt?: number;
  readonly processingOwner?: string;
  readonly processingStartedAt?: number;
  readonly leaseExpiresAt?: number;
  readonly lastError?: string;
  readonly operationKeys: readonly string[];
  readonly recoveryReason?: RelationshipRecoveryReason;
}

/** Old metadata is quarantined here for read compatibility and diagnosis only. */
export interface LegacyMemoryMetadata {
  readonly predicate?: string;
  readonly type?: string;
  readonly domain?: string;
  readonly cardinality?: string;
  readonly factKey?: string;
  readonly semanticKey?: string;
  readonly memberFactKey?: string;
  readonly setMemberKey?: string;
  readonly branchClaimState?: string;
  readonly temporalState?: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface MemoryRecord {
  readonly schemaVersion: MemorySchemaVersion;
  readonly id: string;
  readonly content: string;
  readonly normalizedContent: string;
  readonly contentHash: string;
  readonly scope: MemoryScope;
  readonly scopeContext?: PiScopeContext;
  readonly ownership?: ResourceOwnership;
  readonly relevance?: RelevanceScope;
  readonly sensitivity?: Sensitivity;
  readonly confidence: number;
  readonly importance: number;
  readonly authority: EvidenceAuthority;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly relationships: MemoryRelationships;
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
  /** Last time the exact assertion was reinforced. */
  readonly lastReinforcedAt?: number;
  readonly revision: number;
  readonly idempotencyKey?: string;
  readonly runtimeConstraints?: RuntimeConstraints;
  readonly recallPrerequisites?: readonly RecallPrerequisite[];
  readonly provenance: MemoryProvenance;
  readonly evidenceIntegrity?: "valid" | "missing" | "invalid";
  readonly orderedItems?: readonly OrderedMemoryItem[];
  /** Best-effort pairwise structure. It never controls whether this record is saved. */
  readonly semanticHints?: MemorySemanticHints;
  /**
   * Temporal kind: "current" for ongoing facts, "event" for episodic
   * occurrences that happened at a specific point in time.
   */
  readonly temporalKind?: "current" | "event";
  /**
   * When this fact's event occurred (episodic records). Distinct from
   * observedAt/createdAt which record the write time.
   */
  readonly occurredAt?: number;
  /**
   * Set/ordered record written without a usable member identity. Such records
   * must never block (or be blocked by) properly keyed set members.
   */
  readonly decisionTraceId?: string;
  /** Durable recovery marker for asynchronous pairwise relationship learning. */
  readonly relationshipLearningState?: RelationshipLearningState;
  readonly relationshipLearningUpdatedAt?: number;
  readonly relationshipLearningAttempts?: number;
  readonly relationshipCandidateIds?: readonly string[];
  readonly relationshipDecisionTraceId?: string;
  readonly legacy?: LegacyMemoryMetadata;
  /** Last automatic resolution outcome for a conflicted candidate. */
  readonly conflictResolution?: Readonly<{
    readonly at: number;
    readonly action: "activated" | "remains";
  }>;
}

export interface CommitMemoryCommand {
  readonly content: string;
  readonly scope: MemoryScope;
  readonly scopeContext?: PiScopeContext;
  readonly confidence?: number;
  readonly importance?: number;
  readonly authority: EvidenceAuthority;
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly observedAt?: number;
  readonly idempotencyKey?: string;
  readonly runtimeConstraints?: RuntimeConstraints;
  readonly recallPrerequisites?: readonly RecallPrerequisite[];
  readonly provenance?: MemoryProvenance;
  /** Precomputed content embedding (reused from scope planning — avoids a second remote call). */
  readonly embedding?: EmbeddingVector;
  readonly orderedItems?: readonly OrderedMemoryItem[];
  /** Temporal kind: "current" or "event". */
  readonly temporalKind?: "current" | "event";
  /** When an episodic event occurred. */
  readonly occurredAt?: number;
  /** Internal, source-backed evidence. This is deliberately not part of the public tool schema. */
  readonly relationshipEvidence?: MemoryRelationshipEvidence;
  /** Optional structure produced together with relationship evidence. */
  readonly semanticHints?: MemorySemanticHints;
  /** Concrete pair candidates known before raw persistence; never part of the public tool schema. */
  readonly relationshipCandidates?: readonly RelationshipLearningCandidate[];
}

export type MemoryContentOrigin =
  "user" | "workspace" | "tool" | "knowledge" | "external" | "model";

/** @deprecated Legacy read shape. New records use RuntimeConstraints. */
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

/** @deprecated Legacy read shape. New records use RecallPrerequisite. */
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
    | "rejected_sensitive"
    | "retracted";
  readonly record?: Omit<MemoryRecord, "embedding">;
  readonly relatedIds: readonly string[];
  readonly relationDecision: MemoryRelationship;
  readonly traceId?: string;
  readonly relationshipCandidateIds?: readonly string[];
}

export interface RelationshipConsolidationResult {
  readonly action: "applied" | "skipped";
  readonly incomingId: string;
  readonly targetIds: readonly string[];
  readonly relationDecision: MemoryRelationship;
  readonly reason: string;
  readonly traceId?: string;
  readonly operationKey?: string;
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
  /**
   * When false, reuse an existing query vector if available and otherwise run
   * the local FTS lane only. Automatic recall uses this to keep network calls
   * out of Pi's message-send path; explicit search keeps the default behavior.
   */
  readonly allowRemoteEmbedding?: boolean;
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
  /** Applies reviewed pairwise evidence to an already persisted raw memory. */
  consolidateRelationship?(
    incomingId: string,
    evidence: MemoryRelationshipEvidence,
    options: MemoryMutationOptions,
  ): Promise<RelationshipConsolidationResult>;
  prepareRelationshipLearning?(
    incomingId: string,
    candidates: readonly RelationshipLearningCandidate[],
    options: MemoryMutationOptions,
  ): Promise<RelationshipLearningWork | undefined>;
  claimRelationshipLearning?(
    incomingId: string,
    input: {
      readonly owner: string;
      readonly leaseMs: number;
      readonly recoveryReason: RelationshipRecoveryReason;
    },
    options: MemoryMutationOptions,
  ): Promise<RelationshipLearningWork | undefined>;
  resolveRelationshipLearning?(
    incomingId: string,
    operationKeys: readonly string[],
    options: MemoryMutationOptions,
  ): Promise<RelationshipLearningWork | undefined>;
  failRelationshipLearning?(
    incomingId: string,
    error: unknown,
    options: MemoryMutationOptions,
  ): Promise<RelationshipLearningWork | undefined>;
  listRecoverableRelationshipLearning?(input?: {
    readonly limit?: number;
    readonly now?: number;
  }): Promise<readonly RelationshipLearningWork[]>;
  listPendingRelationshipLearning?(input?: {
    readonly limit?: number;
    readonly scopeContext?: Pick<PiScopeContext, "tenantId" | "userId" | "appId" | "agentId">;
  }): Promise<readonly RelationshipLearningWork[]>;
  getRelationshipLearning?(incomingId: string): Promise<RelationshipLearningWork | undefined>;
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
  diagnoseLegacyMemory?(
    id: string,
    options?: OperationOptions,
  ): Promise<
    | {
        readonly id: string;
        readonly legacy: boolean;
        readonly rawContent: string;
        readonly currentStatus: string;
        readonly legacyMetadata?: LegacyMemoryMetadata;
        readonly candidateRelationshipToV2: MemoryRelationship;
        readonly migrationConfidence: number;
        readonly migrationSafe: boolean;
      }
    | undefined
  >;
  /** Internal debug/migration: diagnose the ownership scope of a stored memory. */
  diagnoseMemoryScope?(
    id: string,
    options?: OperationOptions,
  ): Promise<
    | {
        readonly id: string;
        readonly currentScope: MemoryScope;
        readonly recommendedScope: MemoryScope;
        readonly confidence: number;
        readonly reason: string;
      }
    | undefined
  >;
  /** Internal debug/migration: rewrite a stored memory into its recommended ownership scope. */
  repairMemoryScope?(
    id: string,
    options?: OperationOptions,
  ): Promise<
    | {
        readonly id: string;
        readonly action: "unchanged" | "repaired" | "not_found";
        readonly fromScope?: MemoryScope;
        readonly toScope?: MemoryScope;
        readonly reason: string;
      }
    | undefined
  >;
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
  readonly captureIntegrity?: ArtifactCaptureIntegrity;
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
  readonly estimator: "approximate-model-v1" | "conservative-utf8-v1";
  readonly originalTokens: number;
  readonly modelVisibleTokens?: number;
  readonly avoidedModelTokens?: number;
  /** @deprecated Compatibility alias for modelVisibleTokens. */
  readonly retainedTokens: number;
  /** @deprecated Compatibility alias for avoidedModelTokens. */
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
