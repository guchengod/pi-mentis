import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  BackgroundScheduler,
  ProviderPriority,
  assertPiCompatibility,
  detectInstalledPackageVersion,
  getOrCreateRuntime,
  loadConfig,
  operationId,
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
  migrateKnowledgeEmbedding,
  type KnowledgeService,
} from "@pi-mentis/pi-mentis-knowledge-core";
import { InMemoryTelemetry } from "@pi-mentis/pi-mentis-observability";
import { createRetrievalService, type RetrievalService } from "@pi-mentis/pi-mentis-retrieval";
import {
  SiliconFlowEmbeddingProvider,
  SiliconFlowRerankProvider,
} from "@pi-mentis/pi-mentis-siliconflow";
import {
  acquireSharedZvecStore,
  type SharedZvecStoreHandle,
  type ZvecStore,
} from "@pi-mentis/pi-mentis-zvec";

let config: PiMentisConfig;
let scheduler: BackgroundScheduler;
let storeHandle: SharedZvecStoreHandle | undefined;
let store: ZvecStore | undefined;

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

function sourceInput(kind: string, value: string) {
  if (kind === "text") return { kind: "text" as const, text: value };
  if (kind === "url") return { kind: "url" as const, url: value };
  if (kind === "directory") return { kind: "directory" as const, path: value };
  if (kind === "workspace") return { kind: "workspace" as const, path: value };
  if (kind === "git") return { kind: "git" as const, path: value };
  if (kind === "pi-package") return { kind: "pi-package" as const, path: value };
  if (kind === "skill") return { kind: "skill" as const, path: value };
  if (kind === "mcp") return { kind: "mcp" as const, path: value };
  return { kind: "file" as const, path: value };
}

function registerKnowledgeTools(
  pi: ExtensionAPI,
  service: KnowledgeService,
  retrieval: RetrievalService | undefined,
): void {
  pi.registerTool({
    name: "commit_knowledge",
    label: "Commit knowledge",
    description:
      "Queue a file, directory, URL, text, Git repository, Pi package, Skill, or MCP schema for durable knowledge indexing.",
    parameters: Type.Object({
      kind: Type.Union([
        Type.Literal("file"),
        Type.Literal("directory"),
        Type.Literal("workspace"),
        Type.Literal("git"),
        Type.Literal("url"),
        Type.Literal("text"),
        Type.Literal("pi-package"),
        Type.Literal("skill"),
        Type.Literal("mcp"),
      ]),
      value: Type.String({ minLength: 1 }),
      namespace: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(_toolCallId, parameters, signal) {
      const receipt = await service.enqueueIngest(
        {
          source: sourceInput(parameters.kind, parameters.value),
          ...(parameters.namespace === undefined ? {} : { namespace: parameters.namespace }),
        },
        { ...(signal === undefined ? {} : { signal }), priority: "user" },
      );
      return {
        content: [{ type: "text", text: JSON.stringify(receipt) }],
        details: receipt,
      };
    },
  });
  pi.registerTool({
    name: "search_knowledge",
    label: "Search knowledge",
    description:
      "Search durable user, project, and Pi capability knowledge with Dense and full-text retrieval.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      namespace: Type.Optional(Type.String({ minLength: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(_toolCallId, parameters, signal) {
      const query = {
        text: parameters.query,
        ...(parameters.namespace === undefined ? {} : { namespace: parameters.namespace }),
        ...(parameters.limit === undefined ? {} : { limit: parameters.limit }),
      };
      const result =
        retrieval === undefined
          ? await service.search(query, signal === undefined ? {} : { signal })
          : await retrieval.search(query, {
              ...(signal === undefined ? {} : { signal }),
              allowRerank: true,
            });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result.diagnostics,
      };
    },
  });
}

function registerKnowledgeCommand(pi: ExtensionAPI, runtime: PersistentIntelligenceRuntime): void {
  pi.registerCommand("kb", {
    description:
      "Manage Pi Mentis knowledge: add, sync, remove, status, jobs, cancel, inspect, models, and Embedding migrations",
    handler: async (rawArguments, context) => {
      const [action = "status", ...argumentsList] = rawArguments.trim().split(/\s+/);
      const knowledge = runtime.getKnowledge<KnowledgeService>();
      if (knowledge === undefined) {
        context.ui.notify("Pi Mentis knowledge provider is unavailable", "error");
        return;
      }
      if (action === "add" || action === "sync" || action === "rebuild") {
        const target = argumentsList.join(" ");
        if (target === "") {
          context.ui.notify(`Usage: /kb ${action} <path-or-url>`, "error");
          return;
        }
        const source = /^https?:\/\//.test(target)
          ? { kind: "url" as const, url: target }
          : { kind: "file" as const, path: target };
        const receipt = await knowledge.enqueueIngest({ source }, { priority: "user" });
        context.ui.notify(`Knowledge job ${receipt.jobId} queued`, "info");
        return;
      }
      if (action === "remove") {
        const sourceId = argumentsList[0];
        if (sourceId === undefined) {
          context.ui.notify("Usage: /kb remove <source-id>", "error");
          return;
        }
        const result = await knowledge.remove({ sourceId });
        context.ui.notify(`Removed ${result.removedChunks} chunks`, "info");
        return;
      }
      if (action === "inspect") {
        const documentId = argumentsList[0];
        if (documentId === undefined) {
          context.ui.notify("Usage: /kb inspect <document-id>", "error");
          return;
        }
        const result = await knowledge.inspect({ documentId });
        context.ui.notify(
          result === undefined ? "Document not found" : JSON.stringify(result),
          "info",
        );
        return;
      }
      if (action === "jobs") {
        const jobId = argumentsList[0];
        if (jobId === undefined || store === undefined) {
          context.ui.notify("Usage: /kb jobs <job-id>", "error");
          return;
        }
        const job = (await store.fetchScalar("jobs_v1", [jobId])).get(jobId);
        context.ui.notify(job === undefined ? "Job not found" : JSON.stringify(job), "info");
        return;
      }
      if (action === "cancel") {
        const jobId = argumentsList[0];
        const cancelled = jobId !== undefined && scheduler.cancel(jobId);
        context.ui.notify(
          cancelled ? `Cancelled ${jobId}` : "Job not found or already finished",
          cancelled ? "info" : "warning",
        );
        return;
      }
      if (action === "models") {
        context.ui.notify(
          JSON.stringify({
            embedding: config.inference.siliconflow.embedding,
            rerank: config.inference.siliconflow.rerank,
          }),
          "info",
        );
        return;
      }
      if (action === "migration-status") {
        context.ui.notify(
          store === undefined ? "Storage unavailable" : JSON.stringify(store.manifest),
          store === undefined ? "error" : "info",
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
          context.ui.notify("Usage: /kb migrate-embedding <768..4096>", "error");
          return;
        }
        const jobId = operationId("job");
        const target = { ...embeddingSpace(config), dimensions };
        const scheduled = scheduler.schedule({
          id: jobId,
          priority: 20,
          estimatedBytes: 1,
          run: (signal) =>
            migrateKnowledgeEmbedding(store as ZvecStore, embedding, target, { signal }),
        });
        void scheduled.promise.catch(() => undefined);
        context.ui.notify(`Embedding migration job ${jobId} queued`, "info");
        return;
      }
      if (action === "rollback-embedding") {
        const generationId = argumentsList[0];
        if (store === undefined || generationId === undefined) {
          context.ui.notify("Usage: /kb rollback-embedding <generation-id>", "error");
          return;
        }
        await store.rollbackGeneration("knowledge", generationId);
        context.ui.notify(`Rolled back knowledge generation to ${generationId}`, "warning");
        return;
      }
      context.ui.notify(JSON.stringify(runtime.snapshot()), "info");
    },
  });
}

export default async function piMentisKnowledgeExtension(pi: ExtensionAPI): Promise<void> {
  const installedVersion = await detectInstalledPackageVersion(
    "@earendil-works/pi-coding-agent",
    import.meta.url,
  );
  assertPiCompatibility(installedVersion);
  config = await loadConfig(process.cwd());
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
      return createRetrievalService({
        ...(knowledge === undefined ? {} : { knowledge }),
        ...(reranker === undefined ? {} : { reranker }),
        rerankModel: config.inference.siliconflow.rerank.model,
        rerankContextTokens: config.inference.siliconflow.rerank.maxInputTokens,
        rerankCandidateLimit: config.inference.rerank.candidateLimit,
        rerankCacheEntries: config.inference.rerank.cacheEntries,
        rerankCacheTtlMs: config.inference.rerank.cacheTtlMs,
      });
    },
  });
  let registered = false;
  pi.on("session_start", async (_event, context) => {
    await runtime.ready(context.signal);
    if (registered || runtime.getMemory() !== undefined) return;
    const knowledge = runtime.getKnowledge<KnowledgeService>();
    if (knowledge === undefined) return;
    registerKnowledgeTools(pi, knowledge, runtime.getRetrieval<RetrievalService>());
    registerKnowledgeCommand(pi, runtime);
    registered = true;
  });
  pi.on("session_shutdown", async (event) => {
    if (event.reason === "reload") await resetGlobalRuntime();
    else await runtime.dispose();
  });
}
