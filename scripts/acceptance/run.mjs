import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { backupPiState, restorePiState } from "./backup.mjs";
import {
  runCompactionBranchScenario,
  runRemoveReloadScenario,
  runSkillRefreshScenario,
  runSteeringScenario,
} from "./advanced-scenarios.mjs";
import { buildAndPack, installIsolated, installReal } from "./build-install.mjs";
import { cleanupAcceptance } from "./cleanup.mjs";
import {
  acceptanceBase,
  assertAcceptanceRoot,
  createRunId,
  ensureDirectories,
  writeJson,
} from "./common.mjs";
import { PiAcceptanceDriver } from "./pi-driver.mjs";
import { collectEnvironment } from "./preflight.mjs";
import { runCrashMatrix } from "./fault-injector.mjs";
import { runPiStartupLatencyComparison, runScalePerformance } from "./performance.mjs";
import { generateReports } from "./report-generator.mjs";
import {
  createFixtures,
  runAutomatedSuites,
  runPiConversationScenarios,
  runQuickSoak,
} from "./scenario-runner.mjs";

const runId = process.env.PI_MENTIS_ACCEPTANCE_RUN_ID?.trim() || createRunId();
const root = path.join(acceptanceBase, runId);
assertAcceptanceRoot(root, runId);
await mkdir(root, { recursive: true, mode: 0o700 });
await writeFile(path.join(root, ".pi-mentis-acceptance-root"), `${runId}\n`, { mode: 0o600 });
const directories = await ensureDirectories(root, [
  "repos",
  "general",
  "artifacts",
  "provider",
  "logs",
  "reports",
  "backup",
  "state",
  "isolated-pi-home",
]);
await mkdir(path.join(directories.reports, "evidence"), { recursive: true, mode: 0o700 });

const startedAt = new Date().toISOString();
const piHome = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
const results = [];
const defects = [];
const fixes = [
  {
    id: "FIX-001",
    summary: "Format generated Live E2E Markdown before writing",
    regression: "format:check and full build gate",
  },
  {
    id: "FIX-002",
    summary: "Honor PI_CODING_AGENT_DIR when scanning installed Pi capabilities",
    regression: "isolated Skill active-to-removed capability refresh",
  },
  {
    id: "FIX-003",
    summary: "Restore Zvec logical document IDs from id, jobId, or traceId",
    regression: "SIGKILL View Delta recovery without duplicate job IDs",
  },
  {
    id: "FIX-004",
    summary: "Restore Pi settings byte-for-byte after native compaction acceptance",
    regression: "J04 settings SHA-256 remains identical before and after both Pi processes",
  },
];
let backup;
let realInstallAttempted = false;
let realInstallHealthy = false;
let environment;
let artifacts = [];
let zvecPath = "not-created";
let cleanup;

function record(id, name, stage, status, started, details = {}) {
  const item = { id, name, stage, status, durationMs: performance.now() - started, ...details };
  results.push(item);
  return item;
}

async function finalSmoke() {
  const workspace = path.join(root, `${runId}_FINAL_SMOKE`);
  const zvec = path.join(workspace, ".pi-mentis", "zvec");
  await mkdir(path.join(workspace, ".pi-mentis"), { recursive: true, mode: 0o700 });
  await writeJson(path.join(workspace, ".pi-mentis", "config.json"), {
    storage: { rootDir: zvec, lockTimeoutMs: 10_000 },
  });
  const driver = new PiAcceptanceDriver({
    piHome,
    provider: environment.provider.piDefault,
    model: environment.provider.piModel,
    sessionDir: path.join(workspace, "sessions"),
    logs: directories.logs,
    state: path.join(directories.reports, "evidence"),
    label: "final",
  });
  const response = await driver.sendMessage({
    sessionId: `${runId}_FINAL_SMOKE_SESSION`,
    cwd: workspace,
    prompt: `最终清理后 Smoke。必须调用 search_memory 搜索 ${runId}，然后只说明工具是否可用；不要写入记忆或文件。`,
  });
  await rm(workspace, { recursive: true, force: true });
  return response;
}

try {
  let started = performance.now();
  environment = await collectEnvironment({ piHome, logs: directories.logs });
  await writeJson(path.join(directories.reports, "environment.json"), environment);
  record("PRE01", "Real machine and Pi environment preflight", "Preflight", "PASS", started, {
    evidence: path.join(directories.reports, "environment.json"),
  });
  if (environment.piVersion !== "0.83.0") {
    record(
      "PRE02",
      "Pi adapter baseline compatibility",
      "Preflight",
      "BLOCKED",
      performance.now(),
      {
        reason: `Expected Pi 0.83.0, found ${environment.piVersion}`,
      },
    );
  } else {
    record("PRE02", "Pi adapter baseline compatibility", "Preflight", "PASS", performance.now());
  }

  const fixtures = await createFixtures({ directories, runId, logs: directories.logs });

  started = performance.now();
  const built = await buildAndPack({ logs: directories.logs, state: directories.state });
  artifacts = built.artifacts;
  record(
    "BLD01",
    "Install, lint, typecheck, unit, integration, build and package validation",
    "Build",
    "PASS",
    started,
    {
      evidence: path.join(directories.state, "build-artifacts.json"),
    },
  );
  const integratedArchive = artifacts.find((artifact) =>
    /galvinsan-pi-mentis-\d/u.test(path.basename(artifact.filename)),
  );
  if (integratedArchive === undefined) throw new Error("Integrated Pi Mentis archive not found");

  started = performance.now();
  await installIsolated({
    piHome: directories["isolated-pi-home"],
    archive: integratedArchive.filename,
    authSource: path.join(piHome, "auth.json"),
    logs: directories.logs,
  });
  record("INS01", "Install current tarball into isolated Pi Home", "Install", "PASS", started, {
    evidence: path.join(directories.logs, "isolated-pi-list.log"),
  });

  const isolated = await runPiConversationScenarios({
    piHome: directories["isolated-pi-home"],
    fixtures,
    directories,
    runId,
    environment,
    label: "isolated",
  });
  results.push(isolated.scenario);
  zvecPath = isolated.zvecRoot;

  const automated = await runAutomatedSuites({ directories });
  results.push(...automated.results);
  results.push(
    await runRemoveReloadScenario({
      piHome: directories["isolated-pi-home"],
      archive: integratedArchive.filename,
      authSource: path.join(piHome, "auth.json"),
      fixtures,
      directories,
      runId,
      environment,
    }),
  );
  results.push(
    await runSkillRefreshScenario({
      piHome: directories["isolated-pi-home"],
      fixtures,
      directories,
      runId,
      environment,
    }),
  );
  results.push(...(await runCrashMatrix({ directories, runId })));
  const scale = await runScalePerformance({
    directories,
    runId,
    maxRecords: Math.max(
      100_000,
      Number(process.env.PI_MENTIS_ACCEPTANCE_MAX_MEMORIES ?? "1000000"),
    ),
  });
  results.push(scale);
  if (scale.status !== "PASS") {
    defects.push({
      id: `DEFECT-${String(defects.length + 1).padStart(3, "0")}`,
      name: "1M real-Zvec local ANN P95 exceeds the 100ms release budget",
      status: "open",
      rootCause: "HNSW query latency at one million 1024-dimensional records",
      evidence: scale.evidence,
    });
  }
  results.push(
    await runPiStartupLatencyComparison({
      piHome: directories["isolated-pi-home"],
      workspace: fixtures.repoA,
      directories,
      runId,
      environment,
      samples: 5,
    }),
  );
  const isolatedGate =
    results.find((item) => item.id === "INS01")?.status === "PASS" &&
    results.find((item) => item.id === "P01")?.status === "PASS" &&
    results.find((item) => item.id === "A05")?.status === "PASS" &&
    results.find((item) => item.id === "D05")?.status === "PASS";

  if (isolatedGate) {
    started = performance.now();
    backup = await backupPiState({ piHome, backup: directories.backup, logs: directories.logs });
    record(
      "BKP01",
      "Hash-manifest backup of real Pi Home and Pi Mentis state",
      "Install",
      "PASS",
      started,
      {
        evidence: backup.manifestFile,
      },
    );

    started = performance.now();
    realInstallAttempted = true;
    await installReal({ piHome, archive: integratedArchive.filename, logs: directories.logs });
    record(
      "INS02",
      "Install current build into real Pi package tree without changing package source",
      "Install",
      "PASS",
      started,
      {
        evidence: path.join(directories.logs, "real-pi-list-after-install.log"),
      },
    );

    const real = await runPiConversationScenarios({
      piHome,
      fixtures,
      directories,
      runId,
      environment,
      label: "real",
    });
    results.push(real.scenario);
    zvecPath = real.zvecRoot;
    const steering = await runSteeringScenario({
      piHome,
      fixtures,
      directories,
      runId,
      environment,
    });
    results.push(steering);
    const compaction = await runCompactionBranchScenario({
      piHome,
      fixtures,
      directories,
      runId,
      environment,
    });
    results.push(compaction);
    realInstallHealthy =
      real.scenario.status === "PASS" && steering.status === "PASS" && compaction.status === "PASS";

    if (realInstallHealthy) {
      const soakSeconds = Math.max(
        30,
        Number(process.env.PI_MENTIS_ACCEPTANCE_SOAK_SECONDS ?? "300"),
      );
      const soak = await runQuickSoak({
        driverOptions: {
          piHome,
          provider: environment.provider.piDefault,
          model: environment.provider.piModel,
          sessionDir: path.join(directories.state, "soak-sessions"),
          logs: directories.logs,
          state: directories.state,
          label: "soak",
        },
        workspace: fixtures.repoA,
        runId,
        directories,
        seconds: soakSeconds,
      });
      results.push(soak);
      results.push({
        id: "S02",
        name: "2h/24h formal soak",
        stage: "Soak",
        status: "BLOCKED",
        durationMs: 0,
        reason: `${soakSeconds}s quick soak completed; this cannot replace 2h or 24h release soak`,
      });
    }
  } else {
    results.push({
      id: "INS02",
      name: "Install into real Pi",
      stage: "Install",
      status: "BLOCKED",
      durationMs: 0,
      reason: "Isolated package/live-provider gate did not pass",
    });
  }

  cleanup = await cleanupAcceptance({ root, runId, directories, preserveBackup: true });
  if (realInstallHealthy) {
    started = performance.now();
    const smoke = await finalSmoke();
    record(
      "FIN01",
      "Real Pi starts after cleanup and Pi Mentis search tool executes",
      "Install",
      smoke.exitCode === 0 ? "PASS" : "FAIL",
      started,
      {
        evidence: smoke.logFile,
        ...(smoke.exitCode === 0 ? {} : { error: `exit ${smoke.exitCode}` }),
      },
    );
  }
} catch (error) {
  defects.push({
    id: `DEFECT-${String(defects.length + 1).padStart(3, "0")}`,
    name: error instanceof Error ? error.message : String(error),
    status: "open",
    evidence: error?.result?.logFile ?? directories.logs,
  });
  results.push({
    id: "RUN-UNHANDLED",
    name: "Acceptance runner unhandled failure",
    stage: "Recovery",
    status: "FAIL",
    durationMs: 0,
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
  if (realInstallAttempted && !realInstallHealthy && backup !== undefined) {
    try {
      await restorePiState({ piHome, backup: directories.backup, logs: directories.logs });
      results.push({
        id: "RBK01",
        name: "Restore original Pi Home after failed real installation",
        stage: "Recovery",
        status: "PASS",
        durationMs: 0,
        evidence: backup.manifestFile,
      });
    } catch (restoreError) {
      results.push({
        id: "RBK01",
        name: "Restore original Pi Home after failed real installation",
        stage: "Recovery",
        status: "FAIL",
        durationMs: 0,
        error: restoreError instanceof Error ? restoreError.message : String(restoreError),
      });
    }
  }
} finally {
  environment ??= {
    piVersion: "unknown",
    gitCommit: "unknown",
    provider: {
      piDefault: "unknown",
      piModel: "unknown",
      embeddingModel: "unknown",
      rerankModel: "unknown",
    },
  };
  const endedAt = new Date().toISOString();
  const summary = await generateReports({
    reports: directories.reports,
    environment,
    runId,
    startedAt,
    endedAt,
    results,
    defects,
    fixes,
    artifacts,
    zvecPath,
    cleanup,
  });
  await writeJson(path.join(root, "run-result.json"), {
    runId,
    root,
    finalStatus: summary.finalStatus,
    report: path.join(directories.reports, "acceptance-summary.md"),
  });
  console.log(
    JSON.stringify(
      {
        runId,
        root,
        finalStatus: summary.finalStatus,
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        blocked: summary.blocked,
        skipped: summary.skipped,
        report: path.join(directories.reports, "acceptance-summary.md"),
      },
      null,
      2,
    ),
  );
  if (summary.finalStatus === "FAIL") process.exitCode = 1;
}
