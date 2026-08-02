import { arch, platform } from "node:os";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  BackgroundScheduler,
  EvidenceAuthority,
  MentisContextResolver,
  ProviderPriority,
  TaskPriority,
  assertPiCompatibility,
  detectInstalledPackageVersion,
  getOrCreateRuntime,
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
  PiCaptureSession,
  createExperienceLearningService,
  createPiEvidenceStore,
  createTaskGraphService,
  createMemoryService,
  deriveExperienceObservation,
  memoryContentGroundedInUserPrompt,
  referencedMemoryIds,
  resolvePiProjectIdentity,
  taskIdentityId,
  type MemoryService,
  type PiEvidenceStore,
  type PiProjectIdentity,
  type PiScopeContext,
} from "@pi-mentis/pi-mentis-memory-core";
import { InMemoryTelemetry } from "@pi-mentis/pi-mentis-observability";
import {
  formatPiToolJson,
  notifyWhenUiAvailable,
  PI_TOOL_OUTPUT_LIMIT_DESCRIPTION,
} from "@pi-mentis/pi-mentis-pi-extension-support";
import {
  AdaptivePolicyService,
  EffectivenessService,
  createRetrievalService,
  evaluateReplayCandidate,
  type CreateRetrievalServiceOptions,
  type RetrievalService,
} from "@pi-mentis/pi-mentis-retrieval";
import {
  SiliconFlowEmbeddingProvider,
  SiliconFlowRerankProvider,
} from "@pi-mentis/pi-mentis-siliconflow";
import { acquireSharedZvecStore, type SharedZvecStoreHandle } from "@pi-mentis/pi-mentis-zvec";

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

function fallbackProjectIdentity(cwd: string): PiProjectIdentity {
  return { workspacePath: cwd, manifestTypes: [] };
}

function registerMemoryTools(
  pi: ExtensionAPI,
  memory: MemoryService,
  retrieval: RetrievalService | undefined,
  evidence: PiEvidenceStore,
  currentScopeContext: () => PiScopeContext,
  currentContextSnapshot: () => MentisContextSnapshot | undefined,
  currentEvidenceRef: () => EvidenceRef | undefined,
  onTrace: (traceId: string) => void,
): void {
  pi.registerTool({
    name: "commit_memory",
    label: "Commit memory",
    description: `Commit evidence-bound durable memory with scope, type, confidence, and conflict handling. ${PI_TOOL_OUTPUT_LIMIT_DESCRIPTION}`,
    parameters: Type.Object({
      content: Type.String({ minLength: 3 }),
      type: StringEnum([
        "preference",
        "requirement",
        "fact",
        "decision",
        "procedural",
        "episodic",
        "task",
      ] as const),
      scopeKind: StringEnum([
        "user",
        "workspace",
        "project",
        "repository",
        "topic",
        "task",
        "session",
        "branch",
        "run",
      ] as const),
      scopeId: Type.String({ minLength: 1 }),
      confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      importance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      authority: Type.Optional(
        Type.Union([
          Type.Literal(10),
          Type.Literal(20),
          Type.Literal(30),
          Type.Literal(40),
          Type.Literal(50),
          Type.Literal(60),
          Type.Literal(70),
          Type.Literal(80),
          Type.Literal(90),
          Type.Literal(100),
        ]),
      ),
      supersedesIds: Type.Optional(Type.Array(Type.String())),
      factKey: Type.Optional(Type.String({ minLength: 1 })),
      cardinality: Type.Optional(StringEnum(["single", "set", "ordered", "event"] as const)),
      observedAt: Type.Optional(Type.Integer({ minimum: 0 })),
      idempotencyKey: Type.Optional(Type.String({ minLength: 1 })),
      branchClaimState: Type.Optional(
        StringEnum(["global", "hypothesis", "verified", "merged", "abandoned"] as const),
      ),
      retractsFact: Type.Optional(Type.Boolean()),
      applicability: Type.Optional(
        Type.Object({
          os: Type.Optional(Type.Array(Type.String())),
          strictOs: Type.Optional(Type.Boolean()),
          architecture: Type.Optional(Type.Array(Type.String())),
          strictArchitecture: Type.Optional(Type.Boolean()),
          runtime: Type.Optional(Type.String()),
          runtimeVersionMin: Type.Optional(Type.String()),
          runtimeVersionMax: Type.Optional(Type.String()),
          packageManager: Type.Optional(Type.String()),
          repositoryId: Type.Optional(Type.String()),
          projectId: Type.Optional(Type.String()),
        }),
      ),
      premises: Type.Optional(
        Type.Array(
          Type.Object({
            kind: StringEnum(["manifest", "tool", "package-manager", "context"] as const),
            value: Type.String({ minLength: 1 }),
            required: Type.Boolean(),
          }),
        ),
      ),
    }),
    async execute(_toolCallId, parameters, signal) {
      const current = currentScopeContext();
      const observedAt = parameters.observedAt ?? Date.now();
      const userGrounded = memoryContentGroundedInUserPrompt(
        parameters.content,
        currentContextSnapshot()?.situation.activeGoal,
      );
      const activeContext = currentContextSnapshot();
      const inferredApplicability =
        parameters.applicability ??
        (parameters.type === "procedural"
          ? {
              ...(current.repositoryId === undefined ? {} : { repositoryId: current.repositoryId }),
              ...(current.projectId === undefined ? {} : { projectId: current.projectId }),
              ...(activeContext?.environment?.os === undefined
                ? {}
                : { os: [activeContext.environment.os] }),
              ...(activeContext?.environment?.architecture === undefined
                ? {}
                : { architecture: [activeContext.environment.architecture] }),
              ...(activeContext?.environment?.runtime === undefined
                ? {}
                : { runtime: activeContext.environment.runtime }),
              ...(activeContext?.environment?.packageManager === undefined
                ? {}
                : { packageManager: activeContext.environment.packageManager }),
            }
          : undefined);
      const result = await memory.commit(
        {
          content: parameters.content,
          type: parameters.type,
          scope: { kind: parameters.scopeKind, id: parameters.scopeId },
          scopeContext: current,
          authority: Math.min(
            parameters.authority ??
              (userGrounded
                ? EvidenceAuthority.UserCurrentInstruction
                : EvidenceAuthority.AssistantInference),
            userGrounded
              ? EvidenceAuthority.UserCurrentInstruction
              : EvidenceAuthority.AssistantInference,
          ) as 10 | 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90 | 100,
          ...(parameters.confidence === undefined ? {} : { confidence: parameters.confidence }),
          ...(parameters.importance === undefined ? {} : { importance: parameters.importance }),
          ...(parameters.supersedesIds === undefined
            ? {}
            : { supersedesIds: parameters.supersedesIds }),
          ...(parameters.factKey === undefined ? {} : { factKey: parameters.factKey }),
          ...(parameters.cardinality === undefined ? {} : { cardinality: parameters.cardinality }),
          observedAt,
          ...(parameters.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: parameters.idempotencyKey }),
          ...(parameters.branchClaimState === undefined
            ? {}
            : { branchClaimState: parameters.branchClaimState }),
          ...(parameters.retractsFact === undefined
            ? {}
            : { retractsFact: parameters.retractsFact }),
          ...(inferredApplicability === undefined ? {} : { applicability: inferredApplicability }),
          ...(parameters.premises === undefined ? {} : { premises: parameters.premises }),
          contentOrigin: userGrounded ? "user" : "model",
          evidenceRefs: [
            currentEvidenceRef() ?? {
              kind: userGrounded ? "user" : "event",
              id: current.contextSnapshotId ?? current.runId ?? current.sessionId ?? "current-user",
              observedAt,
            },
          ],
        },
        signal === undefined ? {} : { signal },
      );
      return {
        content: [{ type: "text", text: formatPiToolJson(result) }],
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "search_memory",
    label: "Search memory",
    description:
      retrieval === undefined
        ? `Search durable Pi Mentis memory. ${PI_TOOL_OUTPUT_LIMIT_DESCRIPTION}`
        : `Search Pi Mentis knowledge first, then knowledge-guided durable memory. ${PI_TOOL_OUTPUT_LIMIT_DESCRIPTION}`,
    parameters: Type.Object({
      id: Type.Optional(Type.String({ minLength: 1 })),
      artifactId: Type.Optional(Type.String({ minLength: 1 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      length: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_536 })),
      query: Type.Optional(Type.String({ minLength: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      scopeKind: Type.Optional(
        StringEnum([
          "user",
          "workspace",
          "project",
          "repository",
          "topic",
          "task",
          "session",
          "branch",
          "run",
        ] as const),
      ),
      scopeId: Type.Optional(Type.String({ minLength: 1 })),
      temporalMode: Type.Optional(StringEnum(["current", "historical", "all"] as const)),
    }),
    async execute(_toolCallId, parameters, signal) {
      if (
        parameters.id === undefined &&
        parameters.query === undefined &&
        parameters.artifactId === undefined
      ) {
        throw new Error("search_memory requires id, artifactId, query, or a combination");
      }
      if (parameters.artifactId !== undefined) {
        const scopeContext = currentScopeContext();
        const artifact = await evidence.getArtifact(parameters.artifactId, {
          ...(signal === undefined ? {} : { signal }),
          scopeContext,
        });
        const range = await evidence.readArtifactRange(parameters.artifactId, {
          ...(signal === undefined ? {} : { signal }),
          scopeContext,
          offset: parameters.offset ?? 0,
          length: parameters.length ?? 32_768,
        });
        const result = {
          artifact,
          range,
          content: range?.content,
        };
        return {
          content: [{ type: "text" as const, text: formatPiToolJson(result) }],
          details: undefined,
        };
      }
      const exact =
        parameters.id === undefined
          ? undefined
          : await memory.get(parameters.id, {
              ...(signal === undefined ? {} : { signal }),
              scopeContext: currentScopeContext(),
            });
      const exactEvidence =
        exact === undefined
          ? []
          : await evidence.readEvidence(exact.evidenceRefs, {
              ...(signal === undefined ? {} : { signal }),
              scopeContext: currentScopeContext(),
            });
      if (parameters.query === undefined) {
        const result = { exact, evidence: exactEvidence };
        return {
          content: [{ type: "text" as const, text: formatPiToolJson(result) }],
          details: undefined,
        };
      }
      if (parameters.id !== undefined) {
        const relatedIds = [
          ...(exact?.supersedesIds ?? []),
          ...(exact?.supersededById === undefined ? [] : [exact.supersededById]),
          ...(exact?.conflictsWithIds ?? []),
        ];
        const evolution = (
          await Promise.all(
            relatedIds.map((id) =>
              memory.get(id, {
                ...(signal === undefined ? {} : { signal }),
                scopeContext: currentScopeContext(),
                ...(parameters.temporalMode === undefined
                  ? {}
                  : { temporalMode: parameters.temporalMode }),
              }),
            ),
          )
        ).filter((record) => record !== undefined);
        const evidenceMatches = await evidence.searchEvidence(
          exact?.evidenceRefs ?? [],
          parameters.query,
          {
            ...(signal === undefined ? {} : { signal }),
            scopeContext: currentScopeContext(),
          },
        );
        const result = { exact, evolution, evidence: evidenceMatches };
        return {
          content: [{ type: "text" as const, text: formatPiToolJson(result) }],
          details: undefined,
        };
      }
      const current = currentScopeContext();
      const scopes =
        parameters.scopeKind === undefined || parameters.scopeId === undefined
          ? [
              ...(current.repositoryId === undefined
                ? []
                : [
                    {
                      kind: "repository" as const,
                      id: current.repositoryId,
                    },
                  ]),
              ...(current.projectId === undefined
                ? []
                : [{ kind: "project" as const, id: current.projectId }]),
              ...(current.taskId === undefined
                ? []
                : [{ kind: "task" as const, id: current.taskId }]),
              ...(current.topicIds ?? []).map((id) => ({
                kind: "topic" as const,
                id,
              })),
              { kind: "user" as const, id: current.userId },
            ]
          : [{ kind: parameters.scopeKind, id: parameters.scopeId }];
      const activeSnapshot = currentContextSnapshot();
      const result =
        retrieval === undefined
          ? await memory.search(
              {
                text: parameters.query,
                ...(parameters.limit === undefined ? {} : { limit: parameters.limit }),
                scopes,
                scopeContext: currentScopeContext(),
              },
              signal === undefined ? {} : { signal },
            )
          : await retrieval.search(
              {
                text: parameters.query,
                ...(parameters.limit === undefined ? {} : { limit: parameters.limit }),
                memoryScopes: scopes,
                memoryScopeContext: currentScopeContext(),
                ...(parameters.temporalMode === undefined
                  ? {}
                  : { temporalMode: parameters.temporalMode }),
                ...(activeSnapshot === undefined ? {} : { contextSnapshot: activeSnapshot }),
              },
              { ...(signal === undefined ? {} : { signal }), allowRerank: true, onTrace },
            );
      return {
        content: [
          {
            type: "text",
            text: formatPiToolJson({
              ...(parameters.id === undefined ? {} : { exact, evidence: exactEvidence }),
              search: result,
            }),
          },
        ],
        details: undefined,
      };
    },
  });
}

export default async function piMentisMemoryExtension(pi: ExtensionAPI): Promise<void> {
  const installedVersion = await detectInstalledPackageVersion(
    "@earendil-works/pi-coding-agent",
    import.meta.url,
  );
  assertPiCompatibility(installedVersion);
  const config = await loadConfig(process.cwd());
  const scheduler = new BackgroundScheduler(config.performance.queue);
  const telemetry = new InMemoryTelemetry();
  const runtime = getOrCreateRuntime();
  let storeHandle: SharedZvecStoreHandle | undefined;
  let branchId = "root";
  let parentBranchId: string | undefined;
  let captureSession: PiCaptureSession | undefined;
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
      return createMemoryService({
        store: storeHandle.store,
        embedding,
        embeddingSpace: embeddingSpace(config),
        dimensions: config.inference.siliconflow.embedding.dimensions,
        telemetry,
        viewsEnabled: config.intelligence.views.enabled,
        viewTtlMs: config.intelligence.views.ttlMs,
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
    sessionMode = event.reason === "fork" ? "forked" : "persistent";
    await runtime.ready(context.signal);
    const memory = runtime.getMemory<MemoryService>();
    if (memory === undefined || storeHandle === undefined) return;
    const project = await resolvePiProjectIdentity(context.cwd).catch(() =>
      fallbackProjectIdentity(context.cwd),
    );
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
      id: `temporal-repair:${scopeContext.userId}`,
      deduplicationKey: `temporal-repair:${scopeContext.userId}`,
      priority: TaskPriority.SessionMaintenance,
      estimatedBytes: 1024,
      run: async (signal) => {
        await evidenceStore?.recoverArtifacts({ signal });
        await evidenceStore?.collectExpiredArtifacts(undefined, { signal });
        await storeHandle?.store.collectSupersededGenerations(config.storage.generationRetentionMs);
        if (config.intelligence.temporal.repairOnStartup) {
          await memory.repairTemporal?.({ signal });
        }
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
    if (!registered) {
      registerMemoryTools(
        pi,
        memory,
        runtime.getRetrieval<RetrievalService>(),
        evidenceStore,
        () => scopeContext,
        () => contextSnapshot,
        () =>
          captureSession?.goalEventId === undefined
            ? undefined
            : { kind: "event", id: captureSession.goalEventId, observedAt: Date.now() },
        (traceId) => {
          latestRetrievalTraceId = traceId;
        },
      );
      pi.registerCommand("mentis", {
        description: "Show Pi Mentis context, temporal, view, effectiveness, and policy status",
        handler: async (rawArguments, context) => {
          const action = rawArguments.trim() || "status";
          if (action !== "status") {
            notifyWhenUiAvailable(context, "Usage: /mentis status", "error");
            return;
          }
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
            ].map(async ({ kind, id }) => memory.getView?.(kind, id, scopeContext)),
          );
          notifyWhenUiAvailable(
            context,
            formatPiToolJson({
              runtime: runtime.snapshot(),
              scheduler: scheduler.snapshot(),
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
                repairOnStartup: config.intelligence.temporal.repairOnStartup,
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
  pi.on("input", async (event) => {
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
      await captureSession?.steer(event.text).catch(() => undefined);
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
  pi.on("before_agent_start", async (event, context) => {
    latestRetrievalTraceId = undefined;
    const identity = await resolvePiProjectIdentity(context.cwd).catch(() =>
      fallbackProjectIdentity(context.cwd),
    );
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
    let topicIds: readonly string[] = [];
    if (explicitTopic !== undefined && contextState !== undefined) {
      const topic = await contextState
        .observeTopicLabel(identityNamespace, explicitTopic)
        .catch(() => undefined);
      if (topic?.state === "active") topicIds = [topic.topicId];
    } else if (contextState !== undefined) {
      const topic = await contextState
        .inferTopic(identityNamespace, event.prompt)
        .catch(() => undefined);
      if (topic?.state === "active") topicIds = [topic.topicId];
    }
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
    const resolvedTask = await contextState?.resolveTask(taskInput).catch(() => undefined);
    const taskId = resolvedTask?.taskId ?? taskIdentityId(taskInput);
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
    const previousSnapshot = config.intelligence.context.persistSnapshots
      ? await contextState
          ?.latestSnapshot(identityFacet, context.sessionManager.getSessionId())
          .catch(() => undefined)
      : undefined;
    contextSnapshot =
      contextState === undefined
        ? contextResolver.resolve(fastContext).snapshot
        : contextState.resolveFromPersistent(fastContext, previousSnapshot).snapshot;
    if (contextState !== undefined && config.intelligence.context.persistSnapshots) {
      await contextState.persistSnapshot(contextSnapshot).catch(() => undefined);
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
    await captureSession
      ?.start({
        goal: event.prompt,
        scope: scopeContext,
      })
      .catch(() => undefined);
  });
  pi.on("tool_execution_start", async (event) => {
    await captureSession
      ?.toolStarted(event.toolCallId, event.toolName, event.args)
      .catch(() => undefined);
  });
  pi.on("tool_result", async (event, context) => {
    const text = event.content
      .filter(
        (item): item is Extract<(typeof event.content)[number], { type: "text" }> =>
          item.type === "text",
      )
      .map((item) => item.text)
      .join("\n");
    const result = await captureSession
      ?.toolResult({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        text,
        details: event.details,
        isError: event.isError,
        cwd: context.cwd,
        completedAt: Date.now(),
      })
      .catch(() => undefined);
    if (result === undefined || result.mode === "inline") return;
    return {
      content: [
        { type: "text" as const, text: result.modelText },
        ...event.content.filter((item) => item.type === "image"),
      ],
      details: {
        original: event.details,
        piMentis: { symbolic: result.symbolic, tokenAccounting: result.tokenAccounting },
      },
    };
  });
  pi.on("session_compact", async (event) => {
    await captureSession
      ?.compact(event.compactionEntry.summary, event.reason, event.willRetry)
      .catch(() => undefined);
  });
  pi.on("agent_settled", async () => {
    await captureSession?.finish().catch(() => undefined);
  });
  pi.on("session_shutdown", async (event) => {
    if (event.reason === "reload") await resetGlobalRuntime();
    else await runtime.dispose();
  });
}
