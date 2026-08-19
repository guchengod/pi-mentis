import { stat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { arch, homedir, platform, setPriority } from "node:os";
import path from "node:path";

import {
  BackgroundScheduler,
  EvidenceAuthority,
  MentisContextResolver,
  TaskPriority,
  getEmbeddingRuntimeResolution,
  getStorageStatus,
  estimateModelTokens,
  loadConfig,
  inferInteractionMode,
  operationId,
  stableHash,
  type MentisContextSnapshot,
  type PiMentisConfig,
} from "@pi-mentis/pi-mentis-core";
import type { EmbeddingSpaceIdentity } from "@pi-mentis/pi-mentis-inference";
import { createKnowledgeService, type KnowledgeService } from "@pi-mentis/pi-mentis-knowledge-core";
import {
  ContextStateService,
  MemoryCandidateService,
  TaskEpisodeService,
  WorkingMemoryService,
  DefaultRememberCoordinator,
  DurableRelationshipLearningCoordinator,
  MentisBackgroundQueue,
  PiCaptureSession,
  ProjectIdentityCache,
  ScopeSemanticPlanner,
  createExperienceLearningService,
  createMemoryService,
  createPiEvidenceStore,
  createTaskGraphService,
  deriveTaskEpisodeExperienceObservation,
  buildCandidateCognitionInput,
  candidateObservationSource,
  createTaskEpisodeDigest,
  detectMemoryCandidateTrigger,
  toRemoteSafe,
  parseEpisodeConsolidationProposal,
  parseMemoryCandidateProposals,
  securityNamespaceForScope,
  validateConsolidationEvidence,
  referencedMemoryIds,
  type MemoryService,
  type PairwiseRelationshipJudgment,
  type PairwiseRelationshipReasoner,
  type PiProjectIdentity,
  type PiScopeContext,
  type RelationshipLearningWork,
  type RecalledMemoryEvidence,
  type CandidateEvidence,
  type OutcomeStatus,
  type PiEpisode,
  type PiEvent,
  type TaskEpisode,
  type WorkingMemoryState,
} from "@pi-mentis/pi-mentis-memory-core";
import { InMemoryTelemetry } from "@pi-mentis/pi-mentis-observability";
import {
  CurrentTurnRecallGuard,
  RecentAssertionOverlay,
  projectDurablePendingAssertions,
  type PublicRecallResult,
  type PublicRememberResult,
} from "@pi-mentis/pi-mentis-pi-extension-support";
import { CapabilityIndexer, scanPiInstallation } from "@pi-mentis/pi-mentis-pi-capabilities";
import {
  AdaptivePolicyService,
  DefaultRecallCoordinator,
  EffectivenessService,
  createRetrievalService,
  evaluateReplayCandidate,
  type RetrievalService,
} from "@pi-mentis/pi-mentis-retrieval";
import {
  SiliconFlowEmbeddingProvider,
  SiliconFlowRerankProvider,
} from "@pi-mentis/pi-mentis-siliconflow";
import {
  acquireSharedZvecStore,
  resetSharedStores,
  type SharedZvecStoreHandle,
} from "@pi-mentis/pi-mentis-zvec";

import { capsuleEntry } from "./capsule.js";
import {
  SIDECAR_PROTOCOL_VERSION,
  type MemoryCapsule,
  type SessionOpenResult,
  type SidecarEventMessage,
  type SidecarNotification,
  type SidecarRequest,
} from "./sidecar-protocol.js";
import { consumeToolResultSpool } from "./tool-result-spool.js";

type EventSender = (event: SidecarEventMessage["event"]) => void;

interface TurnExecutionContext {
  readonly namespace: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly branchGeneration: number;
  readonly taskId?: string;
  readonly taskGeneration: number;
  readonly topicIds: readonly string[];
  readonly contextSnapshotId?: string;
  readonly episodeId: string;
  readonly scopeContext: PiScopeContext;
}

interface SidecarSession {
  scopeContext: PiScopeContext;
  branchGeneration: number;
  taskGeneration: number;
  closed: boolean;
  readonly cwd: string;
  readonly mode: MentisContextSnapshot["conversation"]["sessionMode"];
  readonly identity: PiProjectIdentity;
  contextSnapshot?: MentisContextSnapshot;
  capture?: PiCaptureSession;
  queue: Promise<void>;
  capsule?: MemoryCapsule;
  capsuleRevision: number;
  latestTraceId?: string;
  lastPrompt?: string;
  readonly recallGuard: CurrentTurnRecallGuard;
  readonly recentAssertions: RecentAssertionOverlay;
  readonly recentProcedureMemoryIds: Set<string>;
  readonly finishedTurns: Array<{
    readonly episode: PiEpisode;
    readonly events: readonly PiEvent[];
    readonly outcome: OutcomeStatus;
    readonly executionContext: TurnExecutionContext;
  }>;
  readonly turnContexts: Map<string, TurnExecutionContext>;
  readonly backgroundJobIds: Set<string>;
  workingMemory?: WorkingMemoryState;
  taskEpisode?: TaskEpisode;
}

interface ReasonRequest {
  readonly resolve: (value: PairwiseRelationshipJudgment) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface CognitionRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly removeAbortListener: () => void;
  readonly clientSessionId: string;
}

interface CognitiveTelemetry {
  workingMemoryVisibleTokens: number;
  activeContextVisibleTokens: number;
  capsuleVisibleTokens: number;
  combinedRecallTokens: number;
  foregroundContextSavedTokens: number;
  candidateInputTokens: number;
  candidateOutputTokens: number;
  consolidationInputTokens: number;
  consolidationOutputTokens: number;
  candidateTriggerCount: number;
  candidateCognitionCount: number;
  candidateProposed: number;
  candidateAccepted: number;
  candidatesCreated: number;
  candidatesPromoted: number;
  candidatesRejected: number;
  candidateRejectedGrounding: number;
  candidateRejectedScope: number;
  candidateRejectedSensitivity: number;
  consolidationRuns: number;
  semanticAssertionsProposed: number;
  semanticAssertionsPromoted: number;
  procedureObservations: number;
  procedureQualified: number;
  procedurePromoted: number;
  procedureRecallCount: number;
  procedureAppliedCount: number;
  procedureSuccessAfterRecall: number;
  procedureFailureAfterRecall: number;
  cognitionFailures: number;
  cognitionCancellations: number;
  cognitionDiscards: number;
}

function embeddingSpace(config: PiMentisConfig): EmbeddingSpaceIdentity {
  return {
    providerId: "siliconflow",
    modelId: config.inference.siliconflow.embedding.model,
    dimensions: config.inference.siliconflow.embedding.dimensions,
    normalization: "none",
    preprocessingVersion: "pi-mentis-text-v1",
    inputKindVersion: "pi-mentis-input-kind-v1",
  };
}

function generationSpaces(config: PiMentisConfig) {
  const identity = embeddingSpace(config);
  return { knowledge: identity, memory: identity, capability: identity } as const;
}

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function parseReasonJudgment(text: string): PairwiseRelationshipJudgment {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const root = object(JSON.parse(candidate));
  const signals = object(root?.["signals"]);
  const identity = object(signals?.["identityEvidence"]);
  const relation = root?.["relation"];
  const confidence = root?.["confidence"];
  const relations = new Set([
    "reinforce",
    "supersede",
    "retract",
    "conflict",
    "coexist",
    "unrelated",
    "uncertain",
  ]);
  const identities = new Set(["same", "different", "uncertain"]);
  if (
    typeof relation !== "string" ||
    !relations.has(relation) ||
    typeof confidence !== "number" ||
    signals === undefined ||
    identity === undefined ||
    !identities.has(String(identity["referent"])) ||
    !identities.has(String(identity["attribute"])) ||
    !identities.has(String(identity["value"]))
  ) {
    throw new Error("Sidecar relationship reasoner returned invalid JSON");
  }
  const boolean = (name: string) => signals[name] === true;
  const hints = (name: string) => {
    const value = object(root?.[name]);
    if (value === undefined) return undefined;
    const result = {
      ...(typeof value["subjectHint"] === "string"
        ? { subjectHint: value["subjectHint"].slice(0, 200) }
        : {}),
      ...(typeof value["relationHint"] === "string"
        ? { relationHint: value["relationHint"].slice(0, 200) }
        : {}),
      ...(typeof value["valueHint"] === "string"
        ? { valueHint: value["valueHint"].slice(0, 500) }
        : {}),
    };
    return Object.keys(result).length === 0 ? undefined : result;
  };
  const incomingHints = hints("incomingHints");
  const targetHints = hints("targetHints");
  return {
    relation: relation as PairwiseRelationshipJudgment["relation"],
    confidence: Math.max(0, Math.min(1, confidence)),
    signals: {
      identityEvidence: {
        referent: String(identity["referent"]) as "same" | "different" | "uncertain",
        attribute: String(identity["attribute"]) as "same" | "different" | "uncertain",
        value: String(identity["value"]) as "same" | "different" | "uncertain",
      },
      explicitNewAssertion: boolean("explicitNewAssertion"),
      explicitRetraction: boolean("explicitRetraction"),
      replacementValuePresent: boolean("replacementValuePresent"),
      compatibleValue: boolean("compatibleValue"),
      incompatibleValue: boolean("incompatibleValue"),
      mutuallyExclusive: boolean("mutuallyExclusive"),
    },
    ...(incomingHints === undefined ? {} : { incomingHints }),
    ...(targetHints === undefined ? {} : { targetHints }),
    reasonCodes: Array.isArray(root?.["reasonCodes"])
      ? root["reasonCodes"]
          .filter((value): value is string => typeof value === "string")
          .slice(0, 8)
      : [],
  };
}

async function knowledgeSource(target: string) {
  if (/^https?:\/\//u.test(target)) return { kind: "url" as const, url: target };
  try {
    if ((await stat(target)).isDirectory()) return { kind: "directory" as const, path: target };
  } catch {
    // The knowledge job returns the actionable path error.
  }
  return { kind: "file" as const, path: target };
}

export class MentisSidecarRuntime {
  readonly #sendEvent: EventSender;
  readonly #sessions = new Map<string, SidecarSession>();
  readonly #reasonRequests = new Map<string, ReasonRequest>();
  readonly #cognitionRequests = new Map<string, CognitionRequest>();
  readonly #cognitiveTelemetry: CognitiveTelemetry = {
    workingMemoryVisibleTokens: 0,
    activeContextVisibleTokens: 0,
    capsuleVisibleTokens: 0,
    combinedRecallTokens: 0,
    foregroundContextSavedTokens: 0,
    candidateInputTokens: 0,
    candidateOutputTokens: 0,
    consolidationInputTokens: 0,
    consolidationOutputTokens: 0,
    candidateTriggerCount: 0,
    candidateCognitionCount: 0,
    candidateProposed: 0,
    candidateAccepted: 0,
    candidatesCreated: 0,
    candidatesPromoted: 0,
    candidatesRejected: 0,
    candidateRejectedGrounding: 0,
    candidateRejectedScope: 0,
    candidateRejectedSensitivity: 0,
    consolidationRuns: 0,
    semanticAssertionsProposed: 0,
    semanticAssertionsPromoted: 0,
    procedureObservations: 0,
    procedureQualified: 0,
    procedurePromoted: 0,
    procedureRecallCount: 0,
    procedureAppliedCount: 0,
    procedureSuccessAfterRecall: 0,
    procedureFailureAfterRecall: 0,
    cognitionFailures: 0,
    cognitionCancellations: 0,
    cognitionDiscards: 0,
  };
  readonly #pendingRelationships = new Map<
    string,
    Array<{
      readonly work: RelationshipLearningWork;
      readonly reasoner: PairwiseRelationshipReasoner;
      readonly onResolved: (incomingId: string) => void;
    }>
  >();
  readonly #projectIdentity = new ProjectIdentityCache({ ttlMs: 30_000 });
  readonly #contextResolver = new MentisContextResolver();
  #config: PiMentisConfig | undefined;
  #scheduler: BackgroundScheduler | undefined;
  #storeHandle: SharedZvecStoreHandle | undefined;
  #embedding: SiliconFlowEmbeddingProvider | undefined;
  #knowledge: KnowledgeService | undefined;
  #memory: MemoryService | undefined;
  #retrieval: RetrievalService | undefined;
  #contextState: ContextStateService | undefined;
  #effectiveness: EffectivenessService | undefined;
  #policy: AdaptivePolicyService | undefined;
  #remember: DefaultRememberCoordinator | undefined;
  #experience: ReturnType<typeof createExperienceLearningService> | undefined;
  #workingMemory: WorkingMemoryService | undefined;
  #candidates: MemoryCandidateService | undefined;
  #taskEpisodes: TaskEpisodeService | undefined;
  #recall: DefaultRecallCoordinator | undefined;
  #relationshipQueue: MentisBackgroundQueue | undefined;
  #relationships: DurableRelationshipLearningCoordinator | undefined;
  #maintenanceScheduled = false;
  #relationshipRecoveryPending = true;
  #piPackageRoot: string | undefined;
  #closed = false;
  #initialization: Promise<{ readonly ready: true; readonly protocolVersion: 1 }> | undefined;

  constructor(sendEvent: EventSender) {
    this.#sendEvent = sendEvent;
  }

  async request(request: SidecarRequest): Promise<unknown> {
    if (request.method === "initialize")
      return this.initialize(request.params.cwd, request.params.piPackageRoot);
    this.#assertReady();
    if (request.method === "session.open") return this.#openSession(request.params);
    if (request.method === "memory.remember") return this.#rememberMemory(request.params);
    if (request.method === "memory.recall") return this.#recallMemory(request.params);
    if (request.method === "capture.toolResult")
      return this.#captureToolResult(request.params.clientSessionId, request.params.envelope);
    if (request.method === "capture.toolResultSpool")
      return this.#captureToolResultSpool(request.params);
    if (request.method === "knowledge.command") return this.#knowledgeCommand(request.params);
    if (request.method === "status") return this.#status(request.params.clientSessionId);
    if (request.method === "shutdown") {
      await this.close();
      return { closed: true };
    }
    throw new Error(`Unknown Mentis sidecar method: ${(request as { method: string }).method}`);
  }

  notify(notification: SidecarNotification): void {
    if (notification.method === "shutdown") {
      void this.close();
      return;
    }
    if (notification.method === "reason.response") {
      this.#resolveReason(notification.params);
      return;
    }
    if (notification.method === "cognition.response") {
      this.#resolveCognition(notification.params);
      return;
    }
    const session = this.#sessions.get(notification.params.clientSessionId);
    if (session === undefined) return;
    if (notification.method === "foreground.savings") {
      this.#cognitiveTelemetry.foregroundContextSavedTokens += Math.max(
        0,
        notification.params.avoidedModelTokens,
      );
      return;
    }
    if (notification.method === "foreground.tokens") {
      this.#cognitiveTelemetry.activeContextVisibleTokens =
        notification.params.activeContextVisibleTokens;
      this.#cognitiveTelemetry.capsuleVisibleTokens = notification.params.capsuleVisibleTokens;
      this.#cognitiveTelemetry.combinedRecallTokens = notification.params.combinedRecallTokens;
      return;
    }
    if (notification.method === "session.branch") {
      if (notification.params.branchGeneration <= session.branchGeneration) return;
      const previousBranchId = session.scopeContext.branchId ?? "root";
      session.branchGeneration = notification.params.branchGeneration;
      this.#cancelReasonRequests(
        "Pi branch generation changed",
        notification.params.clientSessionId,
      );
      const branchGeneration = session.branchGeneration;
      this.#enqueueSession(session, async () => {
        if (session.closed || session.branchGeneration !== branchGeneration) return;
        const { parentBranchId: _previousParentBranchId, ...scopeWithoutParent } =
          session.scopeContext;
        void _previousParentBranchId;
        session.scopeContext = {
          ...scopeWithoutParent,
          branchId: notification.params.branchId,
          ...(notification.params.parentBranchId === undefined
            ? {}
            : { parentBranchId: notification.params.parentBranchId }),
        };
        await this.#switchWorkingMemoryBranch(
          notification.params.clientSessionId,
          previousBranchId,
          notification.params.branchId,
          branchGeneration,
          notification.params.parentBranchId,
        );
      });
      return;
    }
    if (notification.method === "input.activity") {
      this.#cancelReasonRequests("New Pi input arrived", notification.params.clientSessionId);
      session.recallGuard.beginTurn();
      session.recentProcedureMemoryIds.clear();
      return;
    }
    if (notification.method === "session.close") {
      void this.#closeSession(notification.params.clientSessionId);
      return;
    }
    if (notification.method === "capture.start") {
      session.lastPrompt = notification.params.goal;
      const requestedScope: PiScopeContext = Object.freeze({
        ...notification.params.scope,
        ...(notification.params.scope.topicIds === undefined
          ? {}
          : { topicIds: Object.freeze([...notification.params.scope.topicIds]) }),
      });
      const requestedBranchGeneration = session.branchGeneration;
      this.#enqueueSession(session, async () => {
        if (
          !session.closed &&
          session.branchGeneration === requestedBranchGeneration &&
          (session.scopeContext.branchId ?? "root") === (requestedScope.branchId ?? "root")
        ) {
          await this.#refreshContext(
            notification.params.clientSessionId,
            notification.params.goal,
            {
              branchId: requestedScope.branchId ?? "root",
              branchGeneration: requestedBranchGeneration,
            },
          ).catch(() => undefined);
        }
        const sameBranch =
          session.branchGeneration === requestedBranchGeneration &&
          (session.scopeContext.branchId ?? "root") === (requestedScope.branchId ?? "root");
        const scopeContext: PiScopeContext = Object.freeze({
          ...requestedScope,
          ...(sameBranch && session.scopeContext.taskId !== undefined
            ? { taskId: session.scopeContext.taskId }
            : {}),
          ...(sameBranch
            ? { topicIds: Object.freeze([...(session.scopeContext.topicIds ?? [])]) }
            : {}),
          ...(sameBranch && session.contextSnapshot?.id !== undefined
            ? { contextSnapshotId: session.contextSnapshot.id }
            : {}),
        });
        const capture = this.#captureFor(session);
        const episode = await capture.start({
          goal: notification.params.goal,
          scope: scopeContext,
        });
        const executionContext: TurnExecutionContext = Object.freeze({
          namespace: securityNamespaceForScope(scopeContext),
          sessionId: scopeContext.sessionId ?? episode.sessionId,
          branchId: scopeContext.branchId ?? episode.branchId ?? "root",
          branchGeneration: requestedBranchGeneration,
          ...(scopeContext.taskId === undefined ? {} : { taskId: scopeContext.taskId }),
          taskGeneration: session.taskGeneration,
          topicIds: Object.freeze([...(scopeContext.topicIds ?? [])]),
          ...(scopeContext.contextSnapshotId === undefined
            ? {}
            : { contextSnapshotId: scopeContext.contextSnapshotId }),
          episodeId: episode.id,
          scopeContext,
        });
        session.turnContexts.set(episode.id, executionContext);
      });
      return;
    }
    if (notification.method === "capture.steer") {
      session.taskGeneration++;
      this.#enqueueSession(session, () =>
        this.#captureFor(session).steer(notification.params.goal),
      );
      return;
    }
    if (notification.method === "capture.toolStarted") {
      this.#enqueueSession(session, () =>
        this.#captureFor(session).toolStarted(
          notification.params.toolCallId,
          notification.params.toolName,
          notification.params.input,
        ),
      );
      return;
    }
    if (notification.method === "capture.toolResult") {
      this.#enqueueSession(session, async () => {
        await this.#captureFor(session).toolResult(notification.params.envelope);
      });
      return;
    }
    if (notification.method === "capture.toolResults") {
      this.#enqueueSession(session, async () => {
        const capture = this.#captureFor(session);
        for (const envelope of notification.params.envelopes) {
          await capture.toolResult(envelope);
        }
      });
      return;
    }
    if (notification.method === "capture.compact") {
      this.#enqueueSession(session, async () => {
        await this.#captureFor(session).compact(
          notification.params.summary,
          notification.params.reason,
          notification.params.willRetry,
        );
        if (session.workingMemory !== undefined) {
          await this.#workingMemory?.checkpoint(session.workingMemory).catch(() => undefined);
        }
        if (session.taskEpisode !== undefined) {
          await this.#taskEpisodes?.checkpoint(session.taskEpisode).catch(() => undefined);
        }
      });
      return;
    }
    if (notification.method === "agent.settled") {
      session.lastPrompt = notification.params.prompt;
      this.#enqueueSession(session, async () => {
        await session.capture?.finish();
      });
      void this.#settleSession(notification.params.clientSessionId, notification.params.prompt);
    }
  }

  async initialize(
    cwd: string,
    piPackageRoot: string,
  ): Promise<{ readonly ready: true; readonly protocolVersion: 1 }> {
    if (this.#memory !== undefined) return { ready: true, protocolVersion: 1 };
    if (this.#closed) throw new Error("Mentis sidecar is closed");
    if (this.#initialization !== undefined) return this.#initialization;
    const initialization = this.#initialize(cwd, piPackageRoot).catch((error) => {
      this.#initialization = undefined;
      throw error;
    });
    this.#initialization = initialization;
    return initialization;
  }

  async #initialize(
    cwd: string,
    piPackageRoot: string,
  ): Promise<{ readonly ready: true; readonly protocolVersion: 1 }> {
    const config = await loadConfig(cwd);
    try {
      setPriority(process.pid, config.performance.sidecar.cpuNice);
    } catch (error) {
      this.#sendEvent({
        name: "warning",
        message: `Mentis sidecar could not lower CPU priority: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
    const scheduler = new BackgroundScheduler(config.performance.queue);
    const telemetry = new InMemoryTelemetry();
    const embedding = new SiliconFlowEmbeddingProvider(config.inference.siliconflow);
    const reranker = new SiliconFlowRerankProvider(config.inference.siliconflow);
    const storeHandle = await acquireSharedZvecStore(config.storage, generationSpaces(config));
    const scopePlanner = new ScopeSemanticPlanner({
      embedding,
      dimensions: config.inference.siliconflow.embedding.dimensions,
    });
    const knowledge = createKnowledgeService({
      store: storeHandle.store,
      embedding,
      embeddingSpace: embeddingSpace(config),
      dimensions: config.inference.siliconflow.embedding.dimensions,
      limits: config.performance.resources,
      scheduler,
      telemetry,
      defaultNamespace: config.knowledge.defaultNamespace,
      queryCacheEntries: config.inference.embedding.queryCacheEntries,
      queryCacheTtlMs: config.inference.embedding.queryCacheTtlMs,
      jobConcurrency: config.performance.sidecar.knowledgeJobConcurrency,
    });
    const memory = createMemoryService({
      store: storeHandle.store,
      embedding,
      embeddingSpace: embeddingSpace(config),
      dimensions: config.inference.siliconflow.embedding.dimensions,
      telemetry,
      viewsEnabled: config.intelligence.views.enabled,
      viewTtlMs: config.intelligence.views.ttlMs,
      scopePlanner,
    });
    const effectiveness = config.intelligence.effectiveness.enabled
      ? new EffectivenessService(storeHandle.store, {
          flushIntervalMs: config.intelligence.effectiveness.flushIntervalMs,
          maxBatch: config.intelligence.effectiveness.maxBatch,
        })
      : undefined;
    const policy = config.intelligence.adaptivePolicy.enabled
      ? new AdaptivePolicyService(storeHandle.store, "local:local:pi:pi-mentis", {
          cooldownMs: config.intelligence.adaptivePolicy.cooldownMs,
          baselineParameters: {
            contextTokens: config.retrieval.contextTokens,
            rerankCandidateLimit: config.inference.rerank.candidateLimit,
          },
        })
      : undefined;
    await policy?.initialize();
    const retrieval = createRetrievalService({
      knowledge,
      memory,
      reranker,
      embedding,
      embeddingModel: config.inference.siliconflow.embedding.model,
      embeddingDimensions: config.inference.siliconflow.embedding.dimensions,
      rerankModel: config.inference.siliconflow.rerank.model,
      rerankContextTokens: config.inference.siliconflow.rerank.maxInputTokens,
      rerankCandidateLimit: config.inference.rerank.candidateLimit,
      rerankCacheEntries: config.inference.rerank.cacheEntries,
      rerankCacheTtlMs: config.inference.rerank.cacheTtlMs,
      contextTokens: config.retrieval.contextTokens,
      knowledgeTokens: config.retrieval.knowledgeTokens,
      memoryTokens: config.retrieval.memoryTokens,
      telemetry,
      ...(effectiveness === undefined ? {} : { effectiveness }),
      ...(policy === undefined ? {} : { policy }),
    });
    const relationshipQueue = new MentisBackgroundQueue({ maxConcurrency: 1, maxQueueLength: 64 });
    this.#config = config;
    this.#scheduler = scheduler;
    this.#storeHandle = storeHandle;
    this.#embedding = embedding;
    this.#knowledge = knowledge;
    this.#memory = memory;
    this.#retrieval = retrieval;
    this.#contextState = new ContextStateService(storeHandle.store);
    this.#effectiveness = effectiveness;
    this.#policy = policy;
    this.#remember = new DefaultRememberCoordinator(memory, scopePlanner);
    this.#experience = createExperienceLearningService({
      store: storeHandle.store,
      memory,
      minimumOutcomes: config.intelligence.consolidation.procedureMinimumOutcomes,
      minimumSuccessEstimate: config.intelligence.consolidation.procedureMinimumSuccessEstimate,
    });
    this.#workingMemory = new WorkingMemoryService(
      storeHandle.store,
      config.intelligence.workingMemory,
    );
    this.#candidates = new MemoryCandidateService(
      storeHandle.store,
      memory,
      config.intelligence.memoryFormation,
    );
    this.#taskEpisodes = new TaskEpisodeService(storeHandle.store);
    const evidence = createPiEvidenceStore(storeHandle.store);
    this.#recall = new DefaultRecallCoordinator({
      getMemory: () => memory,
      getRetrieval: () => retrieval,
      getEvidence: () => evidence,
    });
    this.#relationshipQueue = relationshipQueue;
    this.#relationships = new DurableRelationshipLearningCoordinator({
      memory,
      queue: relationshipQueue,
      owner: `pi-mentis-sidecar:${process.pid}:${operationId("operation")}`,
    });
    this.#piPackageRoot = piPackageRoot;
    return { ready: true, protocolVersion: SIDECAR_PROTOCOL_VERSION };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancelReasonRequests("Mentis sidecar is closing");
    for (const [sessionId] of this.#sessions) await this.#closeSession(sessionId);
    this.#relationships?.close();
    await this.#relationshipQueue?.drain({ timeoutMs: 1_000, cancelPending: true });
    await this.#memory?.flushBackground?.();
    await this.#effectiveness?.close();
    await this.#scheduler?.close();
    await this.#storeHandle?.release();
    await resetSharedStores();
  }

  async #openSession(
    input: Extract<SidecarRequest, { method: "session.open" }>["params"],
  ): Promise<SessionOpenResult> {
    const resolved = await this.#projectIdentity
      .getOrResolve(input.cwd)
      .catch((): { readonly identity: PiProjectIdentity; readonly cacheHit: boolean } => ({
        identity: { workspacePath: input.cwd, manifestTypes: [] },
        cacheHit: false,
      }));
    const identity: PiProjectIdentity = resolved.identity;
    const scopeContext: PiScopeContext = {
      tenantId: "local",
      userId: "local",
      appId: "pi",
      agentId: "pi-mentis",
      ...(identity.repositoryId === undefined ? {} : { repositoryId: identity.repositoryId }),
      ...(identity.projectId === undefined ? {} : { projectId: identity.projectId }),
      workspacePath: identity.workspacePath,
      sessionId: input.clientSessionId,
      branchId: input.branchId,
      ...(input.parentBranchId === undefined ? {} : { parentBranchId: input.parentBranchId }),
    };
    const automaticRecall = this.#config?.retrieval.automaticRecall === true;
    const capsule = automaticRecall
      ? await this.#readCapsule(scopeContext).catch(() => undefined)
      : undefined;
    const workingMemory =
      this.#config?.intelligence.workingMemory.enabled === true
        ? await this.#workingMemory
            ?.loadOrCreate(
              scopeContext,
              input.clientSessionId,
              input.branchId,
              input.parentBranchId,
            )
            .catch(() => undefined)
        : undefined;
    const activeContext =
      workingMemory === undefined
        ? undefined
        : this.#workingMemory === undefined
          ? undefined
          : {
              ...this.#workingMemory.snapshot(workingMemory),
              branchGeneration: input.branchGeneration,
            };
    this.#sessions.set(input.clientSessionId, {
      scopeContext,
      branchGeneration: input.branchGeneration,
      taskGeneration: 0,
      closed: false,
      cwd: input.cwd,
      mode: input.sessionMode,
      identity,
      queue: Promise.resolve(),
      ...(capsule === undefined ? {} : { capsule }),
      capsuleRevision: capsule?.revision ?? 0,
      recallGuard: new CurrentTurnRecallGuard(),
      recentAssertions: new RecentAssertionOverlay(),
      recentProcedureMemoryIds: new Set(),
      finishedTurns: [],
      turnContexts: new Map(),
      backgroundJobIds: new Set(),
      ...(workingMemory === undefined ? {} : { workingMemory }),
    });
    if (automaticRecall) void this.#refreshCapsule(input.clientSessionId, "");
    return {
      scopeContext,
      ...(capsule === undefined ? {} : { capsule }),
      ...(activeContext === undefined ? {} : { activeContext }),
    };
  }

  async #rememberMemory(
    input: Extract<SidecarRequest, { method: "memory.remember" }>["params"],
  ): Promise<PublicRememberResult> {
    const remember = this.#remember;
    const memory = this.#memory;
    if (remember === undefined || memory === undefined)
      throw new Error("Memory service unavailable");
    const session = this.#sessions.get(input.clientSessionId);
    const sessionScope = session?.scopeContext ?? input.scopeContext;
    const contextSnapshot = session?.contextSnapshot;
    const result = await remember.remember(
      { content: input.content },
      {
        scopeContext: sessionScope,
        ...(contextSnapshot === undefined ? {} : { contextSnapshot }),
        ...(input.relationshipCandidateIds === undefined
          ? {}
          : {
              relationshipCandidates: input.relationshipCandidateIds.map((id) => ({
                id,
                source: "same_turn_recall" as const,
              })),
            }),
      },
    );
    if (result.id !== undefined) {
      await this.#recordWorkingMemoryReferences(session, [result.id]).catch(() => undefined);
    }
    if (result.id !== undefined && result.outcome === "remembered") {
      const work = await memory.getRelationshipLearning?.(result.id);
      if (work !== undefined) {
        const reasoner = this.#remoteReasoner();
        const pending = this.#pendingRelationships.get(input.clientSessionId) ?? [];
        const onResolved = (incomingId: string) => session?.recentAssertions.resolve(incomingId);
        pending.push({ work, reasoner, onResolved });
        this.#pendingRelationships.set(input.clientSessionId, pending);
        session?.recentAssertions.record({
          memoryId: result.id,
          content: input.content,
          observedAt: Date.now(),
          authority: "explicit_user",
          candidateIds: work.candidates.map((candidate) => candidate.id),
        });
        return {
          ...result,
          relationshipState: "provisional",
          relationshipLearning: "scheduled",
        };
      }
    }
    return { ...result, relationshipState: "consolidated" };
  }

  async #recallMemory(
    input: Extract<SidecarRequest, { method: "memory.recall" }>["params"],
  ): Promise<PublicRecallResult> {
    if (this.#recall === undefined) throw new Error("Recall service unavailable");
    const session = this.#sessions.get(input.clientSessionId);
    const sessionScope = session?.scopeContext ?? input.scopeContext;
    const scopedRequest = session?.recallGuard.scope(input.request) ?? input.request;
    const repeated = session?.recallGuard.repeated(scopedRequest);
    if (repeated !== undefined) return repeated;
    const memory = this.#memory;
    const pendingReader =
      memory === undefined
        ? undefined
        : {
            scopeContext: sessionScope,
            getRelationshipLearning: async (id: string) => memory.getRelationshipLearning?.(id),
            listPendingRelationshipLearning: (query?: {
              readonly limit?: number;
              readonly scopeContext?: Pick<
                PiScopeContext,
                "tenantId" | "userId" | "appId" | "agentId"
              >;
            }) => memory.listPendingRelationshipLearning?.(query) ?? Promise.resolve([]),
            get: (id: string) => memory.get(id, { scopeContext: sessionScope }),
          };
    if (
      pendingReader !== undefined &&
      scopedRequest.query !== undefined &&
      scopedRequest.id === undefined
    ) {
      const pending = await projectDurablePendingAssertions(pendingReader, scopedRequest, {
        found: false,
        contentFound: false,
        lookupMode: "global_query",
        resourceType: "search",
        anchored: false,
        hits: [],
      });
      if (pending.hits.length > 0) {
        return session?.recallGuard.record(scopedRequest, pending) ?? pending;
      }
    }
    const result = await this.#recall.recall(scopedRequest, {
      scopeContext: sessionScope,
      ...(session?.contextSnapshot === undefined
        ? {}
        : { contextSnapshot: session.contextSnapshot }),
    });
    const durableProjected =
      pendingReader === undefined
        ? result
        : await projectDurablePendingAssertions(pendingReader, scopedRequest, result);
    const projected =
      session?.recentAssertions.project(scopedRequest, durableProjected) ?? durableProjected;
    if (session !== undefined) {
      const procedures = projected.hits.filter((hit) => hit.kind === "procedure");
      this.#cognitiveTelemetry.procedureRecallCount += procedures.length;
      for (const hit of procedures) session.recentProcedureMemoryIds.add(hit.id);
      if (projected.traceId === undefined) delete session.latestTraceId;
      else session.latestTraceId = projected.traceId;
      const memoryIds = projected.hits
        .filter((hit) => hit.resourceType === "memory")
        .map((hit) => hit.id);
      await this.#recordWorkingMemoryReferences(session, memoryIds).catch(() => undefined);
    }
    return session?.recallGuard.record(scopedRequest, projected) ?? projected;
  }

  async #captureToolResult(
    clientSessionId: string,
    envelope: Extract<SidecarRequest, { method: "capture.toolResult" }>["params"]["envelope"],
  ) {
    const session = this.#sessions.get(clientSessionId);
    if (session === undefined) return undefined;
    let resolve!: (value: Awaited<ReturnType<PiCaptureSession["toolResult"]>>) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<Awaited<ReturnType<PiCaptureSession["toolResult"]>>>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.#enqueueSession(session, async () => {
      try {
        resolve(await this.#captureFor(session).toolResult(envelope));
      } catch (error) {
        reject(error);
      }
    });
    return result;
  }

  async #captureToolResultSpool(
    input: Extract<SidecarRequest, { method: "capture.toolResultSpool" }>["params"],
  ) {
    const config = this.#config;
    if (config === undefined) throw new Error("Sidecar is not initialized");
    const text = await consumeToolResultSpool(config.storage.rootDir, input.spoolId);
    return this.#captureToolResult(input.clientSessionId, { ...input.envelope, text });
  }

  async #knowledgeCommand(
    input: Extract<SidecarRequest, { method: "knowledge.command" }>["params"],
  ): Promise<unknown> {
    const knowledge = this.#knowledge;
    const config = this.#config;
    const store = this.#storeHandle?.store;
    const session = this.#sessions.get(input.clientSessionId);
    if (
      knowledge === undefined ||
      config === undefined ||
      store === undefined ||
      session === undefined
    )
      throw new Error("Knowledge service unavailable");
    const action = input.action;
    if (["add", "sync", "rebuild"].includes(action)) {
      const target = input.arguments.join(" ");
      if (target === "") throw new Error(`Usage: /kb ${action} <path-or-url>`);
      const source = await knowledgeSource(target);
      return knowledge.enqueueIngest(
        { source, scopeContext: session.scopeContext },
        { priority: "user" },
      );
    }
    if (action === "remove") {
      const sourceId = input.arguments[0];
      if (sourceId === undefined) throw new Error("Usage: /kb remove <source-id>");
      return knowledge.remove({ sourceId, scopeContext: session.scopeContext });
    }
    if (action === "cancel") {
      const jobId = input.arguments[0];
      return { cancelled: jobId !== undefined && this.#scheduler?.cancel(jobId) === true, jobId };
    }
    if (action === "jobs") {
      const jobId = input.arguments[0];
      if (jobId === undefined) throw new Error("Usage: /kb jobs <job-id>");
      return (await store.fetchScalar("jobs_v1", [jobId])).get(jobId);
    }
    if (action === "models") {
      return {
        embedding: getEmbeddingRuntimeResolution(config),
        rerank: config.inference.siliconflow.rerank,
      };
    }
    if (action === "inspect") {
      const documentId = input.arguments[0];
      if (documentId === undefined) throw new Error("Usage: /kb inspect <document-id>");
      return knowledge.inspect({ documentId, scopeContext: session.scopeContext });
    }
    if (action === "sources") return knowledge.capabilities();
    if (action === "status") return this.#status(input.clientSessionId);
    throw new Error(`Unknown /kb action: ${action}`);
  }

  async #status(clientSessionId?: string): Promise<unknown> {
    const config = this.#config;
    const store = this.#storeHandle?.store;
    const session = clientSessionId === undefined ? undefined : this.#sessions.get(clientSessionId);
    if (config === undefined || store === undefined) return { ready: false };
    return {
      ready: true,
      pid: process.pid,
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      storage: getStorageStatus(session?.cwd ?? process.cwd(), config.storage.rootDir),
      storageCoordination: await store.coordinationStatus(),
      scheduler: this.#scheduler?.snapshot(),
      relationshipRuntime: await this.#relationships?.snapshot(),
      effectiveness: this.#effectiveness?.bufferStatus(),
      policy: this.#policy?.status(),
      automaticRecall: config.retrieval.automaticRecall,
      workingMemory:
        session?.workingMemory === undefined
          ? undefined
          : {
              stateId: session.workingMemory.id,
              revision: session.workingMemory.revision,
              branchId: session.workingMemory.branchId,
            },
      cognitiveTelemetry: {
        ...this.#cognitiveTelemetry,
        backgroundCognitionTokens:
          this.#cognitiveTelemetry.candidateInputTokens +
          this.#cognitiveTelemetry.candidateOutputTokens +
          this.#cognitiveTelemetry.consolidationInputTokens +
          this.#cognitiveTelemetry.consolidationOutputTokens,
        netModelTokenSavings:
          this.#cognitiveTelemetry.foregroundContextSavedTokens -
          (this.#cognitiveTelemetry.candidateInputTokens +
            this.#cognitiveTelemetry.candidateOutputTokens +
            this.#cognitiveTelemetry.consolidationInputTokens +
            this.#cognitiveTelemetry.consolidationOutputTokens),
      },
      capsule: session?.capsule,
    };
  }

  #captureFor(session: SidecarSession): PiCaptureSession {
    if (session.capture !== undefined) return session.capture;
    const config = this.#config;
    const store = this.#storeHandle?.store;
    if (config === undefined || store === undefined) throw new Error("Capture service unavailable");
    session.capture = new PiCaptureSession(
      createPiEvidenceStore(store),
      config.memory.offload,
      (episode, events, outcome) => {
        const appliedProcedures = new Set(
          events
            .flatMap((item) => referencedMemoryIds(item.payload["input"]))
            .filter((id) => session.recentProcedureMemoryIds.has(id)),
        );
        if (appliedProcedures.size > 0) {
          this.#cognitiveTelemetry.procedureAppliedCount += appliedProcedures.size;
          if (outcome.executionStatus === "success" && outcome.verificationStatus === "passed") {
            this.#cognitiveTelemetry.procedureSuccessAfterRecall += appliedProcedures.size;
          } else if (
            outcome.executionStatus === "failed" ||
            outcome.verificationStatus === "failed"
          ) {
            this.#cognitiveTelemetry.procedureFailureAfterRecall += appliedProcedures.size;
          }
        }
        if (episode.taskId !== undefined && this.#contextState !== undefined) {
          const taskState =
            outcome.taskStatus === "completed"
              ? "completed"
              : outcome.taskStatus === "failed"
                ? "failed"
                : outcome.taskStatus === "aborted"
                  ? "aborted"
                  : "active";
          const job = this.#scheduler?.schedule({
            id: `task-state:${episode.id}`,
            deduplicationKey: `task-state:${episode.id}`,
            priority: TaskPriority.SessionMaintenance,
            estimatedBytes: 256,
            run: async () =>
              this.#contextState?.updateTaskState(
                episode.taskId as string,
                "local:local:pi:pi-mentis",
                taskState,
              ),
          });
          void job?.promise.catch(() => undefined);
        }
        if (session.latestTraceId !== undefined) {
          const traceId = session.latestTraceId;
          const observation = {
            traceId,
            execution: outcome.executionStatus,
            verification: outcome.verificationStatus,
            toolArgumentMemoryIds: events.flatMap((item) =>
              referencedMemoryIds(item.payload["input"]),
            ),
            evidenceIds: events.map((item) => item.id),
          } as const;
          const job = this.#scheduler?.schedule({
            id: `effectiveness:${episode.id}`,
            deduplicationKey: `effectiveness:${episode.id}`,
            priority: TaskPriority.SessionMaintenance,
            estimatedBytes: 1024,
            run: async () =>
              this.#retrieval?.recordOutcome?.("local:local:pi:pi-mentis", observation),
          });
          void job?.promise.catch(() => undefined);
        }
        const executionContext =
          session.turnContexts.get(episode.id) ??
          Object.freeze({
            namespace: episode.securityNamespace,
            sessionId: episode.sessionId,
            branchId: episode.branchId ?? "root",
            branchGeneration: session.branchGeneration,
            ...(episode.taskId === undefined ? {} : { taskId: episode.taskId }),
            taskGeneration: session.taskGeneration,
            topicIds: Object.freeze([...episode.topicIds]),
            ...(episode.contextSnapshotId === undefined
              ? {}
              : { contextSnapshotId: episode.contextSnapshotId }),
            episodeId: episode.id,
            scopeContext: Object.freeze({
              ...session.scopeContext,
              sessionId: episode.sessionId,
              branchId: episode.branchId ?? "root",
              ...(episode.taskId === undefined ? {} : { taskId: episode.taskId }),
              topicIds: Object.freeze([...episode.topicIds]),
            }),
          });
        session.finishedTurns.push({ episode, events, outcome, executionContext });
        session.turnContexts.delete(episode.id);
        if (session.finishedTurns.length > 32) session.finishedTurns.shift();
      },
      createTaskGraphService(store),
    );
    return session.capture;
  }

  #enqueueSession(session: SidecarSession, operation: () => Promise<void>): void {
    session.queue = session.queue.then(operation, operation).catch((error) => {
      this.#sendEvent({
        name: "warning",
        message: `Mentis sidecar capture failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    });
  }

  async #closeSession(clientSessionId: string): Promise<void> {
    const session = this.#sessions.get(clientSessionId);
    if (session === undefined) return;
    session.closed = true;
    session.branchGeneration++;
    session.taskGeneration++;
    this.#cancelReasonRequests("Pi session closed", clientSessionId);
    for (const jobId of session.backgroundJobIds) this.#scheduler?.cancel(jobId);
    session.backgroundJobIds.clear();
    await session.queue;
    await session.capture?.finish("partial").catch(() => undefined);
    await this.#drainFinishedTurns(clientSessionId, false).catch(() => undefined);
    if (session.workingMemory !== undefined) {
      await this.#workingMemory?.checkpoint(session.workingMemory).catch(() => undefined);
    }
    if (session.taskEpisode !== undefined) {
      await this.#taskEpisodes?.checkpoint(session.taskEpisode).catch(() => undefined);
    }
    this.#sessions.delete(clientSessionId);
    this.#pendingRelationships.delete(clientSessionId);
  }

  async #refreshCapsule(clientSessionId: string, prompt: string): Promise<void> {
    const session = this.#sessions.get(clientSessionId);
    const memory = this.#memory;
    const retrieval = this.#retrieval;
    if (session === undefined || memory === undefined || retrieval === undefined) return;
    const entries = new Map<string, ReturnType<typeof capsuleEntry>>();
    const scopes = [
      ...(session.scopeContext.repositoryId === undefined
        ? []
        : [{ kind: "repository" as const, id: session.scopeContext.repositoryId }]),
      ...(session.scopeContext.projectId === undefined
        ? []
        : [{ kind: "project" as const, id: session.scopeContext.projectId }]),
      ...(session.scopeContext.taskId === undefined
        ? []
        : [{ kind: "task" as const, id: session.scopeContext.taskId }]),
      ...(session.scopeContext.topicIds ?? []).map((id) => ({ kind: "topic" as const, id })),
      { kind: "user" as const, id: session.scopeContext.userId },
    ];
    const viewScopes = scopes.filter(
      (scope): scope is Exclude<(typeof scopes)[number], { kind: "repository" }> =>
        scope.kind !== "repository",
    );
    const views = await Promise.all(
      viewScopes.map(({ kind, id }) =>
        memory.getView?.(kind, id, session.scopeContext).catch(() => undefined),
      ),
    );
    for (const view of views) {
      if (view === undefined) continue;
      for (const fact of Object.values(view.facts)) {
        for (const memoryId of fact.currentMemoryIds) {
          const text = `${fact.recordKey}: ${fact.values?.[memoryId] ?? fact.value}`;
          entries.set(
            memoryId,
            capsuleEntry({
              id: memoryId,
              text,
              kind: "profile",
              authority: fact.authority,
              scopeKind: view.kind,
              updatedAt: view.updatedAt,
            }),
          );
        }
      }
    }
    if (prompt.trim().length >= 2) {
      const result = await retrieval
        .search(
          {
            text: prompt,
            sources: ["memory"],
            memoryScopes: scopes,
            memoryScopeContext: session.scopeContext,
            limit: 32,
            contextTokens: 3_200,
          },
          { timeoutMs: 10_000, allowRemoteEmbedding: true, allowRerank: true },
        )
        .catch(() => undefined);
      for (const hit of result?.hits ?? []) {
        entries.set(
          hit.id,
          capsuleEntry({
            id: hit.id,
            text: hit.text,
            kind: hit.kind,
            authority: hit.authority,
            updatedAt:
              typeof hit.metadata?.["updatedAt"] === "number"
                ? hit.metadata["updatedAt"]
                : Date.now(),
          }),
        );
      }
      const traceId = result?.diagnostics.traceId;
      if (traceId === undefined) delete session.latestTraceId;
      else session.latestTraceId = traceId;
    }
    const ordered = [...entries.values()]
      .sort(
        (left, right) =>
          right.authority - left.authority || (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
      )
      .slice(0, 96);
    const capsule: MemoryCapsule = {
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      sessionId: clientSessionId,
      revision: ++session.capsuleRevision,
      generatedAt: Date.now(),
      entries: ordered,
    };
    session.capsule = capsule;
    await this.#writeCapsule(session.scopeContext, capsule).catch(() => undefined);
    this.#sendEvent({ name: "capsule.updated", capsule });
  }

  async #settleSession(clientSessionId: string, prompt: string): Promise<void> {
    const session = this.#sessions.get(clientSessionId);
    if (session === undefined) return;
    await session.queue;
    const expectedBranch = {
      branchId: session.scopeContext.branchId ?? "root",
      branchGeneration: session.branchGeneration,
    };
    await this.#refreshContext(clientSessionId, prompt, expectedBranch).catch(() => undefined);
    await this.#drainFinishedTurns(clientSessionId).catch((error) => {
      this.#sendEvent({
        name: "warning",
        message: `Mentis immediate cognition update failed open: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    });
    this.#scheduleRelationships(clientSessionId);
    if (this.#relationshipRecoveryPending && this.#relationships !== undefined) {
      this.#relationshipRecoveryPending = false;
      await this.#relationships.recover(this.#remoteReasoner(), 128).catch(() => undefined);
    }
    if (this.#config?.retrieval.automaticRecall === true) {
      await this.#refreshCapsule(clientSessionId, prompt).catch(() => undefined);
    }
    this.#scheduleMaintenance();
  }

  async #drainFinishedTurns(clientSessionId: string, scheduleBackground = true): Promise<void> {
    const session = this.#sessions.get(clientSessionId);
    const config = this.#config;
    if (session === undefined || config === undefined) return;
    const turns = session.finishedTurns.splice(0);
    for (const turn of turns) {
      const executionContext = turn.executionContext;
      const turnScope = executionContext.scopeContext;
      const taskId = executionContext.taskId ?? turn.episode.taskId;
      let turnWorkingMemory: WorkingMemoryState | undefined;
      if (config.intelligence.workingMemory.enabled && this.#workingMemory !== undefined) {
        try {
          turnWorkingMemory = await this.#workingMemory.applyEpisode({
            scopeContext: turnScope,
            episode: turn.episode,
            events: turn.events,
            outcome: turn.outcome,
            ...(taskId === undefined ? {} : { taskId }),
          });
        } catch (error) {
          const inMemoryState = await this.#workingMemory.restore(
            turnScope,
            executionContext.sessionId,
            executionContext.branchId,
          );
          if (inMemoryState !== undefined) turnWorkingMemory = inMemoryState;
          this.#sendEvent({
            name: "warning",
            message: `Mentis Working Memory checkpoint failed; continuing from the in-memory state: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
        if (
          turnWorkingMemory !== undefined &&
          this.#sessionStillValid(clientSessionId, executionContext)
        ) {
          session.workingMemory = turnWorkingMemory;
          this.#publishActiveContext(clientSessionId, session);
        }
      }
      let turnTaskEpisode: TaskEpisode | undefined;
      if (taskId !== undefined && this.#taskEpisodes !== undefined) {
        turnTaskEpisode = await this.#taskEpisodes.append({
          taskId,
          scopeContext: turnScope,
          episode: turn.episode,
          events: turn.events,
          outcome: turn.outcome,
          ...(turnWorkingMemory === undefined ? {} : { workingMemory: turnWorkingMemory }),
        });
        if (this.#sessionStillValid(clientSessionId, executionContext)) {
          session.taskEpisode = turnTaskEpisode;
        }
      }
      if (scheduleBackground && this.#sessionStillValid(clientSessionId, executionContext)) {
        this.#scheduleCandidateFormation(clientSessionId, turn, executionContext);
      }
      if (
        scheduleBackground &&
        turnTaskEpisode !== undefined &&
        this.#sessionStillValid(clientSessionId, executionContext)
      ) {
        this.#scheduleEpisodeConsolidation(clientSessionId, turnTaskEpisode, executionContext);
      }
    }
  }

  #sessionStillValid(clientSessionId: string, context: TurnExecutionContext): boolean {
    const session = this.#sessions.get(clientSessionId);
    return (
      session !== undefined &&
      !session.closed &&
      context.sessionId === clientSessionId &&
      context.branchGeneration === session.branchGeneration &&
      context.taskGeneration === session.taskGeneration &&
      context.branchId === (session.scopeContext.branchId ?? "root") &&
      context.taskId === session.scopeContext.taskId
    );
  }

  #scheduleCandidateFormation(
    clientSessionId: string,
    turn: {
      readonly episode: PiEpisode;
      readonly events: readonly PiEvent[];
      readonly outcome: OutcomeStatus;
    },
    executionContext: TurnExecutionContext,
  ): void {
    const session = this.#sessions.get(clientSessionId);
    const config = this.#config;
    const scheduler = this.#scheduler;
    const candidates = this.#candidates;
    if (
      session === undefined ||
      config === undefined ||
      scheduler === undefined ||
      candidates === undefined ||
      !config.intelligence.memoryFormation.enabled
    ) {
      return;
    }
    const signals = detectMemoryCandidateTrigger(turn.episode.goal);
    if (!signals.shouldAnalyze) return;
    this.#cognitiveTelemetry.candidateTriggerCount++;
    const safeStatement = toRemoteSafe(turn.episode.goal);
    if (safeStatement.text === undefined) {
      this.#cognitiveTelemetry.candidatesRejected++;
      this.#cognitiveTelemetry.candidateRejectedSensitivity++;
      return;
    }
    const namespace = executionContext.namespace;
    const scheduledScope = executionContext.scopeContext;
    const evidenceCeiling = signals.userPreference
      ? "user"
      : scheduledScope.repositoryId !== undefined
        ? "repository"
        : scheduledScope.projectId !== undefined
          ? "project"
          : "task";
    const evidence: CandidateEvidence[] = turn.events
      .filter((event) => event.kind === "goal" || event.kind === "verification")
      .flatMap((event): CandidateEvidence[] => {
        const rawText =
          event.kind === "goal"
            ? String(event.payload["goal"] ?? turn.episode.goal)
            : `${String(event.payload["command"] ?? "verification")}: ${String(event.payload["status"] ?? "unknown")}`;
        const safe = toRemoteSafe(rawText);
        if (safe.text === undefined) return [];
        return [
          {
            id: event.id,
            ref: { kind: "event", id: event.id, observedAt: event.timestamp },
            namespace,
            text: safe.text,
            verified: event.kind === "verification" && event.payload["status"] === "passed",
            sourceKind: event.kind === "goal" ? "user" : "verification",
            firstPersonPreferenceEvidence: event.kind === "goal" && signals.userPreference,
            explicitCorrection: event.kind === "goal" && signals.correction,
            explicitCommitment: event.kind === "goal" && signals.commitment,
            allowedScopeCeiling: event.kind === "goal" ? evidenceCeiling : "repository",
            authority:
              event.kind === "goal"
                ? EvidenceAuthority.UserHistoricalStatement
                : EvidenceAuthority.VerifiedToolObservation,
          },
        ];
      });
    if (evidence.length === 0) {
      this.#cognitiveTelemetry.candidatesRejected++;
      this.#cognitiveTelemetry.candidateRejectedSensitivity++;
      return;
    }
    const payload = buildCandidateCognitionInput({
      statement: safeStatement.text,
      scopeContext: scheduledScope,
      signals,
      evidence,
      maxTokens: config.intelligence.memoryFormation.maxInputTokens,
    });
    const jobId = `memory-candidate:${turn.episode.id}`;
    const job = scheduler.schedule({
      id: jobId,
      deduplicationKey: jobId,
      priority: TaskPriority.SessionMaintenance,
      estimatedBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
      run: async (signal) => {
        this.#cognitiveTelemetry.candidateCognitionCount++;
        try {
          if (!this.#sessionStillValid(clientSessionId, executionContext)) {
            this.#cognitiveTelemetry.cognitionDiscards++;
            return;
          }
          this.#cognitiveTelemetry.candidateInputTokens += Number(payload["estimatedTokens"] ?? 0);
          const result = await this.#requestCognition(
            "memory_candidate",
            payload,
            config.intelligence.memoryFormation.maxOutputTokens,
            signal,
            clientSessionId,
          );
          this.#cognitiveTelemetry.candidateOutputTokens += estimateModelTokens(
            JSON.stringify(result),
          );
          if (!this.#sessionStillValid(clientSessionId, executionContext)) {
            this.#cognitiveTelemetry.cognitionDiscards++;
            return;
          }
          const proposals = parseMemoryCandidateProposals(result, {
            maximum: config.intelligence.memoryFormation.maxCandidatesPerTurn,
            maxCharacters: config.intelligence.memoryFormation.candidateMaxCharacters,
          });
          this.#cognitiveTelemetry.candidateProposed += proposals.length;
          for (const proposal of proposals) {
            if (!this.#sessionStillValid(clientSessionId, executionContext)) {
              this.#cognitiveTelemetry.cognitionDiscards++;
              return;
            }
            const observed = await candidates.observe(
              {
                proposal,
                source: candidateObservationSource(signals),
                scopeContext: scheduledScope,
                evidence,
                observationId: stableHash(
                  "memory-candidate-observation:v1",
                  namespace,
                  turn.episode.id,
                  ...proposal.evidenceIds,
                ),
              },
              { signal },
            );
            if (observed.outcome === "rejected") {
              this.#cognitiveTelemetry.candidatesRejected++;
              if (/sensitive/iu.test(observed.reason)) {
                this.#cognitiveTelemetry.candidateRejectedSensitivity++;
              } else if (/scope|preference/iu.test(observed.reason)) {
                this.#cognitiveTelemetry.candidateRejectedScope++;
              } else {
                this.#cognitiveTelemetry.candidateRejectedGrounding++;
              }
            } else if (observed.outcome === "promoted") {
              this.#cognitiveTelemetry.candidatesPromoted++;
              this.#cognitiveTelemetry.candidateAccepted++;
            } else {
              this.#cognitiveTelemetry.candidatesCreated++;
              this.#cognitiveTelemetry.candidateAccepted++;
            }
          }
        } catch (error) {
          if (signal.aborted) this.#cognitiveTelemetry.cognitionCancellations++;
          else this.#cognitiveTelemetry.cognitionFailures++;
          throw error;
        }
      },
    });
    session.backgroundJobIds.add(jobId);
    void job.promise.catch(() => undefined).finally(() => session.backgroundJobIds.delete(jobId));
  }

  #scheduleEpisodeConsolidation(
    clientSessionId: string,
    task: TaskEpisode,
    executionContext: TurnExecutionContext,
  ): void {
    const session = this.#sessions.get(clientSessionId);
    const config = this.#config;
    const scheduler = this.#scheduler;
    if (
      session === undefined ||
      config === undefined ||
      scheduler === undefined ||
      !config.intelligence.consolidation.enabled
    ) {
      return;
    }
    const terminalVerified = task.state === "completed" && task.verification === "passed";
    const checkpoint =
      task.state === "active" &&
      task.turns.length > 0 &&
      task.turns.length % config.intelligence.consolidation.longTaskCheckpointTurns === 0;
    if (!terminalVerified && !checkpoint && task.verification !== "failed") return;
    const scheduledScope = executionContext.scopeContext;
    const packageManager = session.identity.packageManager;
    const digest = createTaskEpisodeDigest(task, config.intelligence.consolidation.maxDigestTokens);
    const safeDigest = toRemoteSafe(digest.serialized);
    if (safeDigest.text === undefined) {
      this.#cognitiveTelemetry.candidateRejectedSensitivity++;
      return;
    }
    const safeDigestText = safeDigest.text;
    const jobId = `task-consolidation:${task.id}:${task.turns.length}`;
    const job = scheduler.schedule({
      id: jobId,
      deduplicationKey: jobId,
      priority: TaskPriority.SessionMaintenance,
      estimatedBytes: Buffer.byteLength(safeDigestText, "utf8"),
      run: async (signal) => {
        this.#cognitiveTelemetry.consolidationRuns++;
        try {
          if (!(await this.#consolidationLeaseValid(clientSessionId, executionContext, task))) {
            this.#cognitiveTelemetry.cognitionDiscards++;
            return;
          }
          this.#cognitiveTelemetry.consolidationInputTokens += estimateModelTokens(safeDigestText);
          const raw = await this.#requestCognition(
            "episode_consolidation",
            { digest: safeDigestText },
            config.intelligence.consolidation.maxOutputTokens,
            signal,
            clientSessionId,
          );
          this.#cognitiveTelemetry.consolidationOutputTokens += estimateModelTokens(
            JSON.stringify(raw),
          );
          if (!(await this.#consolidationLeaseValid(clientSessionId, executionContext, task))) {
            this.#cognitiveTelemetry.cognitionDiscards++;
            return;
          }
          const proposal = parseEpisodeConsolidationProposal(raw, {
            maxAssertions: config.intelligence.consolidation.maxSemanticCandidates,
            candidateMaxCharacters: config.intelligence.memoryFormation.candidateMaxCharacters,
          });
          this.#cognitiveTelemetry.semanticAssertionsProposed += proposal.assertions.length;
          this.#cognitiveTelemetry.candidateProposed += proposal.assertions.length;
          const evidence: CandidateEvidence[] = digest.evidence.map((entry) => ({
            id: entry.id,
            ref: { kind: entry.kind, id: entry.id, observedAt: task.updatedAt },
            namespace: task.namespace,
            text: entry.text,
            verified: entry.verified,
            structural: entry.structural,
            sourceKind: entry.sourceKind,
            allowedScopeCeiling:
              entry.sourceKind === "user"
                ? "project"
                : scheduledScope.repositoryId === undefined
                  ? "project"
                  : "repository",
            authority: entry.authority,
          }));
          for (const assertion of proposal.assertions) {
            if (!(await this.#consolidationLeaseValid(clientSessionId, executionContext, task))) {
              this.#cognitiveTelemetry.cognitionDiscards++;
              return;
            }
            if (!validateConsolidationEvidence(digest, assertion.evidenceIds, true)) {
              this.#cognitiveTelemetry.candidatesRejected++;
              this.#cognitiveTelemetry.candidateRejectedGrounding++;
              continue;
            }
            const observed = await this.#candidates?.observe(
              {
                proposal: assertion,
                source: "episode_consolidation",
                scopeContext: scheduledScope,
                evidence,
                observationId: stableHash(
                  "semantic-consolidation-observation:v1",
                  task.id,
                  ...assertion.evidenceIds,
                ),
              },
              { signal },
            );
            if (observed?.outcome === "promoted") {
              this.#cognitiveTelemetry.semanticAssertionsPromoted++;
              this.#cognitiveTelemetry.candidateAccepted++;
            } else if (observed?.outcome === "rejected") {
              this.#cognitiveTelemetry.candidatesRejected++;
              if (/sensitive/iu.test(observed.reason)) {
                this.#cognitiveTelemetry.candidateRejectedSensitivity++;
              } else if (/scope|preference/iu.test(observed.reason)) {
                this.#cognitiveTelemetry.candidateRejectedScope++;
              } else {
                this.#cognitiveTelemetry.candidateRejectedGrounding++;
              }
            } else if (observed !== undefined) {
              this.#cognitiveTelemetry.candidateAccepted++;
            }
          }
          if (
            proposal.procedure !== undefined &&
            !toRemoteSafe(JSON.stringify(proposal.procedure)).redacted &&
            validateConsolidationEvidence(
              digest,
              proposal.procedure.evidenceIds,
              task.verification === "passed",
            ) &&
            this.#experience !== undefined
          ) {
            if (!(await this.#consolidationLeaseValid(clientSessionId, executionContext, task))) {
              this.#cognitiveTelemetry.cognitionDiscards++;
              return;
            }
            const observation = deriveTaskEpisodeExperienceObservation(
              task,
              digest,
              proposal.procedure,
              {
                os: platform(),
                architecture: arch(),
                runtime: "node",
                runtimeVersion: process.version,
                ...(packageManager === undefined ? {} : { packageManager }),
                ...(session.identity.language === undefined
                  ? {}
                  : { language: session.identity.language }),
                ...(session.identity.manifestTypes.length === 0
                  ? {}
                  : { manifestTypes: [...session.identity.manifestTypes].sort().join(",") }),
              },
              scheduledScope,
            );
            if (observation !== undefined) {
              const experience = await this.#experience.observe(observation.candidate, { signal });
              const updated = await this.#experience.recordOutcome(
                experience.id,
                observation.outcome,
                { signal },
              );
              this.#cognitiveTelemetry.procedureObservations++;
              try {
                const qualified = await this.#experience.qualify(updated.id, { signal });
                this.#cognitiveTelemetry.procedureQualified++;
                await this.#experience.promote(qualified.id, { signal });
                this.#cognitiveTelemetry.procedurePromoted++;
              } catch {
                // Repeated verified outcomes have not reached the qualification gate yet.
              }
            }
          }
        } catch (error) {
          if (signal.aborted) this.#cognitiveTelemetry.cognitionCancellations++;
          else this.#cognitiveTelemetry.cognitionFailures++;
          throw error;
        }
      },
    });
    session.backgroundJobIds.add(jobId);
    void job.promise.catch(() => undefined).finally(() => session.backgroundJobIds.delete(jobId));
  }

  async #consolidationLeaseValid(
    clientSessionId: string,
    context: TurnExecutionContext,
    task: TaskEpisode,
  ): Promise<boolean> {
    if (!this.#sessionStillValid(clientSessionId, context)) return false;
    const latest = await this.#taskEpisodes
      ?.get(task.namespace, task.taskId, task.branchId)
      .catch(() => undefined);
    return (
      latest !== undefined &&
      latest.state !== "aborted" &&
      latest.id === task.id &&
      latest.episodeIds.includes(context.episodeId)
    );
  }

  async #recordWorkingMemoryReferences(
    session: SidecarSession | undefined,
    memoryIds: readonly string[],
  ): Promise<void> {
    if (
      session === undefined ||
      memoryIds.length === 0 ||
      this.#config?.intelligence.workingMemory.enabled !== true ||
      this.#workingMemory === undefined
    ) {
      return;
    }
    const updated = await this.#workingMemory.recordRecalledMemory(session.scopeContext, memoryIds);
    if (updated === undefined) return;
    session.workingMemory = updated;
    this.#publishActiveContext(session.scopeContext.sessionId ?? "unknown", session);
  }

  #publishActiveContext(clientSessionId: string, session: SidecarSession): void {
    if (session.workingMemory === undefined || this.#workingMemory === undefined) return;
    const snapshot = {
      ...this.#workingMemory.snapshot(session.workingMemory),
      branchGeneration: session.branchGeneration,
    };
    this.#cognitiveTelemetry.workingMemoryVisibleTokens = snapshot.estimatedTokens;
    this.#sendEvent({ name: "active-context.updated", clientSessionId, snapshot });
  }

  async #switchWorkingMemoryBranch(
    clientSessionId: string,
    previousBranchId: string,
    branchId: string,
    branchGeneration: number,
    parentBranchId?: string,
  ): Promise<void> {
    const session = this.#sessions.get(clientSessionId);
    if (
      session === undefined ||
      this.#config?.intelligence.workingMemory.enabled !== true ||
      this.#workingMemory === undefined
    ) {
      return;
    }
    const scopeContext: PiScopeContext = Object.freeze({ ...session.scopeContext, branchId });
    const workingMemory = await this.#workingMemory.loadOrCreate(
      scopeContext,
      clientSessionId,
      branchId,
      parentBranchId ?? previousBranchId,
    );
    if (
      session.closed ||
      session.branchGeneration !== branchGeneration ||
      (session.scopeContext.branchId ?? "root") !== branchId
    ) {
      return;
    }
    session.workingMemory = workingMemory;
    this.#publishActiveContext(clientSessionId, session);
  }

  async #refreshContext(
    clientSessionId: string,
    prompt: string,
    expected?: { readonly branchId: string; readonly branchGeneration: number },
  ): Promise<void> {
    const session = this.#sessions.get(clientSessionId);
    const state = this.#contextState;
    if (session === undefined || state === undefined || prompt.trim().length < 2) return;
    const namespace = [
      session.scopeContext.tenantId,
      session.scopeContext.userId,
      session.scopeContext.appId,
      session.scopeContext.agentId,
    ]
      .map(encodeURIComponent)
      .join(":");
    const explicitTopic = prompt
      .match(/(?:^|\s)(?:topic|主题)\s*[:：]\s*([^\n]{2,80})/iu)?.[1]
      ?.trim();
    const topic =
      explicitTopic === undefined
        ? await state.inferTopic(namespace, prompt).catch(() => undefined)
        : await state.observeTopicLabel(namespace, explicitTopic).catch(() => undefined);
    const topicIds = topic?.state === "active" ? [topic.topicId] : [];
    const task = await state
      .resolveTask({
        namespace,
        goal: prompt,
        ...(session.scopeContext.repositoryId === undefined
          ? {}
          : { repositoryId: session.scopeContext.repositoryId }),
        ...(session.scopeContext.projectId === undefined
          ? {}
          : { projectId: session.scopeContext.projectId }),
        topicIds,
        ...(session.scopeContext.taskId === undefined
          ? {}
          : { currentTaskId: session.scopeContext.taskId }),
      })
      .catch(() => undefined);
    if (
      expected !== undefined &&
      (session.closed ||
        session.branchGeneration !== expected.branchGeneration ||
        (session.scopeContext.branchId ?? "root") !== expected.branchId)
    ) {
      return;
    }
    if (task?.taskId !== undefined && task.taskId !== session.scopeContext.taskId) {
      session.taskGeneration++;
    }
    session.scopeContext = {
      ...session.scopeContext,
      topicIds,
      ...(task?.taskId === undefined ? {} : { taskId: task.taskId }),
    };
    const identity = session.identity;
    const workspace =
      identity.repositoryId === undefined &&
      identity.projectId === undefined &&
      identity.manifestTypes.length === 0
        ? undefined
        : {
            workspaceId: stableHash("workspace:v1", identity.workspacePath),
            ...(identity.repositoryId === undefined ? {} : { repositoryId: identity.repositoryId }),
            ...(identity.projectId === undefined ? {} : { projectId: identity.projectId }),
            canonicalPath: identity.workspacePath,
            ...(identity.repositoryRoot === undefined
              ? {}
              : { repositoryRoot: identity.repositoryRoot }),
            manifestTypes: identity.manifestTypes,
            ...(identity.manifestHash === undefined ? {} : { manifestHash: identity.manifestHash }),
            ...(identity.branchName === undefined ? {} : { branchName: identity.branchName }),
            ...(identity.commitId === undefined ? {} : { commitId: identity.commitId }),
          };
    const capabilitySnapshotId = stableHash(
      "pi-sidecar-capability-context:v1",
      this.#piPackageRoot ?? "unknown",
    );
    session.contextSnapshot = this.#contextResolver.resolve({
      runtimeKey: clientSessionId,
      identity: {
        tenantId: session.scopeContext.tenantId,
        userId: session.scopeContext.userId,
        appId: session.scopeContext.appId,
        agentId: session.scopeContext.agentId,
      },
      conversation: {
        sessionId: clientSessionId,
        ...(session.scopeContext.branchId === undefined
          ? {}
          : { branchId: session.scopeContext.branchId }),
        ...(session.scopeContext.parentBranchId === undefined
          ? {}
          : { parentBranchId: session.scopeContext.parentBranchId }),
        runId: operationId("operation"),
        sessionMode: session.mode,
      },
      ...(workspace === undefined ? {} : { workspace }),
      situation: {
        ...(task?.taskId === undefined ? {} : { taskId: task.taskId }),
        topicIds,
        activeGoal: prompt,
        interactionMode: inferInteractionMode(prompt, workspace !== undefined),
        startedAt: Date.now(),
      },
      environment: {
        os: platform(),
        architecture: arch(),
        ...(process.env["SHELL"] === undefined ? {} : { shell: process.env["SHELL"] }),
        runtime: "node",
        runtimeVersion: process.version,
        ...(identity.language === undefined ? {} : { language: identity.language }),
        ...(identity.packageManager === undefined
          ? {}
          : { packageManager: identity.packageManager }),
        ...(identity.packageManagerVersion === undefined
          ? {}
          : { packageManagerVersion: identity.packageManagerVersion }),
      },
      capability: {
        piVersion: this.#config?.runtime.piVersion ?? "unknown",
        extensionsHash: capabilitySnapshotId,
        skillsHash: capabilitySnapshotId,
        mcpHash: capabilitySnapshotId,
        toolsHash: capabilitySnapshotId,
        snapshotId: capabilitySnapshotId,
      },
    }).snapshot;
    session.scopeContext = {
      ...session.scopeContext,
      contextSnapshotId: session.contextSnapshot.id,
    };
    if (this.#config?.intelligence.context.persistSnapshots === true) {
      await state.persistSnapshot(session.contextSnapshot).catch(() => undefined);
    }
    this.#sendEvent({
      name: "context.updated",
      clientSessionId,
      scopeContext: session.scopeContext,
    });
  }

  #capsulePath(scope: PiScopeContext): string {
    const config = this.#config;
    if (config === undefined) throw new Error("Sidecar is not initialized");
    const owner = scope.repositoryId ?? scope.projectId ?? scope.userId;
    const name = stableHash("pi-mentis-capsule:v1", scope.userId, owner);
    return path.join(path.dirname(config.storage.rootDir), "capsules", `${name}.json`);
  }

  async #readCapsule(scope: PiScopeContext): Promise<MemoryCapsule | undefined> {
    const value = JSON.parse(await readFile(this.#capsulePath(scope), "utf8")) as MemoryCapsule;
    return value.protocolVersion === SIDECAR_PROTOCOL_VERSION &&
      value.entries.every(
        (entry) => Number.isFinite(entry.estimatedTokens) && entry.estimatedTokens >= 0,
      )
      ? value
      : undefined;
  }

  async #writeCapsule(scope: PiScopeContext, capsule: MemoryCapsule): Promise<void> {
    const target = this.#capsulePath(scope);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(capsule)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }

  #remoteReasoner(): PairwiseRelationshipReasoner {
    return {
      judge: async (incomingContent, candidate) => this.#requestReason(incomingContent, candidate),
    };
  }

  async #requestReason(
    incomingContent: string,
    candidate: RecalledMemoryEvidence,
  ): Promise<PairwiseRelationshipJudgment> {
    const requestId = `reason:${process.pid}:${operationId("operation")}`;
    return await new Promise<PairwiseRelationshipJudgment>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#reasonRequests.delete(requestId);
        reject(new Error("Pi relationship reasoning timed out"));
      }, 15_000);
      this.#reasonRequests.set(requestId, { resolve, reject, timer });
      this.#sendEvent({ name: "reason.request", requestId, incomingContent, candidate });
    });
  }

  async #requestCognition(
    task: "memory_candidate" | "episode_consolidation",
    payload: Readonly<Record<string, unknown>>,
    maxOutputTokens: number,
    signal?: AbortSignal,
    clientSessionId = "unknown",
  ): Promise<unknown> {
    const requestId = `cognition:${process.pid}:${operationId("operation")}`;
    return await new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        const pending = this.#cognitionRequests.get(requestId);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        pending.removeAbortListener();
        this.#cognitionRequests.delete(requestId);
        this.#sendEvent({ name: "cognition.cancel", requestId });
        reject(new Error(`Pi ${task} cognition cancelled`));
      };
      const removeAbortListener = () => signal?.removeEventListener("abort", onAbort);
      const timer = setTimeout(() => {
        this.#cognitionRequests.delete(requestId);
        removeAbortListener();
        this.#sendEvent({ name: "cognition.cancel", requestId });
        reject(new Error(`Pi ${task} cognition timed out`));
      }, 20_000);
      this.#cognitionRequests.set(requestId, {
        resolve,
        reject,
        timer,
        removeAbortListener,
        clientSessionId,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      this.#sendEvent({
        name: "cognition.request",
        requestId,
        task,
        payload,
        maxOutputTokens,
      });
    });
  }

  #resolveReason(
    input: Extract<SidecarNotification, { method: "reason.response" }>["params"],
  ): void {
    const pending = this.#reasonRequests.get(input.requestId);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#reasonRequests.delete(input.requestId);
    if (input.error !== undefined) {
      pending.reject(new Error(input.error));
      return;
    }
    try {
      pending.resolve(parseReasonJudgment(JSON.stringify(input.result)));
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #resolveCognition(
    input: Extract<SidecarNotification, { method: "cognition.response" }>["params"],
  ): void {
    const pending = this.#cognitionRequests.get(input.requestId);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    pending.removeAbortListener();
    this.#cognitionRequests.delete(input.requestId);
    if (input.error !== undefined) pending.reject(new Error(input.error));
    else pending.resolve(input.result);
  }

  #cancelReasonRequests(reason: string, clientSessionId?: string): void {
    for (const pending of this.#reasonRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.#reasonRequests.clear();
    for (const [requestId, pending] of this.#cognitionRequests) {
      if (clientSessionId !== undefined && pending.clientSessionId !== clientSessionId) continue;
      clearTimeout(pending.timer);
      pending.removeAbortListener();
      pending.reject(new Error(reason));
      this.#sendEvent({ name: "cognition.cancel", requestId });
      this.#cognitionRequests.delete(requestId);
    }
    if (clientSessionId === undefined) this.#cognitionRequests.clear();
  }

  #scheduleRelationships(clientSessionId: string): void {
    const relationships = this.#relationships;
    if (relationships === undefined) return;
    const pending = this.#pendingRelationships.get(clientSessionId) ?? [];
    this.#pendingRelationships.delete(clientSessionId);
    for (const item of pending)
      relationships.schedule(item.work, item.reasoner, "normal", item.onResolved);
  }

  #scheduleMaintenance(): void {
    if (this.#maintenanceScheduled) return;
    this.#maintenanceScheduled = true;
    const scheduler = this.#scheduler;
    const memory = this.#memory;
    const knowledge = this.#knowledge;
    const store = this.#storeHandle?.store;
    const config = this.#config;
    if (
      scheduler === undefined ||
      memory === undefined ||
      knowledge === undefined ||
      store === undefined ||
      config === undefined
    )
      return;
    const timer = setTimeout(() => {
      const job = scheduler.schedule({
        id: "sidecar-idle-maintenance",
        deduplicationKey: "sidecar-idle-maintenance",
        priority: TaskPriority.GarbageCollection,
        estimatedBytes: 1024,
        run: async (signal) => {
          const evidence = createPiEvidenceStore(store);
          await evidence.recoverArtifacts({ signal });
          await evidence.collectExpiredArtifacts(undefined, { signal });
          await store.collectSupersededGenerations(config.storage.generationRetentionMs);
          await knowledge.recoverJobs({ signal });
          await memory.repairViews?.();
          const piPackageRoot = this.#piPackageRoot;
          if (piPackageRoot !== undefined) {
            const configuredPiHome = process.env["PI_CODING_AGENT_DIR"]?.trim();
            const piHome =
              configuredPiHome === undefined || configuredPiHome === ""
                ? path.join(homedir(), ".pi", "agent")
                : path.resolve(configuredPiHome);
            const scan = await scanPiInstallation({
              piPackageRoot,
              resourceRoots: [path.join(process.cwd(), ".pi"), piHome],
            });
            const indexer = new CapabilityIndexer({
              store,
              embedding: this.#embeddingProvider(),
              embeddingSpace: embeddingSpace(config),
              dimensions: config.inference.siliconflow.embedding.dimensions,
            });
            await indexer.sync(scan.fingerprint, scan.records, { signal });
          }
          if (this.#effectiveness !== undefined && this.#policy !== undefined) {
            const cases = await this.#effectiveness.replayCases("local:local:pi:pi-mentis");
            if (cases.length >= 20) {
              const shadow = this.#policy.shadow();
              if (shadow !== undefined) {
                const [baseline, candidate] = await Promise.all([
                  this.#policy.replay(this.#policy.active(), cases, evaluateReplayCandidate),
                  this.#policy.replay(shadow, cases, evaluateReplayCandidate),
                ]);
                if (
                  candidate.forbiddenExposure === 0 &&
                  candidate.evidenceCoverage >= baseline.evidenceCoverage &&
                  candidate.score > baseline.score
                ) {
                  await this.#policy.promoteToCanary(shadow);
                }
              } else {
                await this.#policy.optimize(cases, evaluateReplayCandidate);
              }
            }
          }
        },
      });
      void job.promise.catch(() => undefined);
    }, config.performance.sidecar.maintenanceDelayMs);
    timer.unref?.();
  }

  #assertReady(): void {
    if (this.#closed) throw new Error("Mentis sidecar is closed");
    if (this.#memory === undefined) throw new Error("Mentis sidecar is not initialized");
  }

  #embeddingProvider(): SiliconFlowEmbeddingProvider {
    if (this.#embedding === undefined) throw new Error("Mentis sidecar is not initialized");
    return this.#embedding;
  }
}
