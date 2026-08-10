import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { resolveStorageRoot } from "../../packages/core/dist/index.js";

import { installIsolated } from "./build-install.mjs";
import { PiAcceptanceDriver } from "./pi-driver.mjs";
import { PiRpcAcceptanceDriver } from "./rpc-driver.mjs";
import { configureWorkspace } from "./scenario-runner.mjs";
import { inspectZvec, readCapabilityMatches } from "./state-inspector.mjs";
import { hashFile, runCommand, writeJson } from "./common.mjs";

function scenario(id, name, stage, status, started, details = {}) {
  return { id, name, stage, status, durationMs: performance.now() - started, ...details };
}

function rpcOptions({
  piHome,
  workspace,
  directories,
  runId,
  label,
  environment,
  tools,
  discoverSkills,
}) {
  return {
    piHome,
    cwd: workspace,
    provider: environment.provider.piDefault,
    model: environment.provider.piModel,
    sessionDir: path.join(directories.state, `${label}-sessions`),
    sessionId: `${runId}_${label.toUpperCase()}`,
    name: `${runId} ${label}`,
    tools,
    discoverSkills,
    evidenceFile: path.join(directories.reports, "evidence", `${label}-rpc.json`),
    logFile: path.join(directories.logs, `${label}-rpc.jsonl`),
  };
}

export async function runRemoveReloadScenario({
  piHome,
  archive,
  authSource,
  fixtures,
  directories,
  runId,
  environment,
}) {
  const started = performance.now();
  const zvecRoot = path.join(directories.state, "remove-reload-zvec");
  await configureWorkspace(fixtures.repoA, zvecRoot, runId);
  const driver = new PiAcceptanceDriver({
    piHome,
    provider: environment.provider.piDefault,
    model: environment.provider.piModel,
    sessionDir: path.join(directories.state, "remove-reload-sessions"),
    logs: directories.logs,
    state: directories.state,
    label: "remove-reload",
  });
  const commit = await driver.sendMessage({
    sessionId: `${runId}_REMOVE_RELOAD_COMMIT`,
    cwd: fixtures.repoA,
    prompt: `必须调用 commit_memory 保存“${runId} remove reload keeps pnpm”，factKey=${runId}:remove-reload，idempotencyKey=${runId}:remove-reload。`,
  });
  const environmentVariables = { ...process.env, PI_CODING_AGENT_DIR: piHome };
  const removed = await runCommand("pi", ["remove", "npm:@galvinsan/pi-mentis"], {
    env: environmentVariables,
    timeoutMs: 10 * 60_000,
    logFile: path.join(directories.logs, "isolated-remove.log"),
  });
  const absent = await runCommand("pi", ["list"], {
    env: environmentVariables,
    logFile: path.join(directories.logs, "isolated-list-after-remove.log"),
  });
  await installIsolated({ piHome, archive, authSource, logs: directories.logs });
  const search = await driver.sendMessage({
    sessionId: `${runId}_REMOVE_RELOAD_SEARCH`,
    cwd: fixtures.repoA,
    prompt: `新进程重载验收。必须调用 search_memory 查询“${runId} remove reload”，只根据工具结果回答。`,
  });
  const inspection = await inspectZvec({
    rootDir: zvecRoot,
    outputFile: path.join(directories.reports, "evidence", "remove-reload-zvec.json"),
    prefix: runId,
  });
  const commitCalls = commit.toolEvents.filter(
    (event) => event.toolName === "commit_memory" && event.type === "tool_execution_start",
  ).length;
  const searchCalls = search.toolEvents.filter(
    (event) => event.toolName === "search_memory" && event.type === "tool_execution_start",
  ).length;
  const passed =
    removed.exitCode === 0 &&
    !absent.output.includes("npm:@galvinsan/pi-mentis") &&
    commit.exitCode === 0 &&
    search.exitCode === 0 &&
    commitCalls === 1 &&
    searchCalls === 1 &&
    inspection.status === "PASS" &&
    inspection.collections.memory_active_generation.acceptanceCount === 1;
  return scenario(
    "A05",
    "Real Pi remove/reload hook cleanup and persistence",
    "Install",
    passed ? "PASS" : "FAIL",
    started,
    {
      evidence: `${commit.logFile}; ${search.logFile}; ${path.join(directories.reports, "evidence", "remove-reload-zvec.json")}`,
      ...(passed
        ? {}
        : { error: "remove/reload persistence, tool cardinality, or Zvec invariant failed" }),
    },
  );
}

export async function runSteeringScenario({ piHome, fixtures, directories, runId, environment }) {
  const started = performance.now();
  const zvecRoot = path.join(directories.state, "steering-zvec");
  await configureWorkspace(fixtures.repoA, zvecRoot, runId);
  const rpc = new PiRpcAcceptanceDriver(
    rpcOptions({
      piHome,
      workspace: fixtures.repoA,
      directories,
      runId,
      label: "steering",
      environment,
      tools: ["bash", "commit_memory", "search_memory"],
    }),
  );
  let evidence;
  let passed = false;
  let error;
  try {
    await rpc.start();
    const from = rpc.events.length;
    await rpc.command({
      type: "prompt",
      message:
        "必须立即调用 bash，command 精确为 node slow-tool.mjs。等待工具结束后再提出 npm 迁移方案。",
    });
    const toolStart = await rpc.waitForEvent(
      (event) => event.type === "tool_execution_start" && event.toolName === "bash",
      { from, timeoutMs: 2 * 60_000 },
    );
    const steeringText = `停止原方案，不要使用 npm，保持 pnpm，并改为只修复 TypeScript 错误。${runId}`;
    const steering = await rpc.command({ type: "steer", message: steeringText }, 30_000);
    await rpc.waitForEvent((event) => event.type === "agent_settled", {
      from: toolStart.index,
      timeoutMs: 4 * 60_000,
    });
    const entries = await rpc.command({ type: "get_entries" }, 30_000);
    const messages = await rpc.command({ type: "get_messages" }, 30_000);
    const serialized = JSON.stringify({ entries: entries.data, messages: messages.data });
    passed =
      steering.success === true && serialized.includes(steeringText) && serialized.includes("pnpm");
    if (!passed) error = "Steering was not persisted or the final branch did not retain pnpm";
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    evidence = await rpc.stop();
  }
  await inspectZvec({
    rootDir: zvecRoot,
    outputFile: path.join(directories.reports, "evidence", "steering-zvec.json"),
    prefix: runId,
    requireAcceptanceMemory: false,
  }).catch(() => undefined);
  return scenario(
    "E10",
    "Real Pi RPC steering during a slow real bash tool",
    "P9",
    passed ? "PASS" : "FAIL",
    started,
    {
      evidence: rpc.options.evidenceFile,
      ...(passed ? {} : { error: error ?? evidence?.stderr ?? "unknown steering failure" }),
    },
  );
}

export async function runCompactionBranchScenario({
  piHome,
  fixtures,
  directories,
  runId,
  environment,
}) {
  const started = performance.now();
  const zvecRoot = resolveStorageRoot({
    environment: { ...process.env, PI_CODING_AGENT_DIR: piHome },
  }).zvecRoot;
  await configureWorkspace(fixtures.repoA, zvecRoot, runId);
  const rpc = new PiRpcAcceptanceDriver(
    rpcOptions({
      piHome,
      workspace: fixtures.repoA,
      directories,
      runId,
      label: "compaction",
      environment,
      tools: ["bash", "commit_memory", "search_memory"],
    }),
  );
  let restartRpc;
  let artifactQueryRpc;
  let capturedArtifactId;
  let passed = false;
  let error;
  const temporaryArtifactPaths = [];
  const artifactEvidence = [];
  const settingsFile = path.join(piHome, "settings.json");
  let settingsSnapshot;
  let settingsExisted = false;
  try {
    settingsSnapshot = await readFile(settingsFile);
    settingsExisted = true;
  } catch (caught) {
    if (caught?.code !== "ENOENT") throw caught;
  }
  try {
    await rpc.start();
    await rpc.command({ type: "set_auto_compaction", enabled: false }, 30_000);
    await rpc.prompt(`记住本会话标识 ${runId}，只回复收到。`);
    const artifactTurn = await rpc.prompt(
      "请执行 large-log.mjs 并在完成后只回复 log-ok，不要修改文件或重定向输出。",
      5 * 60_000,
    );
    const artifactEnd = artifactTurn.events.find(
      (event) =>
        event.type === "tool_execution_end" &&
        event.toolName === "bash" &&
        typeof event.result?.details?.piMentis?.symbolic?.artifactId === "string",
    );
    const artifactDetails = artifactEnd?.result?.details;
    const originalArtifactDetails = artifactDetails?.original ?? artifactDetails;
    const symbolicArtifact = artifactDetails?.piMentis?.symbolic;
    const fullArtifactOutputPath = originalArtifactDetails?.fullOutputPath;
    capturedArtifactId = symbolicArtifact?.artifactId;
    const artifactCapturePassed =
      artifactTurn.response.success === true &&
      artifactEnd?.result?.isError !== true &&
      originalArtifactDetails?.truncation?.truncated === true &&
      typeof fullArtifactOutputPath === "string" &&
      typeof capturedArtifactId === "string" &&
      symbolicArtifact?.captureIntegrity?.complete === true &&
      symbolicArtifact?.captureIntegrity?.lossy === false &&
      symbolicArtifact?.originalBytes >= 10 * 1024 * 1024;
    if (typeof fullArtifactOutputPath === "string") {
      temporaryArtifactPaths.push(fullArtifactOutputPath);
      const copiedPath = path.join(directories.artifacts, path.basename(fullArtifactOutputPath));
      await cp(fullArtifactOutputPath, copiedPath, { preserveTimestamps: true });
      artifactEvidence.push({
        source: "mentis-hook",
        artifactId: capturedArtifactId,
        captureIntegrity: symbolicArtifact?.captureIntegrity,
        originalPath: fullArtifactOutputPath,
        copiedPath,
        byteLength: (await stat(fullArtifactOutputPath)).size,
        sha256: await hashFile(fullArtifactOutputPath),
      });
    }
    // Mentis correctly keeps the agent-visible context small, so use Pi's
    // direct native bash RPC only as a separate compaction fixture. Product
    // artifact capture was already asserted through the real agent tool path.
    const nativeCompactionResults = [];
    for (let index = 0; index < 4; index++) {
      const native = await rpc.command(
        { type: "bash", command: `node large-log.mjs # native compaction ${index + 1}` },
        2 * 60_000,
      );
      nativeCompactionResults.push(native);
      const fullOutputPath = native.data?.fullOutputPath;
      if (typeof fullOutputPath === "string") {
        temporaryArtifactPaths.push(fullOutputPath);
        const copiedPath = path.join(
          directories.artifacts,
          `native-${index + 1}-${path.basename(fullOutputPath)}`,
        );
        await cp(fullOutputPath, copiedPath, { preserveTimestamps: true });
        artifactEvidence.push({
          source: "native-compaction-fixture",
          originalPath: fullOutputPath,
          copiedPath,
          byteLength: (await stat(fullOutputPath)).size,
          sha256: await hashFile(fullOutputPath),
        });
      }
    }
    const compact = await rpc.command(
      { type: "compact", customInstructions: `保留 ${runId}、构建错误、文件和证据来源。` },
      5 * 60_000,
    );
    const compactEntries = await rpc.command({ type: "get_entries" }, 30_000);
    const forkMessages = await rpc.command({ type: "get_fork_messages" }, 30_000);
    const entryId = forkMessages.data?.messages?.[0]?.entryId;
    if (typeof entryId !== "string") throw new Error("Pi RPC returned no forkable user entry");
    const fork = await rpc.command({ type: "fork", entryId }, 2 * 60_000);
    await rpc.prompt(`这是 ${runId} 的真实分支，只回复 branch-ok。`);
    const branchEntries = await rpc.command({ type: "get_entries" }, 30_000);
    const state = await rpc.command({ type: "get_state" }, 30_000);
    const compactSerialized = JSON.stringify(compactEntries.data);
    const branchSerialized = JSON.stringify(branchEntries.data);
    passed =
      artifactCapturePassed &&
      nativeCompactionResults.every(
        (native) =>
          native.success === true &&
          native.data?.truncated === true &&
          typeof native.data?.fullOutputPath === "string",
      ) &&
      compact.success === true &&
      typeof compact.data?.summary === "string" &&
      compact.data.summary.length > 0 &&
      /compaction/iu.test(compactSerialized) &&
      fork.success === true &&
      fork.data?.cancelled === false &&
      branchSerialized.includes("branch-ok");
    if (!passed)
      error = "Artifact, compaction entry, summary, or branch persistence assertion failed";
    await rpc.stop();
    const restartOptions = rpcOptions({
      piHome,
      workspace: fixtures.repoA,
      directories,
      runId,
      label: "compaction-restart",
      environment,
      tools: ["bash", "commit_memory", "search_memory"],
    });
    restartOptions.sessionDir = rpc.options.sessionDir;
    if (typeof state.data?.sessionId === "string") restartOptions.sessionId = state.data.sessionId;
    restartRpc = new PiRpcAcceptanceDriver(restartOptions);
    await restartRpc.start();
    const restartedEntries = await restartRpc.command({ type: "get_entries" }, 30_000);
    const restartedSerialized = JSON.stringify(restartedEntries.data);
    passed =
      passed &&
      /compaction/iu.test(restartedSerialized) &&
      restartedSerialized.includes(runId) &&
      artifactEvidence.every((artifact) => artifact.byteLength >= 10 * 1024 * 1024);
    if (!passed) error = "Compaction, branch, or full artifact did not survive Pi restart";
    await restartRpc.stop();
    if (typeof capturedArtifactId !== "string") throw new Error("No captured artifact ID");
    artifactQueryRpc = new PiRpcAcceptanceDriver(
      rpcOptions({
        piHome,
        workspace: fixtures.repoA,
        directories,
        runId,
        label: "artifact-query",
        environment,
        tools: ["search_memory"],
      }),
    );
    await artifactQueryRpc.start();
    const artifactQuery = await artifactQueryRpc.prompt(
      `这是一个全新会话。请实际使用 Artifact ID ${capturedArtifactId} 在该 ID 内查询“BUILD_ERROR src/index.ts 文件和行号”，只根据查询结果回答。`,
    );
    const artifactQueryStart = artifactQuery.events.find(
      (event) =>
        event.type === "tool_execution_start" &&
        event.toolName === "search_memory" &&
        event.args?.id === capturedArtifactId,
    );
    const artifactQueryEnd = artifactQuery.events.find(
      (event) =>
        event.type === "tool_execution_end" &&
        event.toolName === "search_memory" &&
        event.toolCallId === artifactQueryStart?.toolCallId,
    );
    passed =
      passed &&
      artifactQueryStart?.args?.query?.includes("BUILD_ERROR") === true &&
      JSON.stringify(artifactQueryEnd?.result?.content ?? []).includes("src/index.ts:42");
    if (!passed) error = "Artifact capture, anchored query, compaction, fork, or restart failed";
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await rpc.stop().catch(() => undefined);
    await restartRpc?.stop().catch(() => undefined);
    await artifactQueryRpc?.stop().catch(() => undefined);
    if (settingsExisted) await writeFile(settingsFile, settingsSnapshot, { mode: 0o600 });
    else await rm(settingsFile, { force: true });
    await writeJson(
      path.join(directories.reports, "evidence", "compaction-artifacts.json"),
      artifactEvidence,
    );
    await Promise.all(
      temporaryArtifactPaths.map((filename) =>
        rm(filename, { force: true }).catch(() => undefined),
      ),
    );
  }
  const inspection = await inspectZvec({
    rootDir: zvecRoot,
    outputFile: path.join(directories.reports, "evidence", "compaction-zvec.json"),
    prefix: runId,
    requireAcceptanceMemory: false,
  }).catch(() => undefined);
  passed = passed && inspection?.status === "PASS";
  return scenario(
    "J04",
    "Native Pi compaction, artifact provenance, and real fork",
    "P0-P6",
    passed ? "PASS" : "FAIL",
    started,
    {
      evidence: [
        rpc.options.evidenceFile,
        restartRpc?.options.evidenceFile,
        artifactQueryRpc?.options.evidenceFile,
      ]
        .filter(Boolean)
        .join("; "),
      ...(passed ? {} : { error: error ?? "compaction Zvec invariants failed" }),
    },
  );
}

export async function runSkillRefreshScenario({
  piHome,
  fixtures,
  directories,
  runId,
  environment,
}) {
  const started = performance.now();
  const skillName = `${runId}_SKILL`;
  const skillDirectory = path.join(piHome, "skills", skillName);
  const zvecRoot = path.join(directories.state, "capability-zvec");
  await configureWorkspace(fixtures.repoA, zvecRoot, runId);
  await mkdir(skillDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(skillDirectory, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: Acceptance-only capability refresh proof.\n---\n\nReturn ${runId} capability proof.\n`,
    { mode: 0o600 },
  );
  const startRpc = (label) =>
    new PiRpcAcceptanceDriver(
      rpcOptions({
        piHome,
        workspace: fixtures.repoA,
        directories,
        runId,
        label,
        environment,
        tools: ["search_memory"],
        discoverSkills: true,
      }),
    );
  let first;
  let second;
  let active = [];
  let removed = [];
  let error;
  try {
    first = startRpc("capability-installed");
    await first.start();
    await first.prompt(`只回复 capability-installed ${runId}。`);
    await delay(30_000);
    await first.stop();
    active = await readCapabilityMatches({ rootDir: zvecRoot, prefix: skillName });
    await rm(skillDirectory, { recursive: true, force: true });
    second = startRpc("capability-removed");
    await second.start();
    await second.prompt(`只回复 capability-removed ${runId}。`);
    await delay(30_000);
    await second.stop();
    removed = await readCapabilityMatches({ rootDir: zvecRoot, prefix: skillName });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    await first?.stop().catch(() => undefined);
    await second?.stop().catch(() => undefined);
  } finally {
    await rm(skillDirectory, { recursive: true, force: true });
  }
  const passed =
    active.some((record) => record.installed === true) &&
    removed.some((record) => record.installed === false);
  await writeJson(path.join(directories.reports, "evidence", "capability-refresh.json"), {
    skillName,
    active,
    removed,
  });
  return scenario(
    "D05",
    "Real Skill install/uninstall capability refresh",
    "P8",
    passed ? "PASS" : "FAIL",
    started,
    {
      evidence: path.join(directories.reports, "evidence", "capability-refresh.json"),
      ...(passed
        ? {}
        : { error: error ?? "Capability record did not transition active -> removed" }),
    },
  );
}
