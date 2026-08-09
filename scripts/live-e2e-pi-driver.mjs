import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ExtensionRunner } from "@earendil-works/pi-coding-agent";

const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const codingAgentDist = path.dirname(codingAgentEntry);
const codingAgentManifest = JSON.parse(
  await readFile(path.resolve(codingAgentDist, "..", "package.json"), "utf8"),
);
const { loadExtensions } = await import(
  pathToFileURL(path.join(codingAgentDist, "core/extensions/loader.js")).href
);
const { SessionManager } = await import(
  pathToFileURL(path.join(codingAgentDist, "core/session-manager.js")).href
);
const { ModelRuntime } = await import(
  pathToFileURL(path.join(codingAgentDist, "core/model-runtime.js")).href
);
const { ModelRegistry } = await import(
  pathToFileURL(path.join(codingAgentDist, "core/model-registry.js")).href
);

const [requestFilename, responseFilename] = process.argv.slice(2);
if (requestFilename === undefined || responseFilename === undefined) {
  throw new Error("Usage: live-e2e-pi-driver.mjs <request.json> <response.json>");
}

const request = JSON.parse(await readFile(requestFilename, "utf8"));
process.chdir(request.workspace);

const extensionRoot = path.join(
  request.packagesDir,
  "node_modules",
  ...request.packageName.split("/"),
);
const extensionManifest = JSON.parse(
  await readFile(path.join(extensionRoot, "package.json"), "utf8"),
);
const extensionRelative = extensionManifest.pi?.extensions?.[0];
if (typeof extensionRelative !== "string") {
  throw new Error(`${request.packageName} has no pi.extensions entry`);
}
const extensionPath = path.resolve(extensionRoot, extensionRelative);
const loaded = await loadExtensions([extensionPath], request.workspace);
if (loaded.errors.length > 0 || loaded.extensions.length !== 1) {
  throw new Error(`Pi extension load failed: ${JSON.stringify(loaded.errors)}`);
}

const sessionManager = SessionManager.create(
  request.workspace,
  path.join(request.piConfigDir, "sessions"),
  { id: request.sessionId },
);
const modelRuntime = await ModelRuntime.create({
  authPath: request.model?.authPath ?? path.join(request.piConfigDir, "auth.json"),
  modelsPath: request.model?.modelsPath ?? null,
  modelsStorePath:
    request.model?.modelsStorePath ?? path.join(request.piConfigDir, "models-store.json"),
  allowModelNetwork: false,
});
const modelRegistry = new ModelRegistry(modelRuntime);
const activeModel =
  request.model === undefined
    ? undefined
    : (await modelRuntime.getAvailable()).find(
        (model) => model.provider === request.model.provider && model.id === request.model.id,
      );
if (request.model !== undefined && activeModel === undefined) {
  throw new Error(
    `Requested Pi model ${request.model.provider}/${request.model.id} is not available`,
  );
}
const modelRequests = [];
let lastModelRequestFinishedAt;
const completeWithEvidence = modelRegistry.complete.bind(modelRegistry);

function judgmentEvidence(response) {
  const text = response.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    const parsed = JSON.parse(candidate);
    if (parsed === null || typeof parsed !== "object" || typeof parsed.relation !== "string") {
      return undefined;
    }
    return {
      relation: parsed.relation,
      confidence: parsed.confidence,
      signals: parsed.signals,
      reasonCodes: parsed.reasonCodes,
    };
  } catch {
    return undefined;
  }
}

modelRegistry.complete = async (...args) => {
  const startedAt = Date.now();
  try {
    const response = await completeWithEvidence(...args);
    lastModelRequestFinishedAt = Date.now();
    modelRequests.push({
      provider: args[0].provider,
      model: args[0].id,
      status: "fulfilled",
      stopReason: response.stopReason,
      durationMs: Date.now() - startedAt,
      ...(judgmentEvidence(response) === undefined ? {} : { judgment: judgmentEvidence(response) }),
    });
    return response;
  } catch (error) {
    lastModelRequestFinishedAt = Date.now();
    modelRequests.push({
      provider: args[0].provider,
      model: args[0].id,
      status: "rejected",
      error: error instanceof Error ? error.name : "Error",
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
};
const runner = new ExtensionRunner(
  loaded.extensions,
  loaded.runtime,
  request.workspace,
  sessionManager,
  modelRegistry,
);
const notifications = [];
const errors = [];
runner.onError((error) => errors.push(error));
runner.setUIContext(
  {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: (message, type = "info") => notifications.push({ message, type }),
    onTerminalInput: () => () => undefined,
    setStatus: () => undefined,
    setWorkingMessage: () => undefined,
    setWorkingVisible: () => undefined,
    setWorkingIndicator: () => undefined,
    setHiddenThinkingLabel: () => undefined,
    setWidget: () => undefined,
    setFooter: () => undefined,
    setHeader: () => undefined,
    setTitle: () => undefined,
    custom: async () => undefined,
    pasteToEditor: () => undefined,
    setEditorText: () => undefined,
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => undefined,
    setEditorComponent: () => undefined,
    getEditorComponent: () => undefined,
    theme: {},
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => undefined,
  },
  "rpc",
);
runner.bindCore(
  {
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
    appendEntry: (customType, data) => sessionManager.appendCustomEntry(customType, data),
    setSessionName: (name) => sessionManager.appendSessionInfo(name),
    getSessionName: () => sessionManager.getSessionName(),
    setLabel: (entryId, label) => sessionManager.appendLabelChange(entryId, label),
    getActiveTools: () => runner.getAllRegisteredTools().map((tool) => tool.definition.name),
    getAllTools: () =>
      runner.getAllRegisteredTools().map((tool) => ({
        name: tool.definition.name,
        description: tool.definition.description,
        parameters: tool.definition.parameters,
        promptGuidelines: tool.definition.promptGuidelines,
        sourceInfo: tool.sourceInfo,
      })),
    setActiveTools: () => undefined,
    refreshTools: () => undefined,
    getCommands: () => [],
    setModel: async () => false,
    getThinkingLevel: () => "off",
    setThinkingLevel: () => undefined,
  },
  {
    getModel: () => activeModel,
    getScopedModels: () => (activeModel === undefined ? [] : [activeModel]),
    isIdle: () => true,
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => ({
      tokens: 0,
      contextWindow: 32_768,
      percent: 0,
    }),
    compact: () => undefined,
    getSystemPrompt: () => "",
    getSystemPromptOptions: () => ({ cwd: request.workspace }),
  },
);

const results = [];
const aliases = new Map();
let shutdownEmitted = false;

function toolPayload(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error("Pi tool returned no text payload");
  return JSON.parse(text);
}

function referencedValue(reference) {
  let value = aliases.get(reference.$result);
  if (value === undefined) throw new Error(`Unknown Pi driver result alias: ${reference.$result}`);
  for (const segment of reference.$path ?? []) {
    if (value === null || typeof value !== "object" || !(segment in value)) {
      throw new Error(
        `Missing Pi driver result path ${reference.$result}.${(reference.$path ?? []).join(".")}`,
      );
    }
    value = value[segment];
  }
  return value;
}

function resolveReferences(value) {
  if (Array.isArray(value)) return value.map(resolveReferences);
  if (value === null || typeof value !== "object") return value;
  if (typeof value.$result === "string") return referencedValue(value);
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, resolveReferences(child)]),
  );
}

async function invokeCommand(name, args) {
  const command = runner.getCommand(name);
  if (command === undefined) throw new Error(`Pi command ${name} is not registered`);
  const before = notifications.length;
  await command.handler(args, runner.createCommandContext());
  return notifications.slice(before);
}

async function waitForKnowledgeJob(jobId) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const emitted = await invokeCommand("kb", `jobs ${jobId}`);
    const message = emitted.at(-1)?.message;
    if (typeof message === "string") {
      try {
        const job = JSON.parse(message);
        if (job.state === "succeeded") return job;
        if (job.state === "failed" || job.state === "dead") {
          throw new Error(`Knowledge job failed: ${job.error ?? job.failure ?? job.state}`);
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
          // The queue may not have written the job record yet.
        } else {
          throw error;
        }
      }
    }
    await delay(100);
  }
  throw new Error(`Knowledge job ${jobId} did not complete within 120 seconds`);
}

function queuedJobId(notifications) {
  for (const notification of notifications.toReversed()) {
    const match =
      typeof notification.message === "string"
        ? /(?:Knowledge|Embedding migration) job ([A-Za-z0-9:_-]+) queued/.exec(
            notification.message,
          )
        : null;
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

try {
  await runner.emit({ type: "session_start", reason: "startup" });
  await runner.emit({
    type: "session_tree",
    oldLeafId: null,
    newLeafId: request.branchId,
  });
  const toolSurface = runner
    .getAllRegisteredTools()
    .map((tool) => tool.definition.name)
    .sort();
  const commandSurface = runner
    .getRegisteredCommands()
    .map((command) => command.name)
    .sort();
  for (const [index, operation] of request.operations.entries()) {
    if (operation.kind === "tool") {
      const parameters = resolveReferences(operation.parameters);
      // Direct commit_memory calls in this harness represent an explicit user instruction.
      // Emit the real Pi before_agent_start lifecycle first so provenance, authority, and
      // evidence validation exercise the same path as an interactive Pi turn.
      if (operation.name === "commit_memory" && typeof parameters?.content === "string") {
        await runner.emitBeforeAgentStart(parameters.content, undefined, "", {
          cwd: request.workspace,
        });
      }
      const definition = runner.getToolDefinition(operation.name);
      if (definition === undefined) throw new Error(`Pi tool ${operation.name} is not registered`);
      const toolCallId = `${request.runId}-tool-${index}`;
      await runner.emit({
        type: "tool_execution_start",
        toolCallId,
        toolName: operation.name,
        args: parameters,
      });
      try {
        const result = await definition.execute(
          toolCallId,
          parameters,
          undefined,
          undefined,
          runner.createContext(),
        );
        await runner.emit({
          type: "tool_execution_end",
          toolCallId,
          toolName: operation.name,
          result,
          isError: false,
        });
        let job;
        if (operation.waitForKnowledgeJob === true) {
          const jobId = result.details?.jobId;
          if (typeof jobId !== "string") throw new Error("Knowledge tool returned no job ID");
          job = await waitForKnowledgeJob(jobId);
        }
        const entry = {
          kind: "tool",
          name: operation.name,
          result,
          ...(job === undefined ? {} : { job }),
        };
        results.push(entry);
        if (typeof operation.as === "string") aliases.set(operation.as, toolPayload(result));
      } catch (error) {
        await runner.emit({
          type: "tool_execution_end",
          toolCallId,
          toolName: operation.name,
          result: { error: error instanceof Error ? error.message : String(error) },
          isError: true,
        });
        throw error;
      }
      continue;
    }
    if (operation.kind === "input") {
      const result = await runner.emitInput(operation.text, undefined, "interactive");
      results.push({ kind: "input", text: operation.text, result });
      continue;
    }
    if (operation.kind === "poll_memory_status") {
      const records = resolveReferences(operation.records);
      const definition = runner.getToolDefinition("search_memory");
      if (definition === undefined) throw new Error("Pi tool search_memory is not registered");
      const startedAt = Date.now();
      const timeoutMs = operation.timeoutMs ?? 30_000;
      const intervalMs = operation.intervalMs ?? 50;
      const samples = [];
      let converged = false;
      while (Date.now() - startedAt <= timeoutMs) {
        const statuses = {};
        for (const record of records) {
          const result = await definition.execute(
            `${request.runId}-poll-${index}-${samples.length}-${record.id}`,
            { id: record.id },
            undefined,
            undefined,
            runner.createContext(),
          );
          const payload = toolPayload(result);
          statuses[record.id] =
            payload.search?.hits?.[0]?.status ?? payload.hits?.[0]?.status ?? null;
        }
        const elapsedMs = Date.now() - startedAt;
        samples.push({ elapsedMs, statuses });
        converged = records.every((record) => statuses[record.id] === record.status);
        if (converged) break;
        if (
          lastModelRequestFinishedAt !== undefined &&
          Date.now() - lastModelRequestFinishedAt >= 1_500
        ) {
          break;
        }
        await delay(intervalMs);
      }
      const entry = {
        kind: "poll_memory_status",
        converged,
        convergenceMs: samples.at(-1)?.elapsedMs ?? 0,
        ...(converged ? {} : { lastObserved: samples.at(-1) }),
        samples,
      };
      results.push(entry);
      if (typeof operation.as === "string") aliases.set(operation.as, entry);
      continue;
    }
    if (operation.kind === "command") {
      const emitted = await invokeCommand(operation.name, operation.arguments ?? "");
      let job;
      if (operation.waitForKnowledgeJob === true) {
        const jobId = queuedJobId(emitted);
        if (jobId === undefined) throw new Error("Knowledge command returned no job ID");
        job = await waitForKnowledgeJob(jobId);
      }
      results.push({
        kind: "command",
        name: operation.name,
        notifications: emitted,
        ...(job === undefined ? {} : { job }),
      });
      continue;
    }
    if (operation.kind === "before_agent_start") {
      results.push({
        kind: "before_agent_start",
        prompt: operation.prompt,
        result: await runner.emitBeforeAgentStart(operation.prompt, undefined, "", {
          cwd: request.workspace,
        }),
      });
      continue;
    }
    throw new Error(`Unknown Pi driver operation: ${operation.kind}`);
  }
  await runner.emit({ type: "session_shutdown", reason: "quit" });
  shutdownEmitted = true;
  await writeFile(
    responseFilename,
    `${JSON.stringify(
      {
        ok: true,
        piVersion: codingAgentManifest.version,
        extensionPath,
        toolSurface,
        toolDefinitions: runner.getAllRegisteredTools().map((tool) => ({
          name: tool.definition.name,
          parameters: tool.definition.parameters,
        })),
        commandSurface,
        results,
        aliases: Object.fromEntries(aliases),
        notifications,
        errors,
        activeModel:
          activeModel === undefined
            ? null
            : { provider: activeModel.provider, id: activeModel.id, name: activeModel.name },
        modelRequests,
        processId: process.pid,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  if (!shutdownEmitted) {
    try {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
    } catch {
      // Preserve the original failure.
    }
  }
  await writeFile(
    responseFilename,
    `${JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : "Error",
        code:
          typeof error === "object" && error !== null && "code" in error ? error.code : undefined,
        toolSurface: runner
          .getAllRegisteredTools()
          .map((tool) => tool.definition.name)
          .sort(),
        notifications,
        errors,
        activeModel:
          activeModel === undefined
            ? null
            : { provider: activeModel.provider, id: activeModel.id, name: activeModel.name },
        modelRequests,
        processId: process.pid,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
}
