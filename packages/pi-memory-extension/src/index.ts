import { arch, platform } from "node:os";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  BackgroundScheduler,
  MentisContextResolver,
  ProviderPriority,
  TaskPriority,
  assertPiCompatibility,
  detectInstalledPackageVersion,
  getEmbeddingRuntimeResolution,
  getStorageStatus,
  getOrCreateRuntime,
  globalConfigPath,
  loadConfig,
  inferInteractionMode,
  operationId,
  resetGlobalRuntime,
  stableHash,
  type MentisContextSnapshot,
  type PiMentisConfig,
  type EvidenceRef,
} from "@pi-mentis/pi-mentis-core";
import type {
  EmbeddingProvider,
  EmbeddingSpaceIdentity,
  RerankProvider,
} from "@pi-mentis/pi-mentis-inference";
import {
  ContextStateService,
  DefaultRememberCoordinator,
  CurrentTurnMemoryEvidence,
  canReturnFullRead,
  compactReadReference,
  DeferredRelationshipLearningScheduler,
  DurableRelationshipLearningCoordinator,
  MentisBackgroundQueue,
  MentisSerialWorkQueue,
  PiCaptureSession,
  fullReadResult,
  createExperienceLearningService,
  createPiEvidenceStore,
  createTaskGraphService,
  createMemoryService,
  deriveExperienceObservation,
  referencedMemoryIds,
  readRequestKey,
  recoverFullToolResult,
  resolvePiProjectIdentity,
  taskIdentityId,
  TurnContextManager,
  ScopeSemanticPlanner,
  type MemoryService,
  type PiEvidenceStore,
  type PiProjectIdentity,
  type PiScopeContext,
} from "@pi-mentis/pi-mentis-memory-core";
import { InMemoryTelemetry } from "@pi-mentis/pi-mentis-observability";
import {
  formatPiToolJson,
  createMentisMemorySystemPrompt,
  formatMentisHelp,
  notifyWhenUiAvailable,
  registerMemoryToolPair,
  createPiPairwiseRelationshipReasoner,
  projectDurablePendingAssertions,
  CurrentTurnRecallGuard,
  RecentAssertionOverlay,
} from "@pi-mentis/pi-mentis-pi-extension-support";
import {
  AdaptivePolicyService,
  DefaultRecallCoordinator,
  EffectivenessService,
  createRetrievalService,
  evaluateReplayCandidate,
  type CreateRetrievalServiceOptions,
  type RetrievalService,
  type MentisServiceAccess,
} from "@pi-mentis/pi-mentis-retrieval";
import {
  SiliconFlowEmbeddingProvider,
  SiliconFlowRerankProvider,
} from "@pi-mentis/pi-mentis-siliconflow";
import {
  acquireSharedZvecStore,
  resetSharedStores,
  type SharedZvecStoreHandle,
  type ZvecStore,
} from "@pi-mentis/pi-mentis-zvec";

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

function spaces(
  config: PiMentisConfig,
): Readonly<Record<"knowledge" | "memory" | "capability", EmbeddingSpaceIdentity>> {
  const identity = embeddingSpace(config);
  return { knowledge: identity, memory: identity, capability: identity };
}

function embeddingRuntimeDiagnostics(config: PiMentisConfig, store?: ZvecStore) {
  const resolution = getEmbeddingRuntimeResolution(config);
  return {
    ...resolution,
    ...(store === undefined
      ? {}
      : {
          activeIndexGenerations: store.manifest.generations
            .filter((generation) => generation.state === "active")
            .map((generation) => ({
              kind: generation.kind,
              generationId: generation.generationId,
              embeddingSpace: generation.embeddingSpace,
            })),
        }),
  };
}

function fallbackProjectIdentity(cwd: string): PiProjectIdentity {
  return { workspacePath: cwd, manifestTypes: [] };
}

function registerMemoryTools(
  pi: ExtensionAPI,
  services: MentisServiceAccess,
  getScopeContext: () => PiScopeContext,
  getContextSnapshot: () => MentisContextSnapshot | undefined,
  getEvidenceRef: () => EvidenceRef | undefined,
  _onTrace: (traceId: string) => void,
  getScopePlanner: () => ScopeSemanticPlanner | undefined,
  relationshipTurn: CurrentTurnMemoryEvidence,
  recentAssertions: RecentAssertionOverlay,
  recallGuard: CurrentTurnRecallGuard,
  relationshipScheduler: DeferredRelationshipLearningScheduler | undefined,
  unavailableReason: () => string | undefined,
): void {
  // Build coordinators and register shared tool pair.
  const memory = services.getMemory();
  const rememberCoord =
    memory !== undefined ? new DefaultRememberCoordinator(memory, getScopePlanner()) : undefined;
  const recallCoord =
    services.getRetrieval() !== undefined ? new DefaultRecallCoordinator(services) : undefined;

  registerMemoryToolPair(pi, {
    async remember(content, signal, toolContext) {
      if (rememberCoord === undefined) {
        return {
          outcome: "unavailable" as const,
          summary: unavailableReason() ?? "Memory service unavailable.",
          readable: false,
        };
      }
      const ctxSnapshot = getContextSnapshot();
      const evRef = getEvidenceRef();
      const recalled = relationshipTurn
        .snapshot()
        .map((candidate) => ({ ...candidate, evidenceSource: "same_turn_recall" as const }));
      let discoveredCandidateIds: readonly string[] = [];
      const result = await rememberCoord.remember(
        { content },
        {
          scopeContext: getScopeContext(),
          ...(ctxSnapshot !== undefined ? { contextSnapshot: ctxSnapshot } : {}),
          ...(evRef !== undefined ? { evidenceRef: evRef } : {}),
          relationshipCandidates: recalled.map((candidate) => ({
            id: candidate.id,
            source: candidate.evidenceSource,
          })),
          onCommitted: (committed) => {
            discoveredCandidateIds = committed.relationshipCandidateIds ?? committed.relatedIds;
          },
          ...(signal !== undefined ? { signal } : {}),
        },
      );
      const recalledIds = new Set(recalled.map((candidate) => candidate.id));
      const relationshipCandidates = [
        ...recalled,
        ...discoveredCandidateIds
          .filter((id) => !recalledIds.has(id))
          .map((id) => ({
            id,
            content: "",
            status: "current" as const,
            match: "semantic" as const,
            evidenceSource: "semantic_candidate" as const,
          })),
      ];
      const reasoner =
        toolContext === undefined ? undefined : createPiPairwiseRelationshipReasoner(toolContext);
      if (
        result.id !== undefined &&
        result.outcome === "remembered" &&
        relationshipCandidates.length > 0 &&
        reasoner !== undefined &&
        memory !== undefined &&
        relationshipScheduler !== undefined
      ) {
        const incomingId = result.id;
        const relationshipScope = getScopeContext();
        const durable = await memory.prepareRelationshipLearning?.(
          incomingId,
          relationshipCandidates.map((candidate) => ({
            id: candidate.id,
            source: candidate.evidenceSource,
          })),
          { scopeContext: relationshipScope },
        );
        const scheduledCandidates =
          durable?.candidates.map((candidate) => ({
            id: candidate.id,
            content: relationshipCandidates.find((item) => item.id === candidate.id)?.content ?? "",
            status: "current" as const,
            match: "semantic" as const,
            evidenceSource: candidate.source,
          })) ?? relationshipCandidates;
        recentAssertions.record({
          memoryId: incomingId,
          content,
          observedAt: Date.now(),
          authority: "explicit_user",
          candidateIds: scheduledCandidates.map((candidate) => candidate.id),
        });
        if (durable !== undefined) {
          relationshipScheduler.schedule(durable, reasoner, "normal", (resolvedId) => {
            recentAssertions.resolve(resolvedId);
          });
        }
        return {
          ...result,
          relationshipState: "provisional" as const,
          relationshipLearning: "scheduled" as const,
        };
      }
      return { ...result, relationshipState: "consolidated" as const };
    },
    async recall(request, signal) {
      const scopedRequest = recallGuard.scope(request);
      const repeated = recallGuard.repeated(scopedRequest);
      if (repeated !== undefined) return repeated;
      if (recallCoord === undefined) {
        return { found: false, resourceType: "unknown", anchored: false, hits: [] };
      }
      const ctxSnapshot = getContextSnapshot();
      const result = await recallCoord.recall(scopedRequest, {
        scopeContext: getScopeContext(),
        ...(ctxSnapshot !== undefined ? { contextSnapshot: ctxSnapshot } : {}),
        ...(signal !== undefined ? { signal } : {}),
      });
      const durableProjected =
        memory === undefined
          ? result
          : await projectDurablePendingAssertions(
              {
                getRelationshipLearning: async (id) => memory.getRelationshipLearning?.(id),
                listPendingRelationshipLearning: (input) =>
                  memory.listPendingRelationshipLearning?.(input) ?? Promise.resolve([]),
                get: (id) =>
                  memory.get(id, {
                    scopeContext: getScopeContext(),
                    accessIntent: "explicit_id",
                  }),
              },
              scopedRequest,
              result,
            );
      const projected = recentAssertions.project(scopedRequest, durableProjected);
      relationshipTurn.recordRecall(
        projected.hits
          .filter((hit) => hit.resourceType === "memory")
          .map((hit) => ({
            id: hit.id,
            content: hit.content,
            status: hit.status,
            match: hit.match,
            evidenceSource: "same_turn_recall",
          })),
      );
      return recallGuard.record(scopedRequest, projected);
    },
  });
}

export default async function piMentisMemoryExtension(pi: ExtensionAPI): Promise<void> {
  let initError: Error | undefined;
  let config: PiMentisConfig;
  try {
    const installedVersion = await detectInstalledPackageVersion(
      "@earendil-works/pi-coding-agent",
      import.meta.url,
    );
    assertPiCompatibility(installedVersion);
    config = await loadConfig(process.cwd());
  } catch (err) {
    initError = err instanceof Error ? err : new Error(String(err));
    const initMessage = initError.message;
    pi.on("session_start", (_event, ctx) => {
      notifyWhenUiAvailable(
        ctx,
        `Pi Mentis memory extension failed to initialize: ${initMessage}`,
        "error",
      );
    });
    return;
  }
  const configPath = globalConfigPath();
  const helpText = formatMentisHelp({ configPath, memory: true, knowledge: false });
  const memorySystemPrompt = createMentisMemorySystemPrompt("@galvinsan/pi-mentis-memory");
  const scheduler = new BackgroundScheduler(config.performance.queue);
  const backgroundQueue = new MentisBackgroundQueue({ maxConcurrency: 1, maxQueueLength: 32 });
  const captureQueue = new MentisSerialWorkQueue();
  const turnContext = new TurnContextManager();
  const relationshipTurn = new CurrentTurnMemoryEvidence();
  const recentAssertions = new RecentAssertionOverlay();
  const recallGuard = new CurrentTurnRecallGuard();
  const telemetry = new InMemoryTelemetry();
  const runtime = getOrCreateRuntime();
  let storeHandle: SharedZvecStoreHandle | undefined;
  let scopePlanner: ScopeSemanticPlanner | undefined;
  let branchId = "root";
  let parentBranchId: string | undefined;
  let captureSession: PiCaptureSession | undefined;
  const completedLargeReads = new Set<string>();
  let activeProjectIdentity = fallbackProjectIdentity(process.cwd());
  let contextRefreshSequence = 0;
  let evidenceStore: PiEvidenceStore | undefined;
  let scopeContext: PiScopeContext = {
    tenantId: "local",
    userId: "local",
    appId: "pi",
    agentId: "pi-mentis-memory",
  };
  const contextResolver = new MentisContextResolver();
  let contextSnapshot: MentisContextSnapshot | undefined;
  let sessionMode: MentisContextSnapshot["conversation"]["sessionMode"] = "persistent";
  let contextState: ContextStateService | undefined;
  let effectiveness: EffectivenessService | undefined;
  let policy: AdaptivePolicyService | undefined;
  let latestRetrievalTraceId: string | undefined;
  let durableRelationships: DurableRelationshipLearningCoordinator | undefined;
  let deferredRelationships: DeferredRelationshipLearningScheduler | undefined;
  runtime.registerEmbedding({
    id: "siliconflow",
    version: "1.0.0",
    priority: ProviderPriority.standalone,
    initialize: async () => new SiliconFlowEmbeddingProvider(config.inference.siliconflow),
  });
  runtime.registerReranker({
    id: "siliconflow",
    version: "1.0.0",
    priority: ProviderPriority.standalone,
    initialize: async () => new SiliconFlowRerankProvider(config.inference.siliconflow),
  });
  runtime.registerMemory({
    id: "standalone-memory",
    version: "1.0.0",
    priority: ProviderPriority.standalone,
    initialize: async () => {
      const embedding = runtime.getEmbedding<EmbeddingProvider>();
      if (embedding === undefined) throw new Error("Embedding provider is unavailable");
      storeHandle = await acquireSharedZvecStore(config.storage, spaces(config));
      contextState ??= new ContextStateService(storeHandle.store);
      scopePlanner ??= new ScopeSemanticPlanner({
        embedding,
        dimensions: config.inference.siliconflow.embedding.dimensions,
      });
      return createMemoryService({
        store: storeHandle.store,
        embedding,
        embeddingSpace: embeddingSpace(config),
        dimensions: config.inference.siliconflow.embedding.dimensions,
        telemetry,
        viewsEnabled: config.intelligence.views.enabled,
        viewTtlMs: config.intelligence.views.ttlMs,
        scopePlanner,
      });
    },
    dispose: async (memory) => {
      await memory.flushBackground?.();
      await storeHandle?.release();
      storeHandle = undefined;
    },
  });
  runtime.registerRetrieval({
    id: "standalone-retrieval",
    version: "1.0.0",
    priority: ProviderPriority.standalone,
    initialize: async () => {
      const knowledge =
        runtime.getKnowledge<NonNullable<CreateRetrievalServiceOptions["knowledge"]>>();
      const memory = runtime.getMemory<MemoryService>();
      const reranker = runtime.getReranker<RerankProvider>();
      const embedding = runtime.getEmbedding<EmbeddingProvider>();
      if (storeHandle !== undefined) {
        if (config.intelligence.effectiveness.enabled) {
          effectiveness ??= new EffectivenessService(storeHandle.store, {
            flushIntervalMs: config.intelligence.effectiveness.flushIntervalMs,
            maxBatch: config.intelligence.effectiveness.maxBatch,
          });
        }
        if (config.intelligence.adaptivePolicy.enabled) {
          policy ??= new AdaptivePolicyService(
            storeHandle.store,
            "local:local:pi:pi-mentis-memory",
            { cooldownMs: config.intelligence.adaptivePolicy.cooldownMs },
          );
          await policy.initialize();
        }
      }
      return createRetrievalService({
        ...(knowledge === undefined ? {} : { knowledge }),
        ...(memory === undefined ? {} : { memory }),
        ...(reranker === undefined ? {} : { reranker }),
        ...(embedding === undefined ? {} : { embedding }),
        embeddingModel: config.inference.siliconflow.embedding.model,
        embeddingDimensions: config.inference.siliconflow.embedding.dimensions,
        rerankModel: config.inference.siliconflow.rerank.model,
        rerankContextTokens: config.inference.siliconflow.rerank.maxInputTokens,
        rerankCandidateLimit: config.inference.rerank.candidateLimit,
        rerankCacheEntries: config.inference.rerank.cacheEntries,
        rerankCacheTtlMs: config.inference.rerank.cacheTtlMs,
        telemetry,
        ...(effectiveness === undefined ? {} : { effectiveness }),
        ...(policy === undefined ? {} : { policy }),
      });
    },
    dispose: async () => {
      await effectiveness?.close();
      await scheduler.close();
    },
  });

  let registered = false;

  pi.on("session_start", async (event, context) => {
    completedLargeReads.clear();
    sessionMode = event.reason === "fork" ? "forked" : "persistent";
    const storageStatus = getStorageStatus(context.cwd, config.storage.rootDir);
    if (storageStatus.inactiveAlternateStore !== undefined) {
      notifyWhenUiAvailable(
        context,
        `Pi Mentis selected ${storageStatus.mentisRoot} as the single active store. The independent store at ${storageStatus.inactiveAlternateStore.root} is inactive and was not modified.`,
        "warning",
      );
    }
    if (storageStatus.legacyProjectStoreDetected) {
      notifyWhenUiAvailable(
        context,
        `Pi Mentis detected and ignored a project-local legacy store at ${storageStatus.legacyProjectStorePath}. The active global-profile store is ${storageStatus.effectiveZvecRoot}.`,
        "warning",
      );
    }
    let runtimeReadyError: Error | undefined;
    try {
      await runtime.ready(context.signal);
    } catch (err) {
      runtimeReadyError = err instanceof Error ? err : new Error(String(err));
      notifyWhenUiAvailable(
        context,
        `Pi Mentis memory runtime initialization failed: ${runtimeReadyError.message}. Tools are registered but will return errors until the issue is resolved.`,
        "error",
      );
    }
    const memory = runtime.getMemory<MemoryService>();
    if (memory !== undefined && durableRelationships === undefined) {
      durableRelationships = new DurableRelationshipLearningCoordinator({
        memory,
        queue: backgroundQueue,
        owner: `pi-mentis-memory:${process.pid}:${operationId("operation")}`,
      });
      deferredRelationships = new DeferredRelationshipLearningScheduler(durableRelationships);
    }

    // Create evidence store BEFORE tool registration so coordinators
    // receive a valid reference through dynamic accessors.
    if (storeHandle !== undefined && evidenceStore === undefined) {
      evidenceStore = createPiEvidenceStore(storeHandle.store);
    }

    // Always register tools — even if store init failed.
    // Tools return structured errors when services are unavailable.
    if (!registered) {
      registerMemoryTools(
        pi,
        {
          getMemory: () => runtime.getMemory<MemoryService>(),
          getRetrieval: () => runtime.getRetrieval<RetrievalService>(),
          getEvidence: () => evidenceStore,
        },
        () => scopeContext,
        () => contextSnapshot,
        () =>
          captureSession?.goalEventId === undefined
            ? undefined
            : { kind: "event", id: captureSession.goalEventId, observedAt: Date.now() },
        (traceId) => {
          latestRetrievalTraceId = traceId;
        },
        () => scopePlanner,
        relationshipTurn,
        recentAssertions,
        recallGuard,
        deferredRelationships,
        () =>
          runtimeReadyError?.message ??
          runtime
            .snapshot()
            .providers.find((provider) => provider.kind === "memory" && provider.state === "failed")
            ?.error,
      );
      pi.registerCommand("mentis", {
        description: "Show Pi Mentis help or current status",
        handler: async (rawArguments, commandCtx) => {
          const action = rawArguments.trim() || "status";
          if (action === "help") {
            notifyWhenUiAvailable(commandCtx, helpText, "info");
            return;
          }
          if (action !== "status") {
            notifyWhenUiAvailable(commandCtx, "Usage: /mentis help | /mentis status", "error");
            return;
          }
          const memoryService = runtime.getMemory<MemoryService>();
          const views = await Promise.all(
            [
              ...(scopeContext.projectId === undefined
                ? []
                : [{ kind: "project" as const, id: scopeContext.projectId }]),
              ...(scopeContext.taskId === undefined
                ? []
                : [{ kind: "task" as const, id: scopeContext.taskId }]),
              ...(scopeContext.topicIds ?? []).map((id) => ({ kind: "topic" as const, id })),
              { kind: "user" as const, id: scopeContext.userId },
            ].map(async ({ kind, id }) => memoryService?.getView?.(kind, id, scopeContext)),
          );
          notifyWhenUiAvailable(
            commandCtx,
            formatPiToolJson({
              storage: getStorageStatus(commandCtx.cwd, config.storage.rootDir),
              embeddingRuntime: embeddingRuntimeDiagnostics(config, storeHandle?.store),
              runtime: runtime.snapshot(),
              scheduler: scheduler.snapshot(),
              relationshipRuntime: await durableRelationships?.snapshot(),
              storageCoordination: await storeHandle?.store.coordinationStatus(),
              context:
                contextSnapshot === undefined
                  ? undefined
                  : {
                      id: contextSnapshot.id,
                      revision: contextSnapshot.revision,
                      repositoryId: contextSnapshot.workspace?.repositoryId,
                      projectId: contextSnapshot.workspace?.projectId,
                      taskId: contextSnapshot.situation.taskId,
                      topicIds: contextSnapshot.situation.topicIds,
                      capabilitySnapshotId: contextSnapshot.capability.snapshotId,
                    },
              temporal: {
                enabled: true,
              },
              views: views.filter((view) => view !== undefined),
              policy: policy?.status(),
              effectiveness: {
                buffer: effectiveness?.bufferStatus(),
                summary: await effectiveness?.summary("local:local:pi:pi-mentis-memory"),
              },
            }),
            "info",
          );
        },
      });
      registered = true;
    }
    const startupReasoner = createPiPairwiseRelationshipReasoner(context);
    if (startupReasoner !== undefined) {
      deferredRelationships?.recover(startupReasoner, 128, (resolvedId) => {
        recentAssertions.resolve(resolvedId);
      });
    }
    if (memory === undefined || storeHandle === undefined) {
      if (runtimeReadyError === undefined) {
        notifyWhenUiAvailable(
          context,
          "Pi Mentis memory services unavailable. commit_memory and search_memory tools are registered but will return errors until the issue is resolved.",
          "warning",
        );
      }
      return;
    }
    const project = await resolvePiProjectIdentity(context.cwd).catch(() =>
      fallbackProjectIdentity(context.cwd),
    );
    activeProjectIdentity = project;
    scopeContext = {
      tenantId: "local",
      userId: "local",
      appId: "pi",
      agentId: "pi-mentis-memory",
      ...(project.repositoryId === undefined ? {} : { repositoryId: project.repositoryId }),
      ...(project.projectId === undefined ? {} : { projectId: project.projectId }),
      sessionId: context.sessionManager.getSessionId(),
      branchId,
      ...(parentBranchId === undefined ? {} : { parentBranchId }),
    };
    evidenceStore ??= createPiEvidenceStore(storeHandle.store);
    contextState ??= new ContextStateService(storeHandle.store);
    const repair = scheduler.schedule({
      id: `memory-maintenance:${scopeContext.userId}`,
      deduplicationKey: `memory-maintenance:${scopeContext.userId}`,
      priority: TaskPriority.SessionMaintenance,
      estimatedBytes: 1024,
      run: async (signal) => {
        await evidenceStore?.recoverArtifacts({ signal });
        await evidenceStore?.collectExpiredArtifacts(undefined, { signal });
        await storeHandle?.store.collectSupersededGenerations(config.storage.generationRetentionMs);
        await memory.repairViews?.();
      },
    });
    void repair.promise.catch(() => undefined);
    if (effectiveness !== undefined && policy !== undefined) {
      const policyJob = scheduler.schedule({
        id: "adaptive-policy-maintenance",
        deduplicationKey: "adaptive-policy-maintenance",
        priority: TaskPriority.BackgroundSync,
        estimatedBytes: 4096,
        run: async () => {
          const cases = await effectiveness?.replayCases("local:local:pi:pi-mentis-memory");
          if (cases === undefined || cases.length < 20) return;
          const evaluate = evaluateReplayCandidate;
          const canary = policy?.canary();
          if (canary !== undefined) {
            const summary = await effectiveness?.summary(
              "local:local:pi:pi-mentis-memory",
              1_000,
              canary.id,
            );
            if (summary === undefined) return;
            const decision = await policy?.observeCanary(canary, summary);
            if (decision === "continue" && summary.samples >= 20) await policy?.activate(canary);
            return;
          }
          const shadow = policy?.shadow();
          if (shadow !== undefined) {
            const [baseline, candidate] = await Promise.all([
              policy?.replay(policy.active(), cases, evaluate),
              policy?.replay(shadow, cases, evaluate),
            ]);
            if (
              baseline !== undefined &&
              candidate !== undefined &&
              candidate.forbiddenExposure === 0 &&
              candidate.evidenceCoverage >= baseline.evidenceCoverage &&
              candidate.score > baseline.score
            ) {
              await policy?.promoteToCanary(shadow);
            }
            return;
          }
          const active = policy?.active();
          if (active !== undefined) {
            const summary = await effectiveness?.summary(
              "local:local:pi:pi-mentis-memory",
              1_000,
              active.id,
            );
            if (summary !== undefined && summary.samples >= 20) {
              const drift = await policy?.observeCanary(active, summary);
              if (drift === "rollback") return;
            }
          }
          await policy?.optimize(cases, evaluate);
        },
      });
      void policyJob.promise.catch(() => undefined);
    }
    if (config.memory.captureEnabled) {
      const experience = createExperienceLearningService({ store: storeHandle.store, memory });
      captureSession ??= new PiCaptureSession(
        evidenceStore,
        config.memory.offload,
        (episode, events, outcome) => {
          if (episode.taskId !== undefined && contextState !== undefined) {
            const episodeTaskId = episode.taskId;
            const taskState =
              outcome.taskStatus === "completed"
                ? "completed"
                : outcome.taskStatus === "failed"
                  ? "failed"
                  : outcome.taskStatus === "aborted"
                    ? "aborted"
                    : "active";
            const taskJob = scheduler.schedule({
              id: `task-state:${episode.id}`,
              deduplicationKey: `task-state:${episode.id}`,
              priority: TaskPriority.SessionMaintenance,
              estimatedBytes: 256,
              run: async () =>
                contextState?.updateTaskState(
                  episodeTaskId,
                  "local:local:pi:pi-mentis-memory",
                  taskState,
                ),
            });
            void taskJob.promise.catch(() => undefined);
          }
          if (latestRetrievalTraceId !== undefined) {
            const traceId = latestRetrievalTraceId;
            const namespace = [
              scopeContext.tenantId,
              scopeContext.userId,
              scopeContext.appId,
              scopeContext.agentId,
            ]
              .map(encodeURIComponent)
              .join(":");
            const retrieval = runtime.getRetrieval<RetrievalService>();
            const effectJob = scheduler.schedule({
              id: `effectiveness:${episode.id}`,
              deduplicationKey: `effectiveness:${episode.id}`,
              priority: TaskPriority.SessionMaintenance,
              estimatedBytes: 1024,
              run: async () =>
                retrieval?.recordOutcome?.(namespace, {
                  traceId,
                  execution: outcome.executionStatus,
                  verification: outcome.verificationStatus,
                  toolArgumentMemoryIds: events.flatMap((item) =>
                    referencedMemoryIds(item.payload["input"]),
                  ),
                  evidenceIds: events.map((item) => item.id),
                }),
            });
            void effectJob.promise.catch(() => undefined);
          }
          const observation = deriveExperienceObservation(
            episode,
            events,
            outcome,
            {
              embeddingModel: config.inference.siliconflow.embedding.model,
              embeddingDimensions: String(config.inference.siliconflow.embedding.dimensions),
              rerankModel: config.inference.siliconflow.rerank.model,
              piVersion: config.runtime.piVersion,
            },
            scopeContext,
          );
          if (observation === undefined) return;
          const learning = scheduler.schedule({
            id: `episode-learning:${episode.id}`,
            deduplicationKey: `episode-learning:${episode.id}`,
            priority: TaskPriority.SessionMaintenance,
            estimatedBytes: Buffer.byteLength(JSON.stringify(events), "utf8"),
            run: async (signal) => {
              const candidate = await experience.observe(observation.candidate, { signal });
              await experience.recordOutcome(candidate.id, observation.outcome, { signal });
            },
          });
          void learning.promise.catch(() => undefined);
        },
        createTaskGraphService(storeHandle.store),
      );
    }

    // Pre-warm semantic indices off the hot path so the first search does
    // not stall the agent's first turn on a cache-miss remote embedding.
    runtime.getRetrieval<RetrievalService>()?.warmup?.();
  });
  pi.on("session_tree", (event, context) => {
    branchId = event.newLeafId ?? "root";
    parentBranchId =
      event.newLeafId === null
        ? undefined
        : (context.sessionManager.getEntry(event.newLeafId)?.parentId ?? undefined);
    scopeContext = {
      ...scopeContext,
      branchId,
      ...(parentBranchId === undefined ? {} : { parentBranchId }),
    };
  });
  pi.on("input", (event) => {
    deferredRelationships?.activity();
    relationshipTurn.beginTurn();
    recallGuard.beginTurn();
    if (latestRetrievalTraceId !== undefined) {
      const confirmation = /^(?:对|是的|没错|就是这个|正确|yes|correct|exactly)\b/i.test(
        event.text.trim(),
      )
        ? "confirmed"
        : /(?:不对|错了|不是这个|incorrect|wrong)/i.test(event.text)
          ? "corrected"
          : undefined;
      if (confirmation !== undefined) {
        const namespace = [
          scopeContext.tenantId,
          scopeContext.userId,
          scopeContext.appId,
          scopeContext.agentId,
        ]
          .map(encodeURIComponent)
          .join(":");
        const traceId = latestRetrievalTraceId;
        const feedbackJob = scheduler.schedule({
          id: `retrieval-feedback:${traceId}:${confirmation}`,
          deduplicationKey: `retrieval-feedback:${traceId}:${confirmation}`,
          priority: TaskPriority.SessionMaintenance,
          estimatedBytes: 256,
          run: async () =>
            runtime.getRetrieval<RetrievalService>()?.recordOutcome?.(namespace, {
              traceId,
              execution: confirmation === "confirmed" ? "success" : "failed",
              verification: "unknown",
              userConfirmation: confirmation,
              evidenceIds: [],
            }),
        });
        void feedbackJob.promise.catch(() => undefined);
      }
    }
    if (event.streamingBehavior === "steer") {
      if (captureSession !== undefined) {
        const session = captureSession;
        captureQueue.enqueue(async () => {
          await session.steer(event.text);
        });
      }
      const memory = runtime.getMemory<MemoryService>();
      const invalidation = scheduler.schedule({
        id: `branch-invalidation:${branchId}:${stableHash("steering:v1", event.text)}`,
        deduplicationKey: `branch-invalidation:${branchId}:${stableHash("steering:v1", event.text)}`,
        priority: TaskPriority.SessionMaintenance,
        estimatedBytes: 1024,
        run: async () => memory?.abandonBranch?.(branchId, scopeContext),
      });
      void invalidation.promise.catch(() => undefined);
    }
  });
  pi.on("before_agent_start", (event, context) => {
    latestRetrievalTraceId = undefined;
    turnContext.nextTurn(event.prompt);
    const identity =
      activeProjectIdentity.workspacePath === context.cwd
        ? activeProjectIdentity
        : fallbackProjectIdentity(context.cwd);
    const currentEntryId = context.sessionManager.getLeafId() ?? undefined;
    const parentEntryId =
      currentEntryId === undefined
        ? undefined
        : (context.sessionManager.getEntry(currentEntryId)?.parentId ?? undefined);
    const tools = [...(event.systemPromptOptions.selectedTools ?? [])].sort();
    const skillsHash = stableHash(
      "skills:v2",
      JSON.stringify(event.systemPromptOptions.skills ?? []),
    );
    const toolsHash = stableHash(
      "tools:v2",
      JSON.stringify({
        selectedTools: tools,
        snippets: event.systemPromptOptions.toolSnippets ?? {},
      }),
    );
    const promptResourcesHash = stableHash("pi-prompt-resources:v1", event.systemPrompt);
    const scopedModels = context.scopedModels
      .map(({ model, thinkingLevel }) => ({
        provider: model.provider,
        model: model.id,
        ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      }))
      .sort((left, right) =>
        `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`),
      );
    const capabilityFingerprint = stableHash(
      "pi-capability-context:v1",
      JSON.stringify({ toolsHash, skillsHash, promptResourcesHash, scopedModels }),
    );
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
    const identityFacet = {
      tenantId: "local",
      userId: "local",
      appId: "pi",
      agentId: "pi-mentis-memory",
    };
    const identityNamespace = Object.values(identityFacet).map(encodeURIComponent).join(":");
    const explicitTopic = event.prompt
      .match(/(?:^|\s)(?:topic|主题)\s*[:：]\s*([^\n]{2,80})/i)?.[1]
      ?.trim();
    const activeTopic = turnContext.activeTopic;
    const topicIds =
      activeTopic.topicId === undefined ? [] : ([activeTopic.topicId] as readonly string[]);
    const taskInput = {
      namespace: identityNamespace,
      goal: event.prompt,
      ...(identity.repositoryId === undefined ? {} : { repositoryId: identity.repositoryId }),
      ...(identity.projectId === undefined ? {} : { projectId: identity.projectId }),
      topicIds,
      ...(contextSnapshot?.situation.taskId === undefined
        ? {}
        : { currentTaskId: contextSnapshot.situation.taskId }),
    };
    const activeTask = turnContext.activeTask;
    const taskId =
      activeTask.taskId !== undefined && activeTask.status === "active"
        ? activeTask.taskId
        : taskIdentityId(taskInput);
    const fastContext = {
      runtimeKey: context.sessionManager.getSessionId(),
      identity: identityFacet,
      conversation: {
        sessionId: context.sessionManager.getSessionId(),
        ...(currentEntryId === undefined ? {} : { branchId: currentEntryId, currentEntryId }),
        ...(parentEntryId === undefined ? {} : { parentBranchId: parentEntryId }),
        runId: operationId("operation"),
        sessionMode,
      },
      ...(workspace === undefined ? {} : { workspace }),
      situation: {
        taskId,
        topicIds,
        activeGoal: event.prompt,
        interactionMode: inferInteractionMode(event.prompt, workspace !== undefined),
        startedAt: Date.now(),
      },
      environment: {
        os: platform(),
        architecture: arch(),
        ...(process.env["SHELL"] === undefined ? {} : { shell: process.env["SHELL"] }),
        runtime: "node",
        runtimeVersion: process.version,
        ...(identity.packageManager === undefined
          ? {}
          : { packageManager: identity.packageManager }),
        ...(identity.packageManagerVersion === undefined
          ? {}
          : { packageManagerVersion: identity.packageManagerVersion }),
        ...(identity.language === undefined ? {} : { language: identity.language }),
      },
      capability: {
        piVersion: config.runtime.piVersion,
        ...(context.model?.provider === undefined ? {} : { provider: context.model.provider }),
        ...(context.model?.id === undefined ? {} : { model: context.model.id }),
        extensionsHash: promptResourcesHash,
        skillsHash,
        mcpHash: toolsHash,
        toolsHash,
        snapshotId: capabilityFingerprint,
      },
    } as const;
    contextSnapshot = contextResolver.resolve(fastContext).snapshot;
    if (contextState !== undefined && config.intelligence.context.persistSnapshots) {
      const state = contextState;
      const snapshot = contextSnapshot;
      backgroundQueue.enqueue({
        kind: "snapshot.checkpoint",
        coalesceKey: `snapshot.checkpoint:${snapshot.conversation.sessionId}`,
        priority: "fresh",
        execute: async () => {
          await state.persistSnapshot(snapshot);
        },
      });
    }
    scopeContext = {
      ...contextSnapshot.identity,
      sessionId: contextSnapshot.conversation.sessionId,
      ...(contextSnapshot.conversation.branchId === undefined
        ? {}
        : { branchId: contextSnapshot.conversation.branchId }),
      ...(contextSnapshot.conversation.parentBranchId === undefined
        ? {}
        : { parentBranchId: contextSnapshot.conversation.parentBranchId }),
      ...(contextSnapshot.conversation.runId === undefined
        ? {}
        : { runId: contextSnapshot.conversation.runId }),
      contextSnapshotId: contextSnapshot.id,
      ...(contextSnapshot.workspace?.repositoryId === undefined
        ? {}
        : { repositoryId: contextSnapshot.workspace.repositoryId }),
      ...(contextSnapshot.workspace?.projectId === undefined
        ? {}
        : { projectId: contextSnapshot.workspace.projectId }),
      ...(contextSnapshot.workspace?.canonicalPath === undefined
        ? {}
        : { workspacePath: contextSnapshot.workspace.canonicalPath }),
      topicIds: contextSnapshot.situation.topicIds,
      ...(contextSnapshot.situation.taskId === undefined
        ? {}
        : { taskId: contextSnapshot.situation.taskId }),
      interactionMode: contextSnapshot.situation.interactionMode,
      environmentFingerprint: stableHash(
        "environment:v1",
        JSON.stringify(contextSnapshot.environment ?? {}),
      ),
      capabilitySnapshotId: contextSnapshot.capability.snapshotId,
    };
    const refreshSequence = ++contextRefreshSequence;
    const refreshState = contextState;
    const refreshPrompt = event.prompt;
    const refreshCwd = context.cwd;
    const refreshTaskInput = taskInput;
    backgroundQueue.enqueue({
      kind: "topic.refresh",
      coalesceKey: `context.refresh:${context.sessionManager.getSessionId()}`,
      priority: "fresh",
      execute: async () => {
        const refreshedIdentity = await resolvePiProjectIdentity(refreshCwd).catch(() =>
          fallbackProjectIdentity(refreshCwd),
        );
        let refreshedTopicIds = topicIds;
        if (refreshState !== undefined) {
          const topic =
            explicitTopic === undefined
              ? await refreshState
                  .inferTopic(identityNamespace, refreshPrompt)
                  .catch(() => undefined)
              : await refreshState
                  .observeTopicLabel(identityNamespace, explicitTopic)
                  .catch(() => undefined);
          if (topic?.state === "active") refreshedTopicIds = [topic.topicId];
          const resolvedTask = await refreshState
            .resolveTask({ ...refreshTaskInput, topicIds: refreshedTopicIds })
            .catch(() => undefined);
          if (refreshSequence === contextRefreshSequence) {
            turnContext.updateTopic(refreshedTopicIds[0], topic === undefined ? 0 : 0.85);
            turnContext.updateTask(
              resolvedTask?.taskId ?? taskIdentityId(refreshTaskInput),
              "active",
              resolvedTask === undefined ? 0.5 : 0.8,
            );
          }
        }
        if (refreshSequence === contextRefreshSequence) activeProjectIdentity = refreshedIdentity;
      },
    });
    if (captureSession !== undefined) {
      const session = captureSession;
      const goal = event.prompt;
      const captureScope = scopeContext;
      captureQueue.enqueue(async () => {
        await session.start({ goal, scope: captureScope });
      });
    }
    const searchMemoryActive = (event.systemPromptOptions.selectedTools ?? []).includes(
      "search_memory",
    );
    return {
      systemPrompt:
        !searchMemoryActive || event.systemPrompt.includes("<pi-mentis-tools>")
          ? event.systemPrompt
          : `${event.systemPrompt}\n\n${memorySystemPrompt}`,
    };
  });
  pi.on("tool_execution_start", (event) => {
    if (captureSession === undefined) return;
    const session = captureSession;
    captureQueue.enqueue(async () => {
      await session.toolStarted(event.toolCallId, event.toolName, event.args);
    });
  });
  pi.on("tool_result", async (event, context) => {
    const text = event.content
      .filter(
        (item): item is Extract<(typeof event.content)[number], { type: "text" }> =>
          item.type === "text",
      )
      .map((item) => item.text)
      .join("\n");
    const session = captureSession;
    if (session === undefined) return;
    const envelope = await recoverFullToolResult({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      text,
      details: event.details,
      isError: event.isError,
      cwd: context.cwd,
      completedAt: Date.now(),
    });
    const result = await captureQueue
      .run(() => session.toolResult(envelope))
      .catch(() => undefined);
    if (result === undefined || result.mode === "inline") return;
    const readKey = readRequestKey(envelope);
    const isFullRead = canReturnFullRead(envelope, result);
    const resultText = !isFullRead
      ? result.modelText
      : readKey !== undefined && completedLargeReads.has(readKey)
        ? compactReadReference(envelope, result)
        : fullReadResult(envelope, result);
    if (isFullRead && readKey !== undefined) completedLargeReads.add(readKey);
    return {
      content: [
        { type: "text" as const, text: resultText },
        ...event.content.filter((item) => item.type === "image"),
      ],
      details: {
        original: event.details,
        piMentis: { symbolic: result.symbolic, tokenAccounting: result.tokenAccounting },
      },
    };
  });
  pi.on("session_compact", (event) => {
    if (captureSession === undefined) return;
    const session = captureSession;
    captureQueue.enqueue(async () => {
      await session.compact(event.compactionEntry.summary, event.reason, event.willRetry);
    });
  });
  pi.on("agent_settled", () => {
    if (captureSession !== undefined) {
      const session = captureSession;
      captureQueue.enqueue(async () => {
        await session.finish();
      });
    }
    deferredRelationships?.settled();
  });
  pi.on("session_shutdown", async (event) => {
    deferredRelationships?.close();
    durableRelationships?.close();
    await Promise.all([
      backgroundQueue.drain({ timeoutMs: 1_000, cancelPending: true }),
      captureQueue.drain(),
    ]);
    if (event.reason === "quit") {
      await runtime.dispose();
    } else {
      await runtime.dispose();
      resetSharedStores();
      await resetGlobalRuntime();
    }
  });
}
