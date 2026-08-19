import { stat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { arch, homedir, platform, setPriority } from "node:os";
import path from "node:path";

import {
  BackgroundScheduler,
  MentisContextResolver,
  TaskPriority,
  getEmbeddingRuntimeResolution,
  getStorageStatus,
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
  detectSecrets,
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

interface SidecarSession {
  scopeContext: PiScopeContext;
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
  readonly finishedTurns: Array<{
    readonly episode: PiEpisode;
    readonly events: readonly PiEvent[];
    readonly outcome: OutcomeStatus;
  }>;
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
}

interface CognitiveTelemetry {
  workingMemoryVisibleTokens: number;
  candidateTriggerCount: number;
  candidateCognitionCount: number;
  candidatesCreated: number;
  candidatesPromoted: number;
  candidatesRejected: number;
  consolidationRuns: number;
  semanticAssertionsProposed: number;
  semanticAssertionsPromoted: number;
  procedureObservations: number;
  procedureQualified: number;
  procedurePromoted: number;
  cognitionFailures: number;
  cognitionCancellations: number;
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
    candidateTriggerCount: 0,
    candidateCognitionCount: 0,
    candidatesCreated: 0,
    candidatesPromoted: 0,
    candidatesRejected: 0,
    consolidationRuns: 0,
    semanticAssertionsProposed: 0,
    semanticAssertionsPromoted: 0,
    procedureObservations: 0,
    procedureQualified: 0,
    procedurePromoted: 0,
    cognitionFailures: 0,
    cognitionCancellations: 0,
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
    if (notification.method === "session.branch") {
      const previousBranchId = session.scopeContext.branchId ?? "root";
      session.scopeContext = {
        ...session.scopeContext,
        branchId: notification.params.branchId,
        ...(notification.params.parentBranchId === undefined
          ? {}
          : { parentBranchId: notification.params.parentBranchId }),
      };
      void this.#switchWorkingMemoryBranch(
        notification.params.clientSessionId,
        previousBranchId,
        notification.params.branchId,
        notification.params.parentBranchId,
      );
      return;
    }
    if (notification.method === "input.activity") {
      this.#cancelReasonRequests("New Pi input arrived");
      session.recallGuard.beginTurn();
      return;
    }
    if (notification.method === "session.close") {
      void this.#closeSession(notification.params.clientSessionId);
      return;
    }
    if (notification.method === "capture.start") {
      session.lastPrompt = notification.params.goal;
      this.#enqueueSession(session, async () => {
        const capture = this.#captureFor(session);
        await capture.start({ goal: notification.params.goal, scope: session.scopeContext });
      });
      return;
    }
    if (notification.method === "capture.steer") {
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
      workingMemory === undefined ? undefined : this.#workingMemory?.snapshot(workingMemory);
    this.#sessions.set(input.clientSessionId, {
      scopeContext,
      cwd: input.cwd,
      mode: input.sessionMode,
      identity,
      queue: Promise.resolve(),
      ...(capsule === undefined ? {} : { capsule }),
      capsuleRevision: capsule?.revision ?? 0,
      recallGuard: new CurrentTurnRecallGuard(),
      recentAssertions: new RecentAssertionOverlay(),
      finishedTurns: [],
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
      cognitiveTelemetry: { ...this.#cognitiveTelemetry },
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
        session.finishedTurns.push({ episode, events, outcome });
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
    await this.#refreshContext(clientSessionId, prompt).catch(() => undefined);
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
      const taskId = session.scopeContext.taskId ?? turn.episode.taskId;
      if (config.intelligence.workingMemory.enabled && this.#workingMemory !== undefined) {
        try {
          session.workingMemory = await this.#workingMemory.applyEpisode({
            scopeContext: session.scopeContext,
            episode: turn.episode,
            events: turn.events,
            outcome: turn.outcome,
            ...(taskId === undefined ? {} : { taskId }),
          });
        } catch (error) {
          const inMemoryState = await this.#workingMemory.restore(
            session.scopeContext,
            session.scopeContext.sessionId ?? turn.episode.sessionId,
            session.scopeContext.branchId ?? turn.episode.branchId ?? "root",
          );
          if (inMemoryState !== undefined) session.workingMemory = inMemoryState;
          this.#sendEvent({
            name: "warning",
            message: `Mentis Working Memory checkpoint failed; continuing from the in-memory state: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
        if (session.workingMemory !== undefined)
          this.#publishActiveContext(clientSessionId, session);
      }
      if (taskId !== undefined && this.#taskEpisodes !== undefined) {
        session.taskEpisode = await this.#taskEpisodes.append({
          taskId,
          scopeContext: session.scopeContext,
          episode: turn.episode,
          events: turn.events,
          outcome: turn.outcome,
          ...(session.workingMemory === undefined ? {} : { workingMemory: session.workingMemory }),
        });
      }
      if (scheduleBackground) this.#scheduleCandidateFormation(clientSessionId, turn);
      if (scheduleBackground && session.taskEpisode !== undefined) {
        this.#scheduleEpisodeConsolidation(clientSessionId, session.taskEpisode);
      }
    }
  }

  #scheduleCandidateFormation(
    clientSessionId: string,
    turn: {
      readonly episode: PiEpisode;
      readonly events: readonly PiEvent[];
      readonly outcome: OutcomeStatus;
    },
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
    if (detectSecrets(turn.episode.goal).sensitive) {
      this.#cognitiveTelemetry.candidatesRejected++;
      return;
    }
    const namespace = securityNamespaceForScope(session.scopeContext);
    const scheduledScope: PiScopeContext = Object.freeze({
      ...session.scopeContext,
      ...(session.scopeContext.topicIds === undefined
        ? {}
        : { topicIds: Object.freeze([...session.scopeContext.topicIds]) }),
    });
    const evidence: CandidateEvidence[] = turn.events
      .filter((event) => event.kind === "goal" || event.kind === "verification")
      .map((event) => ({
        id: event.id,
        ref: { kind: "event", id: event.id, observedAt: event.timestamp },
        namespace,
        text:
          event.kind === "goal"
            ? String(event.payload["goal"] ?? turn.episode.goal)
            : `${String(event.payload["command"] ?? "verification")}: ${String(event.payload["status"] ?? "unknown")}`,
        verified: event.kind === "verification" && event.payload["status"] === "passed",
      }));
    const payload = buildCandidateCognitionInput({
      statement: turn.episode.goal,
      scopeContext: scheduledScope,
      signals,
      evidence,
      maxTokens: config.intelligence.memoryFormation.maxInputTokens,
    });
    const job = scheduler.schedule({
      id: `memory-candidate:${turn.episode.id}`,
      deduplicationKey: `memory-candidate:${turn.episode.id}`,
      priority: TaskPriority.SessionMaintenance,
      estimatedBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
      run: async (signal) => {
        this.#cognitiveTelemetry.candidateCognitionCount++;
        try {
          const result = await this.#requestCognition(
            "memory_candidate",
            payload,
            config.intelligence.memoryFormation.maxOutputTokens,
            signal,
          );
          const proposals = parseMemoryCandidateProposals(result, {
            maximum: config.intelligence.memoryFormation.maxCandidatesPerTurn,
            maxCharacters: config.intelligence.memoryFormation.candidateMaxCharacters,
          });
          for (const proposal of proposals) {
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
            if (observed.outcome === "rejected") this.#cognitiveTelemetry.candidatesRejected++;
            else if (observed.outcome === "promoted") this.#cognitiveTelemetry.candidatesPromoted++;
            else this.#cognitiveTelemetry.candidatesCreated++;
          }
        } catch (error) {
          if (signal.aborted) this.#cognitiveTelemetry.cognitionCancellations++;
          else this.#cognitiveTelemetry.cognitionFailures++;
          throw error;
        }
      },
    });
    void job.promise.catch(() => undefined);
  }

  #scheduleEpisodeConsolidation(clientSessionId: string, task: TaskEpisode): void {
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
    const scheduledScope: PiScopeContext = Object.freeze({
      ...session.scopeContext,
      ...(session.scopeContext.topicIds === undefined
        ? {}
        : { topicIds: Object.freeze([...session.scopeContext.topicIds]) }),
    });
    const packageManager = session.identity.packageManager;
    const digest = createTaskEpisodeDigest(task, config.intelligence.consolidation.maxDigestTokens);
    const job = scheduler.schedule({
      id: `task-consolidation:${task.id}:${task.turns.length}`,
      deduplicationKey: `task-consolidation:${task.id}:${task.turns.length}`,
      priority: TaskPriority.SessionMaintenance,
      estimatedBytes: Buffer.byteLength(digest.serialized, "utf8"),
      run: async (signal) => {
        this.#cognitiveTelemetry.consolidationRuns++;
        try {
          const raw = await this.#requestCognition(
            "episode_consolidation",
            { digest: digest.serialized },
            config.intelligence.consolidation.maxOutputTokens,
            signal,
          );
          const proposal = parseEpisodeConsolidationProposal(raw, {
            maxAssertions: config.intelligence.consolidation.maxSemanticCandidates,
            candidateMaxCharacters: config.intelligence.memoryFormation.candidateMaxCharacters,
          });
          this.#cognitiveTelemetry.semanticAssertionsProposed += proposal.assertions.length;
          const evidence: CandidateEvidence[] = digest.evidence.map((entry) => ({
            id: entry.id,
            ref: { kind: entry.kind, id: entry.id, observedAt: task.updatedAt },
            namespace: task.namespace,
            text: entry.text,
            verified: entry.verified,
          }));
          for (const assertion of proposal.assertions) {
            if (!validateConsolidationEvidence(digest, assertion.evidenceIds, true)) {
              this.#cognitiveTelemetry.candidatesRejected++;
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
            } else if (observed?.outcome === "rejected") {
              this.#cognitiveTelemetry.candidatesRejected++;
            }
          }
          if (
            proposal.procedure !== undefined &&
            validateConsolidationEvidence(
              digest,
              proposal.procedure.evidenceIds,
              task.verification === "passed",
            ) &&
            this.#experience !== undefined
          ) {
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
    void job.promise.catch(() => undefined);
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
    const snapshot = this.#workingMemory.snapshot(session.workingMemory);
    this.#cognitiveTelemetry.workingMemoryVisibleTokens = snapshot.estimatedTokens;
    this.#sendEvent({ name: "active-context.updated", clientSessionId, snapshot });
  }

  async #switchWorkingMemoryBranch(
    clientSessionId: string,
    previousBranchId: string,
    branchId: string,
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
    session.workingMemory = await this.#workingMemory.loadOrCreate(
      session.scopeContext,
      clientSessionId,
      branchId,
      parentBranchId ?? previousBranchId,
    );
    this.#publishActiveContext(clientSessionId, session);
  }

  async #refreshContext(clientSessionId: string, prompt: string): Promise<void> {
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
      this.#cognitionRequests.set(requestId, { resolve, reject, timer, removeAbortListener });
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

  #cancelReasonRequests(reason: string): void {
    for (const pending of this.#reasonRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.#reasonRequests.clear();
    for (const pending of this.#cognitionRequests.values()) {
      clearTimeout(pending.timer);
      pending.removeAbortListener();
      pending.reject(new Error(reason));
    }
    this.#cognitionRequests.clear();
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
