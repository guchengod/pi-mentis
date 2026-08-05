import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetGlobalRuntime, resetSharedStores } from "@pi-mentis/pi-mentis-core";

const LIVE_GATE = process.env["PI_MENTIS_LIVE_INTEGRATION"] === "1";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for Pi lifecycle live integration tests`);
  }
  return value;
}

interface PiLoader {
  loadExtensions(
    paths: string[],
    cwd: string,
  ): Promise<{
    readonly extensions: readonly { readonly path: string }[];
    readonly errors: readonly { readonly path: string; readonly error: string }[];
    readonly runtime: unknown;
  }>;
}

interface ExtensionCtor {
  new (
    extensions: readonly { readonly path: string }[],
    _runtime: unknown,
    workspace: string,
    sessionManager: unknown,
    modelRegistry: unknown,
  ): ExtensionRunner;
}

interface CommandDef {
  readonly name: string;
}

interface ToolDef {
  readonly name: string;
  readonly definition: { readonly name: string; readonly description: string };
  execute(
    toolCallId: string,
    args: Record<string, unknown>,
    _signal: AbortSignal | undefined,
    _result: unknown,
    _context: unknown,
  ): Promise<unknown>;
  readonly sourceInfo: { readonly extensionPath: string };
}

interface ExtensionRunner {
  emit(event: { readonly type: string; [key: string]: unknown }): Promise<void>;
  emitBeforeAgentStart(
    prompt: string,
    _systemPromptOptions: unknown,
    _systemPrompt: string,
    _enhancedContext: unknown,
  ): Promise<Record<string, unknown> | undefined>;
  getAllRegisteredTools(): readonly {
    readonly definition: ToolDef;
    readonly sourceInfo: { readonly extensionPath: string };
  }[];
  getToolDefinition(name: string): ToolDef | undefined;
  getRegisteredCommands(): readonly CommandDef[];
  getCommand(name: string): { handler(args: string, _ctx: unknown): Promise<void> } | undefined;
  createCommandContext(): unknown;
  createContext(): unknown;
  onError(_handler: (error: Error) => void): void;
  setUIContext(_ui: Record<string, unknown>, _transport: string): void;
  bindCore(
    _appCore: Record<string, unknown>,
    _sessionCore: Record<string, unknown>,
  ): void;
}

function stubUiContext(): Record<string, unknown> {
  return {
    select: async () => undefined,
    confirm: async () => false,
    notify: () => undefined,
    onTerminalInput: () => () => undefined,
    setStatus: () => undefined,
    setWorkingMessage: () => undefined,
    setWorkingVisible: () => undefined,
    setTitle: () => undefined,
    custom: async () => undefined,
  };
}

function stubAppCore(sessionManager: {
  appendCustomEntry(_type: string, _data: unknown): void;
}): Record<string, unknown> {
  return {
    sendMessage: () => undefined,
    appendEntry: (_type: string, data: unknown) =>
      sessionManager.appendCustomEntry(_type, data),
    getActiveTools: () => [] as string[],
    setActiveTools: () => undefined,
    refreshTools: () => undefined,
  };
}

function stubSessionCore(): Record<string, unknown> {
  return {
    getModel: () => undefined,
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort: () => undefined,
    shutdown: () => undefined,
    getContextUsage: () => ({ tokens: 0, contextWindow: 32_768, percent: 0 }),
    getSystemPromptOptions: () => ({ cwd: process.cwd() }),
  };
}

async function createMiniSessionManager(workspace: string, sessionId: string) {
  const { SessionManager } = await import(
    pathToFileURL(
      path.resolve(
        "node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js",
      ),
    ).href
  );
  const sessionDir = path.join(workspace, ".pi-sessions");
  return SessionManager.create(workspace, sessionDir, { id: sessionId });
}

async function createModelRegistry() {
  const { ModelRuntime } = await import(
    pathToFileURL(
      path.resolve(
        "node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js",
      ),
    ).href
  );
  const { ModelRegistry: ModelReg } = await import(
    pathToFileURL(
      path.resolve(
        "node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.js",
      ),
    ).href
  );
  const authPath = path.join(tmpdir(), ".pi-auth-live-test.json");
  const runtime = await ModelRuntime.create({
    authPath,
    modelsPath: null,
    modelsStorePath: path.join(tmpdir(), ".pi-models-live-test.json"),
    allowModelNetwork: false,
  });
  return new ModelReg(runtime);
}

describe.skipIf(!LIVE_GATE)("Pi lifecycle with real embedding", () => {
  const tempRoots: string[] = [];
  let piHome: string;
  let originalPiHome: string | undefined;

  beforeAll(async () => {
    piHome = await mkdtemp(path.join(tmpdir(), "pi-mentis-lifecycle-"));
    tempRoots.push(piHome);
    originalPiHome = process.env["PI_MENTIS_HOME"];
    process.env["PI_MENTIS_HOME"] = piHome;
    requiredEnv("SILICONFLOW_API_KEY");
    requiredEnv("SILICONFLOW_EMBEDDING_MODEL");
    requiredEnv("SILICONFLOW_RERANKER_MODEL");
  });

  afterAll(async () => {
    if (originalPiHome === undefined) {
      delete process.env["PI_MENTIS_HOME"];
    } else {
      process.env["PI_MENTIS_HOME"] = originalPiHome;
    }
    await Promise.all(tempRoots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  });

  beforeEach(async () => {
    const testWorkspace = await mkdtemp(path.join(piHome, "ws-"));
    tempRoots.push(testWorkspace);
  });

  afterEach(() => {
    resetGlobalRuntime();
    resetSharedStores();
  });

  async function loadExtension(workspace: string): Promise<{
    runner: ExtensionRunner;
    workspace: string;
  }> {
    const loaderPath = path.resolve(
      "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js",
    );
    const { loadExtensions } = (await import(pathToFileURL(loaderPath).href)) as PiLoader;
    const extensionPath = path.resolve("packages/pi-context-extension/dist/index.js");
    const loaded = await loadExtensions([extensionPath], workspace);
    if (loaded.errors.length > 0 || loaded.extensions.length !== 1) {
      throw new Error(`Extension load failed: ${JSON.stringify(loaded.errors)}`);
    }
    const { ExtensionRunner } = (await import(
      pathToFileURL(
        path.resolve(
          "node_modules/@earendil-works/pi-coding-agent/dist/runtime/extension-runner.js",
        ),
      ).href
    )) as { ExtensionRunner: ExtensionCtor };
    const sessionManager = await createMiniSessionManager(workspace, `session-${Date.now()}`);
    const modelRegistry = await createModelRegistry();
    const runner = new ExtensionRunner(
      loaded.extensions,
      loaded.runtime,
      workspace,
      sessionManager,
      modelRegistry,
    ) as ExtensionRunner;
    runner.setUIContext(stubUiContext(), "rpc");
    runner.bindCore(stubAppCore(sessionManager), stubSessionCore());
    return { runner, workspace };
  }

  describe("extension loading and tool registration", () => {
    it(
      "loads the integrated extension and registers commit_memory + search_memory",
      { timeout: 30_000 },
      async () => {
        const ws = await mkdtemp(path.join(piHome, "reg-"));
        tempRoots.push(ws);
        const { runner } = await loadExtension(ws);
        await runner.emit({ type: "session_start", reason: "startup" });
        await runner.emit({ type: "session_tree", oldLeafId: null, newLeafId: "test-branch" });

        const toolNames = runner
          .getAllRegisteredTools()
          .map((t) => t.definition.name)
          .sort();
        expect(toolNames).toContain("commit_memory");
        expect(toolNames).toContain("search_memory");

        const commands = runner.getRegisteredCommands().map((c) => c.name).sort();
        expect(commands).toContain("kb");

        await runner.emit({ type: "session_shutdown", reason: "quit" });
      },
    );

    it(
      "registers kb command",
      { timeout: 30_000 },
      async () => {
        const ws = await mkdtemp(path.join(piHome, "kb-cmd-"));
        tempRoots.push(ws);
        const { runner } = await loadExtension(ws);
        await runner.emit({ type: "session_start", reason: "startup" });

        const kbCommand = runner.getCommand("kb");
        expect(kbCommand).toBeDefined();

        await runner.emit({ type: "session_shutdown", reason: "quit" });
      },
    );
  });

  describe("commit_memory with real embedding", () => {
    it(
      "commits a memory and retrieves it via search_memory",
      { timeout: 60_000 },
      async () => {
        const workspace = await mkdtemp(path.join(piHome, "mem-"));
        tempRoots.push(workspace);
        const { runner } = await loadExtension(workspace);

        await runner.emit({ type: "session_start", reason: "startup" });
        await runner.emit({ type: "session_tree", oldLeafId: null, newLeafId: "test-branch" });

        await runner.emitBeforeAgentStart(
          "Please remember that the project uses TypeScript strict mode",
          undefined,
          "",
          { cwd: workspace },
        );

        const commitTool = runner.getToolDefinition("commit_memory");
        expect(commitTool).toBeDefined();

        const commitResult = await commitTool!.execute(
          "tool-call-commit-1",
          {
            content:
              "This project uses TypeScript strict mode with noUncheckedIndexedAccess and exactOptionalPropertyTypes enabled. The module system is ESM NodeNext.",
          },
          undefined,
          undefined,
          runner.createContext(),
        );
        expect(commitResult).toBeDefined();
        expect(commitResult).not.toHaveProperty("error");

        await runner.emit({
          type: "tool_execution_end",
          toolCallId: "tool-call-commit-1",
          toolName: "commit_memory",
          result: commitResult,
          isError: false,
        });

        const searchTool = runner.getToolDefinition("search_memory");
        expect(searchTool).toBeDefined();

        const searchResult = await searchTool!.execute(
          "tool-call-search-1",
          { query: "TypeScript strict mode configuration" },
          undefined,
          undefined,
          runner.createContext(),
        );

        expect(searchResult).toBeDefined();
        expect(searchResult).toHaveProperty("items");
        const items = (searchResult as { items?: unknown[] }).items;
        expect(Array.isArray(items)).toBe(true);
        expect(items!.length).toBeGreaterThan(0);

        await runner.emit({ type: "agent_settled" });
        await runner.emit({ type: "session_shutdown", reason: "quit" });
      },
    );

    it(
      "commits two distinct memories and retrieves each via targeted search",
      { timeout: 90_000 },
      async () => {
        const workspace = await mkdtemp(path.join(piHome, "recall-"));
        tempRoots.push(workspace);
        const { runner } = await loadExtension(workspace);

        await runner.emit({ type: "session_start", reason: "startup" });
        await runner.emit({ type: "session_tree", oldLeafId: null, newLeafId: "recall-branch" });

        await runner.emitBeforeAgentStart(
          "Remember project configuration details",
          undefined,
          "",
          { cwd: workspace },
        );

        const commitTool = runner.getToolDefinition("commit_memory");
        expect(commitTool).toBeDefined();

        const result1 = await commitTool!.execute(
          "tool-call-1",
          {
            content:
              "The API server runs on port 8080 with Bearer token authentication header X-API-Key required for all endpoints.",
          },
          undefined,
          undefined,
          runner.createContext(),
        );
        expect(result1).not.toHaveProperty("error");

        const result2 = await commitTool!.execute(
          "tool-call-2",
          {
            content:
              "Database connection string is stored in environment variable DATABASE_URL, never hardcoded in source files.",
          },
          undefined,
          undefined,
          runner.createContext(),
        );
        expect(result2).not.toHaveProperty("error");

        const searchTool = runner.getToolDefinition("search_memory");
        expect(searchTool).toBeDefined();

        const searchApiResult = await searchTool!.execute(
          "tool-call-search-api",
          { query: "API server configuration and authentication" },
          undefined,
          undefined,
          runner.createContext(),
        );
        const apiItems = (searchApiResult as { items?: Array<{ content?: string }> }).items;
        const apiContent = apiItems?.map((i) => i.content ?? "").join(" ").toLowerCase() ?? "";
        expect(apiContent).toMatch(/8080|api|bearer|token|authentication/);

        const searchDbResult = await searchTool!.execute(
          "tool-call-search-db",
          { query: "database connection string environment variable" },
          undefined,
          undefined,
          runner.createContext(),
        );
        const dbItems = (searchDbResult as { items?: Array<{ content?: string }> }).items;
        const dbContent = dbItems?.map((i) => i.content ?? "").join(" ").toLowerCase() ?? "";
        expect(dbContent).toMatch(/database|connection|databas_url|environment/);

        await runner.emit({ type: "agent_settled" });
        await runner.emit({ type: "session_shutdown", reason: "quit" });
      },
    );
  });

  describe("durability across restarts", () => {
    it(
      "data persists after complete shutdown and re-initialization",
      { timeout: 90_000 },
      async () => {
        const workspace = await mkdtemp(path.join(piHome, "durable-"));
        tempRoots.push(workspace);
        const memoryContent = `Durability test fact written at ${Date.now()}: Pi Mentis stores data at the project level with Zvec as the embedded vector database.`;

        // Session 1: commit a memory
        {
          const { runner } = await loadExtension(workspace);
          await runner.emit({ type: "session_start", reason: "startup" });
          await runner.emit({ type: "session_tree", oldLeafId: null, newLeafId: "session-1" });

          await runner.emitBeforeAgentStart("Remember durability test fact", undefined, "", {
            cwd: workspace,
          });

          const commitTool = runner.getToolDefinition("commit_memory");
          const result = await commitTool!.execute(
            "tool-call-durable",
            { content: memoryContent },
            undefined,
            undefined,
            runner.createContext(),
          );
          expect(result).not.toHaveProperty("error");

          await runner.emit({ type: "agent_settled" });
          await runner.emit({ type: "session_shutdown", reason: "quit" });
        }

        resetGlobalRuntime();
        resetSharedStores();

        // Session 2: verify persisted data is searchable
        {
          const { runner } = await loadExtension(workspace);
          await runner.emit({ type: "session_start", reason: "startup" });
          await runner.emit({ type: "session_tree", oldLeafId: null, newLeafId: "session-2" });

          await runner.emitBeforeAgentStart("Search for persisted data", undefined, "", {
            cwd: workspace,
          });

          const searchTool = runner.getToolDefinition("search_memory");
          const result = await searchTool!.execute(
            "tool-call-search-persist",
            { query: "durability test Pi Mentis storage" },
            undefined,
            undefined,
            runner.createContext(),
          );
          const items = (result as { items?: Array<{ content?: string }> }).items;
          expect(Array.isArray(items)).toBe(true);
          expect(items!.length).toBeGreaterThan(0);
          const found = items!.some((item) =>
            (item.content ?? "").includes("Durability test fact"),
          );
          expect(found).toBe(true);

          await runner.emit({ type: "agent_settled" });
          await runner.emit({ type: "session_shutdown", reason: "quit" });
        }
      },
    );
  });

  describe("error handling", () => {
    it(
      "search_memory handles unmatched queries gracefully",
      { timeout: 60_000 },
      async () => {
        const workspace = await mkdtemp(path.join(piHome, "empty-"));
        tempRoots.push(workspace);
        const { runner } = await loadExtension(workspace);

        await runner.emit({ type: "session_start", reason: "startup" });
        await runner.emit({ type: "session_tree", oldLeafId: null, newLeafId: "empty-branch" });

        await runner.emitBeforeAgentStart("Test empty search", undefined, "", {
          cwd: workspace,
        });

        const searchTool = runner.getToolDefinition("search_memory");
        const result = await searchTool!.execute(
          "tool-call-empty",
          { query: "xyzzy_nonexistent_query_that_matches_nothing_1234567890" },
          undefined,
          undefined,
          runner.createContext(),
        );
        expect(result).toBeDefined();
        const items = (result as { items?: unknown[] }).items ?? [];
        // Unmatched queries should still return a well-formed response
        expect(Array.isArray(items)).toBe(true);

        await runner.emit({ type: "agent_settled" });
        await runner.emit({ type: "session_shutdown", reason: "quit" });
      },
    );
  });
});
