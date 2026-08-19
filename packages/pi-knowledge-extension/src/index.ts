import { stat } from "node:fs/promises";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  BackgroundScheduler,
  ProviderPriority,
  assertPiCompatibility,
  detectInstalledPackageVersion,
  getEmbeddingRuntimeResolution,
  getStorageStatus,
  getOrCreateRuntime,
  globalConfigPath,
  loadConfig,
  resetGlobalRuntime,
  type PersistentIntelligenceRuntime,
  type PiMentisConfig,
} from "@pi-mentis/pi-mentis-core";
import type {
  EmbeddingProvider,
  EmbeddingSpaceIdentity,
  RerankProvider,
} from "@pi-mentis/pi-mentis-inference";
import {
  createKnowledgeService,
  enqueueKnowledgeEmbeddingMigration,
  type KnowledgeService,
} from "@pi-mentis/pi-mentis-knowledge-core";
import { InMemoryTelemetry } from "@pi-mentis/pi-mentis-observability";
import {
  formatPiToolJson,
  formatMentisHelp,
  normalizePiPathArgument,
  notifyWhenUiAvailable,
  PI_TOOL_OUTPUT_LIMIT_DESCRIPTION,
} from "@pi-mentis/pi-mentis-pi-extension-support";
import { createRetrievalService, type RetrievalService } from "@pi-mentis/pi-mentis-retrieval";
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

let config: PiMentisConfig;
let scheduler: BackgroundScheduler;
let storeHandle: SharedZvecStoreHandle | undefined;
let store: ZvecStore | undefined;

function localKnowledgeScope() {
  return {
    tenantId: "local",
    userId: "local",
    appId: "pi",
    agentId: "pi-mentis-knowledge",
  } as const;
}

function embeddingSpace(current: PiMentisConfig): EmbeddingSpaceIdentity {
  return {
    providerId: "siliconflow",
    modelId: current.inference.siliconflow.embedding.model,
    dimensions: current.inference.siliconflow.embedding.dimensions,
    normalization: "none",
    preprocessingVersion: "pi-mentis-text-v1",
    inputKindVersion: "pi-mentis-input-kind-v1",
  };
}

function spaces(
  current: PiMentisConfig,
): Readonly<Record<"knowledge" | "memory" | "capability", EmbeddingSpaceIdentity>> {
  const identity = embeddingSpace(current);
  return { knowledge: identity, memory: identity, capability: identity };
}

function embeddingRuntimeDiagnostics(current: PiMentisConfig, currentStore?: ZvecStore) {
  const resolution = getEmbeddingRuntimeResolution(current);
  return {
    ...resolution,
    ...(currentStore === undefined
      ? {}
      : {
          activeIndexGenerations: currentStore.manifest.generations
            .filter((generation) => generation.state === "active")
            .map((generation) => ({
              kind: generation.kind,
              generationId: generation.generationId,
              embeddingSpace: generation.embeddingSpace,
            })),
        }),
  };
}

function sourceInput(kind: string, value: string) {
  if (kind === "text") return { kind: "text" as const, text: value };
  if (kind === "url") return { kind: "url" as const, url: value };
  const normalizedPath = normalizePiPathArgument(value);
  if (kind === "directory") return { kind: "directory" as const, path: normalizedPath };
  if (kind === "workspace") return { kind: "workspace" as const, path: normalizedPath };
  if (kind === "git") return { kind: "git" as const, path: normalizedPath };
  if (kind === "pi-package") return { kind: "pi-package" as const, path: normalizedPath };
  if (kind === "skill") return { kind: "skill" as const, path: normalizedPath };
  if (kind === "mcp") return { kind: "mcp" as const, path: normalizedPath };
  return { kind: "file" as const, path: normalizedPath };
}

async function knowledgeCommandSource(target: string, maxDepth?: number) {
  const normalizedTarget = normalizePiPathArgument(target);
  if (/^https?:\/\//.test(normalizedTarget)) {
    return { kind: "url" as const, url: normalizedTarget };
  }
  try {
    const metadata = await stat(normalizedTarget);
    if (metadata.isDirectory()) {
      return {
        kind: "directory" as const,
        path: normalizedTarget,
        ...(maxDepth === undefined ? {} : { maxDepth }),
      };
    }
  } catch {
    // Preserve the file-shaped command so the background job reports the path error.
  }
  return { kind: "file" as const, path: normalizedTarget };
}

function registerKnowledgeTools(
  pi: ExtensionAPI,
  service: KnowledgeService,
  retrieval: RetrievalService | undefined,
  manualSearchTimeoutMs: number,
  scopeContext: () => {
    readonly tenantId: string;
    readonly userId: string;
    readonly appId: string;
    readonly agentId: string;
  },
): void {
  pi.registerTool({
    name: "commit_knowledge",
    label: "Commit knowledge",
    description: `Queue a file, directory, URL, text, Git repository, Pi package, Skill, or MCP schema for durable knowledge indexing. ${PI_TOOL_OUTPUT_LIMIT_DESCRIPTION}`,
    parameters: Type.Object({
      kind: StringEnum([
        "file",
        "directory",
        "workspace",
        "git",
        "url",
        "text",
        "pi-package",
        "skill",
        "mcp",
      ] as const),
      value: Type.String({ minLength: 1 }),
      namespace: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(_toolCallId, parameters, signal) {
      const receipt = await service.enqueueIngest(
        {
          source: sourceInput(parameters.kind, parameters.value),
          ...(parameters.namespace === undefined ? {} : { namespace: parameters.namespace }),
          scopeContext: scopeContext(),
        },
        { ...(signal === undefined ? {} : { signal }), priority: "user" },
      );
      return {
        content: [{ type: "text", text: formatPiToolJson(receipt) }],
        details: receipt,
      };
    },
  });
  pi.registerTool({
    name: "search_knowledge",
    label: "Search knowledge",
    description: `Search durable user, project, and Pi capability knowledge with Dense and full-text retrieval. ${PI_TOOL_OUTPUT_LIMIT_DESCRIPTION}`,
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      namespace: Type.Optional(Type.String({ minLength: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(_toolCallId, parameters, signal) {
      const securityScope = scopeContext();
      const query = {
        text: parameters.query,
        ...(parameters.namespace === undefined ? {} : { namespace: parameters.namespace }),
        ...(parameters.limit === undefined ? {} : { limit: parameters.limit }),
        scopeContext: securityScope,
      };
      const result =
        retrieval === undefined
          ? await service.search(query, {
              ...(signal === undefined ? {} : { signal }),
              timeoutMs: manualSearchTimeoutMs,
            })
          : await retrieval.search(
              { ...query, memoryScopeContext: securityScope },
              {
                ...(signal === undefined ? {} : { signal }),
                timeoutMs: manualSearchTimeoutMs,
                allowRerank: true,
              },
            );
      return {
        content: [{ type: "text", text: formatPiToolJson(result) }],
        details: result.diagnostics,
      };
    },
  });
}

function registerKnowledgeCommand(
  pi: ExtensionAPI,
  runtime: PersistentIntelligenceRuntime,
  currentConfig: PiMentisConfig,
): void {
  const helpText = formatMentisHelp({
    configPath: globalConfigPath(),
    memory: false,
    knowledge: true,
  });
  pi.registerCommand("mentis", {
    description: "Show Pi Mentis help or current status",
    handler: async (rawArguments, context) => {
      const action = rawArguments.trim() || "help";
      if (action === "help") {
        notifyWhenUiAvailable(context, helpText, "info");
        return;
      }
      if (action === "status") {
        notifyWhenUiAvailable(context, formatPiToolJson(runtime.snapshot()), "info");
        return;
      }
      notifyWhenUiAvailable(context, "Usage: /mentis help | /mentis status", "error");
    },
  });
  pi.registerCommand("kb", {
    description: "Manage Pi Mentis knowledge; use /kb help for detailed usage",
    handler: async (rawArguments, context) => {
      const [action = "status", ...argumentsList] = rawArguments.trim().split(/\s+/);
      if (action === "help") {
        notifyWhenUiAvailable(context, helpText, "info");
        return;
      }
      const knowledge = runtime.getKnowledge<KnowledgeService>();
      if (knowledge === undefined) {
        notifyWhenUiAvailable(context, "Pi Mentis knowledge provider is unavailable", "error");
        return;
      }
      if (action === "add" || action === "sync" || action === "rebuild") {
        const depthFlag = /--depth=(\d+)/.exec(rawArguments);
        const maxDepth =
          depthFlag !== null ? Math.min(Math.max(Number(depthFlag[1]), 1), 10) : undefined;
        const target = argumentsList.filter((a) => !a.startsWith("--depth=")).join(" ");
        if (target === "") {
          notifyWhenUiAvailable(context, `Usage: /kb ${action} <path-or-url> [--depth=N]`, "error");
          return;
        }
        const source = await knowledgeCommandSource(target, maxDepth);
        const receipt = await knowledge.enqueueIngest(
          {
            source,
            scopeContext: localKnowledgeScope(),
          },
          {
            priority: "user",
            onProgress: (event) => {
              tuiContext?.ui.setStatus("mentis-kb", event.message ?? "Indexing…");
            },
            onDone: (result) => {
              tuiContext?.ui.setStatus("mentis-kb", undefined);
              if (result instanceof Error) {
                notifyWhenUiAvailable(
                  context,
                  `Knowledge job ${receipt.jobId} failed: ${result.message}`,
                  "error",
                );
              } else {
                if (result.diagnostics.length > 0) {
                  console.debug("[mentis] Knowledge job diagnostics:", result.diagnostics);
                }
                const parts: string[] = [];
                if (result.chunkCount > 0)
                  parts.push(`${result.chunkCount} chunks from ${result.documentIds.length} docs`);
                if (result.unchanged > 0) parts.push(`${result.unchanged} unchanged`);
                notifyWhenUiAvailable(
                  context,
                  `Knowledge job ${receipt.jobId} completed: ${parts.join(", ")}`,
                  "info",
                );
              }
            },
          },
        );
        notifyWhenUiAvailable(context, `Knowledge job ${receipt.jobId} queued`, "info");
        return;
      }
      if (action === "remove") {
        const sourceId = argumentsList[0];
        if (sourceId === undefined) {
          notifyWhenUiAvailable(context, "Usage: /kb remove <source-id>", "error");
          return;
        }
        const result = await knowledge.remove({ sourceId, scopeContext: localKnowledgeScope() });
        notifyWhenUiAvailable(context, `Removed ${result.removedChunks} chunks`, "info");
        return;
      }
      if (action === "inspect") {
        const documentId = argumentsList[0];
        if (documentId === undefined) {
          notifyWhenUiAvailable(context, "Usage: /kb inspect <document-id>", "error");
          return;
        }
        const result = await knowledge.inspect({
          documentId,
          scopeContext: localKnowledgeScope(),
        });
        notifyWhenUiAvailable(
          context,
          result === undefined ? "Document not found" : formatPiToolJson(result),
          "info",
        );
        return;
      }
      if (action === "jobs") {
        const jobId = argumentsList[0];
        if (jobId === undefined || store === undefined) {
          notifyWhenUiAvailable(context, "Usage: /kb jobs <job-id>", "error");
          return;
        }
        const job = (await store.fetchScalar("jobs_v1", [jobId])).get(jobId);
        notifyWhenUiAvailable(
          context,
          job === undefined ? "Job not found" : formatPiToolJson(job),
          "info",
        );
        return;
      }
      if (action === "cancel") {
        const jobId = argumentsList[0];
        const cancelled = jobId !== undefined && scheduler.cancel(jobId);
        notifyWhenUiAvailable(
          context,
          cancelled ? `Cancelled ${jobId}` : "Job not found or already finished",
          cancelled ? "info" : "warning",
        );
        return;
      }
      if (action === "models") {
        notifyWhenUiAvailable(
          context,
          formatPiToolJson({
            embedding: embeddingRuntimeDiagnostics(config, store),
            rerank: config.inference.siliconflow.rerank,
          }),
          "info",
        );
        return;
      }
      if (action === "migration-status") {
        notifyWhenUiAvailable(
          context,
          store === undefined ? "Storage unavailable" : formatPiToolJson(store.manifest),
          store === undefined ? "error" : "info",
        );
        return;
      }
      if (action === "status") {
        notifyWhenUiAvailable(
          context,
          formatPiToolJson({
            storage: getStorageStatus(context.cwd, currentConfig.storage.rootDir),
            embeddingRuntime: embeddingRuntimeDiagnostics(currentConfig, store),
            storageCoordination: await store?.coordinationStatus(),
            runtime: runtime.snapshot(),
          }),
          "info",
        );
        return;
      }
      if (action === "migrate-embedding") {
        const dimensions = Number(argumentsList[0]);
        const embedding = runtime.getEmbedding<EmbeddingProvider>();
        if (
          store === undefined ||
          embedding === undefined ||
          !Number.isInteger(dimensions) ||
          dimensions < 768 ||
          dimensions > 4096
        ) {
          notifyWhenUiAvailable(context, "Usage: /kb migrate-embedding <768..4096>", "error");
          return;
        }
        const target = { ...embeddingSpace(config), dimensions };
        const receipt = await enqueueKnowledgeEmbeddingMigration(
          store as ZvecStore,
          scheduler,
          embedding,
          target,
        );
        notifyWhenUiAvailable(context, `Embedding migration job ${receipt.jobId} queued`, "info");
        return;
      }
      if (action === "rollback-embedding") {
        const generationId = argumentsList[0];
        if (store === undefined || generationId === undefined) {
          notifyWhenUiAvailable(context, "Usage: /kb rollback-embedding <generation-id>", "error");
          return;
        }
        await store.rollbackGeneration("knowledge", generationId);
        notifyWhenUiAvailable(
          context,
          `Rolled back knowledge generation to ${generationId}`,
          "warning",
        );
        return;
      }
      notifyWhenUiAvailable(context, formatPiToolJson(runtime.snapshot()), "info");
    },
  });
}

let tuiContext: ExtensionContext | undefined;

export default async function piMentisKnowledgeExtension(pi: ExtensionAPI): Promise<void> {
  let initError: Error | undefined;
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
        `Pi Mentis knowledge extension failed to initialize: ${initMessage}`,
        "error",
      );
    });
    return;
  }
  scheduler = new BackgroundScheduler(config.performance.queue);
  const runtime = getOrCreateRuntime();
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
  runtime.registerKnowledge({
    id: "standalone-knowledge",
    version: "1.0.0",
    priority: ProviderPriority.standalone,
    initialize: async () => {
      const embedding = runtime.getEmbedding<EmbeddingProvider>();
      if (embedding === undefined) throw new Error("Embedding provider is unavailable");
      storeHandle = await acquireSharedZvecStore(config.storage, spaces(config));
      store = storeHandle.store;
      return createKnowledgeService({
        store,
        embedding,
        embeddingSpace: embeddingSpace(config),
        dimensions: config.inference.siliconflow.embedding.dimensions,
        limits: config.performance.resources,
        scheduler,
        telemetry: new InMemoryTelemetry(),
        defaultNamespace: config.knowledge.defaultNamespace,
        queryCacheEntries: config.inference.embedding.queryCacheEntries,
        queryCacheTtlMs: config.inference.embedding.queryCacheTtlMs,
      });
    },
    dispose: async () => {
      await scheduler.close();
      await storeHandle?.release();
      storeHandle = undefined;
      store = undefined;
    },
  });
  runtime.registerRetrieval({
    id: "standalone-knowledge-retrieval",
    version: "1.0.0",
    priority: ProviderPriority.standalone,
    initialize: async () => {
      const knowledge = runtime.getKnowledge<KnowledgeService>();
      const reranker = runtime.getReranker<RerankProvider>();
      const embedding = runtime.getEmbedding<EmbeddingProvider>();
      return createRetrievalService({
        ...(knowledge === undefined ? {} : { knowledge }),
        ...(reranker === undefined ? {} : { reranker }),
        ...(embedding === undefined ? {} : { embedding }),
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
      });
    },
  });
  let registered = false;
  pi.on("session_start", async (_event, context) => {
    tuiContext = context;
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
        `Pi Mentis knowledge runtime initialization failed: ${runtimeReadyError.message}. Tools are registered but will return errors until the issue is resolved.`,
        "error",
      );
    }
    const knowledge = runtime.getKnowledge<KnowledgeService>();

    // Always register tools when running standalone (no memory extension co-installed).
    // When the memory extension is present, the integrated tools handle both knowledge and memory.
    if (!registered && runtime.getMemory() === undefined && knowledge !== undefined) {
      registerKnowledgeTools(
        pi,
        knowledge,
        runtime.getRetrieval<RetrievalService>(),
        config.retrieval.manualSearchTimeoutMs,
        () => ({
          tenantId: "local",
          userId: "local",
          appId: "pi",
          agentId: "pi-mentis-knowledge",
        }),
      );
      registerKnowledgeCommand(pi, runtime, config);
      registered = true;
    }

    if (knowledge === undefined) {
      if (runtimeReadyError === undefined) {
        notifyWhenUiAvailable(
          context,
          "Pi Mentis knowledge service unavailable. Tools are registered but will return errors until the issue is resolved.",
          "warning",
        );
      }
      return;
    }
    await knowledge.recoverJobs(context.signal === undefined ? {} : { signal: context.signal });
    await store?.collectSupersededGenerations(config.storage.generationRetentionMs);
  });
  pi.on("session_shutdown", async (event) => {
    if (event.reason === "quit") {
      await runtime.dispose();
    } else {
      await runtime.dispose();
      resetSharedStores();
      await resetGlobalRuntime();
    }
  });
}
