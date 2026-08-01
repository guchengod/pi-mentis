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
  authPath: path.join(request.piConfigDir, "auth.json"),
  modelsPath: null,
  modelsStorePath: path.join(request.piConfigDir, "models-store.json"),
  allowModelNetwork: false,
});
const modelRegistry = new ModelRegistry(modelRuntime);
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
    getModel: () => undefined,
    getScopedModels: () => [],
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
let shutdownEmitted = false;

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
        if (job.state === "completed") return job;
        if (job.state === "failed") throw new Error(`Knowledge job failed: ${job.error}`);
      } catch (error) {
        if (error instanceof SyntaxError) {
          // The queue may not have written the job record yet.
        } else {
          throw error;
        }
      }
    }
    await delay(25);
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
      const definition = runner.getToolDefinition(operation.name);
      if (definition === undefined) throw new Error(`Pi tool ${operation.name} is not registered`);
      const toolCallId = `${request.runId}-tool-${index}`;
      await runner.emit({
        type: "tool_execution_start",
        toolCallId,
        toolName: operation.name,
        args: operation.parameters,
      });
      try {
        const result = await definition.execute(
          toolCallId,
          operation.parameters,
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
        results.push({
          kind: "tool",
          name: operation.name,
          result,
          ...(job === undefined ? {} : { job }),
        });
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
        notifications,
        errors,
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
        processId: process.pid,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
}
