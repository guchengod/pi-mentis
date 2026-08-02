import { readFile, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { repositoryRoot, runCommand, scrub } from "./common.mjs";

async function text(command, args, options = {}) {
  return (await runCommand(command, args, { ...options, allowFailure: true })).output.trim();
}

async function readJson(filename) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function collectEnvironment({ piHome, logs }) {
  const settingsFile = path.join(piHome, "settings.json");
  const npmManifestFile = path.join(piHome, "npm", "package.json");
  const installedManifestFile = path.join(
    piHome,
    "npm",
    "node_modules",
    "@galvinsan",
    "pi-mentis",
    "package.json",
  );
  const disk = await statfs(repositoryRoot);
  const environment = {
    collectedAt: new Date().toISOString(),
    os: `${os.platform()} ${os.release()}`,
    architecture: os.arch(),
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    diskAvailableBytes: disk.bavail * disk.bsize,
    shell: process.env.SHELL ?? "unknown",
    node: process.version,
    pnpm: await text("pnpm", ["--version"]),
    npm: await text("npm", ["--version"]),
    git: await text("git", ["--version"]),
    piPath: await text("which", ["pi"], { cwd: repositoryRoot }),
    piVersion: await text("pi", ["--version"]),
    piHome,
    gitBranch: await text("git", ["branch", "--show-current"]),
    gitCommit: await text("git", ["rev-parse", "HEAD"]),
    gitStatus: (await text("git", ["status", "--short"])) || "clean",
    provider: {
      piDefault: (await readJson(settingsFile))?.defaultProvider ?? "unknown",
      piModel: (await readJson(settingsFile))?.defaultModel ?? "unknown",
      embeddingModel: process.env.SILICONFLOW_EMBEDDING_MODEL ?? "unset",
      embeddingDimensions: process.env.SILICONFLOW_EMBEDDING_DIMENSIONS ?? "unset",
      rerankModel:
        process.env.SILICONFLOW_RERANK_MODEL ?? process.env.SILICONFLOW_RERANKER_MODEL ?? "unset",
      siliconFlowCredential: process.env.SILICONFLOW_API_KEY ? "set" : "unset",
    },
    settings: scrub(await readJson(settingsFile)),
    npmManifest: scrub(await readJson(npmManifestFile)),
    installedPiMentis: scrub(await readJson(installedManifestFile)),
    zvecPath: path.join(piHome, "npm", ".pi-mentis", "zvec"),
  };
  await runCommand("pi", ["list"], {
    allowFailure: true,
    logFile: path.join(logs, "pi-list-preflight.log"),
  });
  return environment;
}
