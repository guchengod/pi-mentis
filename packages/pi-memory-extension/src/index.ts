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
} from "@pi-mentis/pi-mentis-core";
import type {
  EmbeddingProvider,
  EmbeddingSpaceIdentity,
  RerankProvider,
} from "@pi-mentis/pi-mentis-inference";
import {
  PiCaptureSession,
  createExperienceLearningService,
  createPiEvidenceStore,
  createMemoryService,
  deriveExperienceObservation,
  resolvePiProjectIdentity,
  type MemoryService,
  type PiEvidenceStore,
  type PiScopeContext,
} from "@pi-mentis/pi-mentis-memory-core";
import { InMemoryTelemetry } from "@pi-mentis/pi-mentis-observability";
import {
  formatPiToolJson,
  PI_TOOL_OUTPUT_LIMIT_DESCRIPTION,
} from "@pi-mentis/pi-mentis-pi-extension-support";
import {
  createRetrievalService,
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

function registerMemoryTools(
  pi: ExtensionAPI,
  memory: MemoryService,
  retrieval: RetrievalService | undefined,
  evidence: PiEvidenceStore,
  currentScopeContext: () => PiScopeContext,
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
    }),
    async execute(_toolCallId, parameters, signal) {
      const result = await memory.commit(
        {
          content: parameters.content,
          type: parameters.type,
          scope: { kind: parameters.scopeKind, id: parameters.scopeId },
          scopeContext: currentScopeContext(),
          authority: parameters.authority ?? EvidenceAuthority.UserCurrentInstruction,
          ...(parameters.confidence === undefined ? {} : { confidence: parameters.confidence }),
          ...(parameters.importance === undefined ? {} : { importance: parameters.importance }),
          ...(parameters.supersedesIds === undefined
            ? {}
            : { supersedesIds: parameters.supersedesIds }),
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
    }),
    async execute(_toolCallId, parameters, signal) {
      if (parameters.id === undefined && parameters.query === undefined) {
        throw new Error("search_memory requires id, query, or both");
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
          : await evidence.readEvidence(exact.evidenceRefs, signal === undefined ? {} : { signal });
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
              }),
            ),
          )
        ).filter((record) => record !== undefined);
        const terms = parameters.query.toLowerCase().split(/\s+/).filter(Boolean);
        const evidenceMatches = exactEvidence.filter((item) => {
          const text = JSON.stringify(item).toLowerCase();
          return terms.every((term) => text.includes(term));
        });
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
              },
              { ...(signal === undefined ? {} : { signal }), allowRerank: true },
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
  let projectIdentity: Awaited<ReturnType<typeof resolvePiProjectIdentity>> | undefined;
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
      return createMemoryService({
        store: storeHandle.store,
        embedding,
        embeddingSpace: embeddingSpace(config),
        dimensions: config.inference.siliconflow.embedding.dimensions,
        telemetry,
      });
    },
    dispose: async () => {
      await scheduler.close();
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
      });
    },
  });

  let registered = false;

  pi.on("session_start", async (event, context) => {
    sessionMode = event.reason === "fork" ? "forked" : "persistent";
    await runtime.ready(context.signal);
    const memory = runtime.getMemory<MemoryService>();
    if (memory === undefined || storeHandle === undefined) return;
    const project = await resolvePiProjectIdentity(context.cwd);
    projectIdentity = project;
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
    if (config.memory.captureEnabled) {
      const experience = createExperienceLearningService({ store: storeHandle.store, memory });
      captureSession ??= new PiCaptureSession(
        evidenceStore,
        config.memory.offload,
        (episode, events, outcome) => {
          const observation = deriveExperienceObservation(episode, events, outcome, {
            embeddingModel: config.inference.siliconflow.embedding.model,
            embeddingDimensions: String(config.inference.siliconflow.embedding.dimensions),
            rerankModel: config.inference.siliconflow.rerank.model,
            piVersion: config.runtime.piVersion,
          });
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
      );
    }
    if (!registered) {
      registerMemoryTools(
        pi,
        memory,
        runtime.getRetrieval<RetrievalService>(),
        evidenceStore,
        () => scopeContext,
      );
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
    if (event.streamingBehavior === "steer") await captureSession?.steer(event.text);
  });
  pi.on("before_agent_start", async (event, context) => {
    const identity = projectIdentity ?? (await resolvePiProjectIdentity(context.cwd));
    projectIdentity = identity;
    const currentEntryId = context.sessionManager.getLeafId() ?? undefined;
    const parentEntryId =
      currentEntryId === undefined
        ? undefined
        : (context.sessionManager.getEntry(currentEntryId)?.parentId ?? undefined);
    const tools = [...(event.systemPromptOptions.selectedTools ?? [])].sort();
    const skills = [...(event.systemPromptOptions.skills ?? [])].map((skill) => skill.name).sort();
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
      JSON.stringify({ tools, skills, scopedModels }),
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
          };
    contextSnapshot = contextResolver.resolve({
      runtimeKey: context.sessionManager.getSessionId(),
      identity: {
        tenantId: "local",
        userId: "local",
        appId: "pi",
        agentId: "pi-mentis-memory",
      },
      conversation: {
        sessionId: context.sessionManager.getSessionId(),
        ...(currentEntryId === undefined ? {} : { branchId: currentEntryId, currentEntryId }),
        ...(parentEntryId === undefined ? {} : { parentBranchId: parentEntryId }),
        runId: operationId("operation"),
        sessionMode,
      },
      ...(workspace === undefined ? {} : { workspace }),
      situation: {
        topicIds: contextSnapshot?.situation.topicIds ?? [],
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
      },
      capability: {
        piVersion: config.runtime.piVersion,
        ...(context.model?.provider === undefined ? {} : { provider: context.model.provider }),
        ...(context.model?.id === undefined ? {} : { model: context.model.id }),
        extensionsHash: "runtime-managed",
        skillsHash: stableHash("skills:v1", JSON.stringify(skills)),
        mcpHash: "runtime-managed",
        toolsHash: stableHash("tools:v1", JSON.stringify(tools)),
        snapshotId: capabilityFingerprint,
      },
    }).snapshot;
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
      interactionMode: contextSnapshot.situation.interactionMode,
      environmentFingerprint: stableHash(
        "environment:v1",
        JSON.stringify(contextSnapshot.environment ?? {}),
      ),
      capabilitySnapshotId: contextSnapshot.capability.snapshotId,
    };
    await captureSession?.start({
      goal: event.prompt,
      scope: scopeContext,
    });
  });
  pi.on("tool_execution_start", async (event) => {
    await captureSession?.toolStarted(event.toolCallId, event.toolName, event.args);
  });
  pi.on("tool_result", async (event, context) => {
    const text = event.content
      .filter(
        (item): item is Extract<(typeof event.content)[number], { type: "text" }> =>
          item.type === "text",
      )
      .map((item) => item.text)
      .join("\n");
    const result = await captureSession?.toolResult({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      text,
      details: event.details,
      isError: event.isError,
      cwd: context.cwd,
      completedAt: Date.now(),
    });
    if (result === undefined || result.mode === "inline") return;
    return {
      content: [
        { type: "text" as const, text: result.modelText },
        ...event.content.filter((item) => item.type === "image"),
      ],
      details: { original: event.details, piMentis: result.symbolic },
    };
  });
  pi.on("session_compact", async (event) => {
    await captureSession?.compact(event.compactionEntry.summary, event.reason, event.willRetry);
  });
  pi.on("agent_settled", async () => {
    await captureSession?.finish();
  });
  pi.on("session_shutdown", async (event) => {
    if (event.reason === "reload") await resetGlobalRuntime();
    else await runtime.dispose();
  });
}
