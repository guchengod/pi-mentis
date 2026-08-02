import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { inspectZvec } from "./state-inspector.mjs";
import { PiAcceptanceDriver } from "./pi-driver.mjs";
import { repositoryRoot, runCommand, writeJson } from "./common.mjs";

function result(id, name, stage, status, started, details = {}) {
  return {
    id,
    name,
    stage,
    status,
    durationMs: performance.now() - started,
    ...details,
  };
}

export async function configureWorkspace(workspace, zvecRoot, runId) {
  await mkdir(path.join(workspace, ".pi-mentis"), { recursive: true, mode: 0o700 });
  await writeJson(path.join(workspace, ".pi-mentis", "config.json"), {
    knowledge: { defaultNamespace: `acceptance:${runId}`, autoSync: false },
    retrieval: {
      autoRecallSoftTimeoutMs: 15_000,
      autoRecallHardTimeoutMs: 30_000,
      manualSearchTimeoutMs: 30_000,
      maxManualSearchTimeoutMs: 60_000,
    },
    storage: { rootDir: zvecRoot, lockTimeoutMs: 10_000 },
    inference: {
      siliconflow: {
        timeout: { embeddingMs: 60_000, rerankMs: 60_000 },
        retry: { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 2_000 },
      },
    },
  });
}

export async function createFixtures({ directories, runId, logs }) {
  const repoA = path.join(directories.repos, `${runId}_REPO_A`);
  const repoB = path.join(directories.repos, `${runId}_REPO_B`);
  const moved = path.join(directories.repos, `${runId}_REPO_A_MOVED`);
  const general = path.join(directories.general, `${runId}_GENERAL`);
  for (const directory of [repoA, repoB, general]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await writeJson(path.join(repoA, "package.json"), {
    name: `${runId.toLowerCase()}-repo-a`,
    private: true,
    type: "module",
    packageManager: "pnpm@10.20.0",
    scripts: { build: "tsc --noEmit", test: "node --test", large: "node large-log.mjs" },
    devDependencies: { typescript: "5.9.3" },
  });
  await writeFile(path.join(repoA, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", { mode: 0o600 });
  await writeFile(path.join(repoA, "index.ts"), "export const answer: number = 42;\n", {
    mode: 0o600,
  });
  await writeFile(
    path.join(repoA, "large-log.mjs"),
    `process.stdout.write("${runId} BUILD_ERROR src/index.ts:42\\n".repeat(300000));\n`,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(repoA, "slow-tool.mjs"),
    `console.log("${runId} SLOW_TOOL_STARTED npm proposal");\nawait new Promise((resolve) => setTimeout(resolve, 15000));\nconsole.log("${runId} SLOW_TOOL_FINISHED npm proposal");\n`,
    { mode: 0o600 },
  );
  await writeJson(path.join(repoB, "package.json"), {
    name: `${runId.toLowerCase()}-repo-b`,
    private: true,
    type: "module",
    packageManager: "npm@11.11.0",
    scripts: { build: "node -e \"console.log('npm build')\"" },
  });
  await runCommand("git", ["init", "-q"], {
    cwd: repoA,
    logFile: path.join(logs, "fixture-git-a.log"),
  });
  await runCommand("git", ["remote", "add", "origin", `file:///tmp/${runId}_REPO_A.git`], {
    cwd: repoA,
    logFile: path.join(logs, "fixture-git-a-remote.log"),
  });
  await runCommand("git", ["init", "-q"], {
    cwd: repoB,
    logFile: path.join(logs, "fixture-git-b.log"),
  });
  await runCommand("git", ["remote", "add", "origin", `file:///tmp/${runId}_REPO_B.git`], {
    cwd: repoB,
    logFile: path.join(logs, "fixture-git-b-remote.log"),
  });
  await cp(repoA, moved, { recursive: true, dereference: false, preserveTimestamps: true });
  return { repoA, repoB, moved, general };
}

function hasTool(response, name) {
  return response.toolEvents.some(
    (event) => event.toolName === name || event.name === name || event.tool?.name === name,
  );
}

export async function runPiConversationScenarios({
  piHome,
  fixtures,
  directories,
  runId,
  environment,
  label,
}) {
  const started = performance.now();
  const zvecRoot = path.join(directories.state, `${label}-zvec`);
  await configureWorkspace(fixtures.repoA, zvecRoot, runId);
  await configureWorkspace(fixtures.moved, zvecRoot, runId);
  const driver = new PiAcceptanceDriver({
    piHome,
    provider: environment.provider.piDefault,
    model: environment.provider.piModel,
    sessionDir: path.join(directories.state, `${label}-sessions`),
    logs: directories.logs,
    state: directories.state,
    label,
  });
  const commitSession = `${runId}_${label}_COMMIT`;
  const commit = await driver.sendMessage({
    sessionId: commitSession,
    cwd: fixtures.repoA,
    name: `${runId} ${label} commit`,
    prompt: `这是自动验收。必须调用 commit_memory 一次，保存“${runId} REPO_A 的正式包管理器是 pnpm”，type=fact，factKey=${runId}:package-manager，cardinality=single，idempotencyKey=${runId}:${label}:package-manager。不要修改文件。`,
  });
  const search = await driver.sendMessage({
    sessionId: `${runId}_${label}_SEARCH`,
    cwd: fixtures.moved,
    name: `${runId} ${label} search`,
    prompt: `这是新 Session。必须调用 search_memory 查询“${runId} REPO_A 使用什么包管理器”，并根据结果回答。不要修改文件。`,
  });
  const exact = hasTool(commit, "commit_memory") && hasTool(search, "search_memory");
  const recalled = search.events.some(
    (event) => event.type === "tool_execution_end" && JSON.stringify(event.result).includes("pnpm"),
  );
  let inspection;
  try {
    inspection = await inspectZvec({
      rootDir: zvecRoot,
      outputFile: path.join(directories.reports, "evidence", `${label}-zvec-state.json`),
      prefix: runId,
    });
  } catch (error) {
    inspection = {
      status: "FAIL",
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
  return {
    scenario: result(
      `${label === "isolated" ? "A" : "J"}01`,
      `${label} real Pi multi-session commit and recall`,
      label === "isolated" ? "Install" : "P0-P6",
      commit.exitCode === 0 &&
        search.exitCode === 0 &&
        exact &&
        recalled &&
        inspection.status === "PASS"
        ? "PASS"
        : "FAIL",
      started,
      {
        evidence: `${commit.logFile}; ${search.logFile}`,
        error:
          commit.exitCode !== 0
            ? `commit exit ${commit.exitCode}`
            : search.exitCode !== 0
              ? `search exit ${search.exitCode}`
              : !exact
                ? "required Pi tool events were absent"
                : !recalled
                  ? "new Session did not recall pnpm"
                  : inspection.errors?.join("; ") ||
                    inspection.invariants
                      ?.filter((invariant) => !invariant.passed)
                      .map((invariant) => invariant.name)
                      .join("; "),
      },
    ),
    zvecRoot,
    inspection,
  };
}

export async function runAutomatedSuites({ directories }) {
  const results = [];
  const focused = [
    ["T01", "Unit and property tests", "P0-P6", ["test"]],
    ["T02", "Real Zvec integration and state-machine tests", "Recovery", ["test:integration"]],
    ["M01", "10k real-Zvec release performance gates", "Performance", ["benchmark:smoke"]],
  ];
  for (const [id, name, stage, args] of focused) {
    const started = performance.now();
    const command = await runCommand("pnpm", args, {
      timeoutMs: 30 * 60_000,
      logFile: path.join(directories.logs, `${id}.log`),
      allowFailure: true,
    });
    results.push(
      result(id, name, stage, command.exitCode === 0 ? "PASS" : "FAIL", started, {
        evidence: path.join(directories.logs, `${id}.log`),
        ...(command.exitCode === 0 ? {} : { error: command.output.slice(-1_000) }),
      }),
    );
  }
  for (const filename of ["hook-gates-performance.json", "zvec-10k-performance.json"]) {
    try {
      await cp(
        path.join(repositoryRoot, ".artifacts", "test-reports", filename),
        path.join(directories.reports, "evidence", filename),
      );
    } catch {
      // The corresponding command result remains authoritative when an older
      // benchmark implementation does not emit a structured sidecar.
    }
  }
  const liveStarted = performance.now();
  const live = await runCommand("node", ["scripts/live-e2e.mjs", "all"], {
    env: { ...process.env, PI_MENTIS_LIVE_E2E: "1" },
    timeoutMs: 45 * 60_000,
    logFile: path.join(directories.logs, "live-e2e-all.log"),
    allowFailure: true,
    captureLimit: 32 * 1024 * 1024,
  });
  const match = /"runId"\s*:\s*"([^"]+)"/u.exec(live.output);
  const liveRunId = match?.[1];
  let liveReport;
  if (liveRunId !== undefined) {
    const source = path.join(
      repositoryRoot,
      ".artifacts",
      "live-e2e",
      liveRunId,
      "reports",
      "live-e2e.json",
    );
    try {
      liveReport = JSON.parse(await readFile(source, "utf8"));
      await cp(source, path.join(directories.reports, "evidence", "live-e2e.json"));
    } catch {
      liveReport = undefined;
    }
  }
  results.push(
    result(
      "P01",
      "Real Pi 0.83.0, Zvec and SiliconFlow full Live E2E",
      "Provider",
      live.exitCode === 0 ? "PASS" : "FAIL",
      liveStarted,
      {
        evidence: liveRunId ?? path.join(directories.logs, "live-e2e-all.log"),
        ...(live.exitCode === 0 ? {} : { error: live.output.slice(-1_000) }),
      },
    ),
  );
  const suitePassed = results.every((item) => item.status === "PASS");
  const coverage = [
    ["TX01", "Artifact, task graph, experience and restart invariants", "Tencent"],
    ["P8-CORE", "Context, identity and capability snapshot invariants", "P8"],
    ["P9-CORE", "Temporal head, conflict, history and branch invariants", "P9"],
    ["P10-CORE", "Applicability, trust, identity and prompt-injection gates", "P10"],
    ["P11-CORE", "Evidence-backed hierarchical views and repair", "P11"],
    ["P12-CORE", "Effectiveness trace, causal credit and diagnostics", "P12"],
    ["P13-CORE", "Policy replay, shadow, canary, rollback and cooldown", "P13"],
    ["SEC01", "Cross-user and cross-project retrieval exposure remains zero", "Security"],
    ["SEC02", "Untrusted and prompt-injection content cannot execute instructions", "Security"],
    ["SEC03", "Evidence authority and visibility gates fail closed", "Security"],
  ];
  for (const [id, name, stage] of coverage) {
    results.push(
      result(id, name, stage, suitePassed ? "PASS" : "FAIL", performance.now(), {
        evidence: `${path.join(directories.logs, "T01.log")}; ${path.join(directories.logs, "T02.log")}; ${path.join(directories.logs, "live-e2e-all.log")}`,
        ...(suitePassed ? {} : { error: "Required unit, real-Zvec, or Live E2E suite failed" }),
      }),
    );
  }
  return { results, liveRunId, liveReport };
}

export async function runQuickSoak({ driverOptions, workspace, runId, directories, seconds }) {
  const started = performance.now();
  const deadline = Date.now() + seconds * 1_000;
  let iterations = 0;
  const latencies = [];
  const driver = new PiAcceptanceDriver(driverOptions);
  while (Date.now() < deadline) {
    iterations++;
    const response = await driver.sendMessage({
      sessionId: `${runId}_SOAK_${iterations}`,
      cwd: workspace,
      prompt: `自动 Soak 第 ${iterations} 轮。必须调用 search_memory 查询 ${runId} package manager，只读，不修改文件。`,
      timeoutMs: 3 * 60_000,
    });
    latencies.push(response.durationMs);
    if (response.exitCode !== 0) {
      return result("S01", `${seconds}s real Pi quick soak`, "Soak", "FAIL", started, {
        error: `iteration ${iterations} exited ${response.exitCode}`,
      });
    }
    if (Date.now() < deadline) await delay(5_000);
  }
  await writeJson(path.join(directories.reports, "evidence", "quick-soak.json"), {
    seconds,
    iterations,
    minMs: Math.min(...latencies),
    maxMs: Math.max(...latencies),
    averageMs: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
  });
  return result("S01", `${seconds}s real Pi quick soak`, "Soak", "PASS", started, {
    evidence: `${iterations} full Pi process iterations; does not replace 2h/24h soak`,
  });
}
