import { cp, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { hashFile, hashPath, runCommand, writeJson } from "./common.mjs";

async function exists(target) {
  try {
    await readFile(target);
    return true;
  } catch (error) {
    if (error?.code === "EISDIR") return true;
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function backupPiState({ piHome, backup, logs }) {
  await mkdir(backup, { recursive: true, mode: 0o700 });
  const manifest = [];
  const archive = path.join(backup, "pi-home-before-install.tar.gz");
  await runCommand("tar", ["-czf", archive, "-C", path.dirname(piHome), path.basename(piHome)], {
    timeoutMs: 30 * 60_000,
    logFile: path.join(logs, "backup-pi-home.log"),
  });
  manifest.push({
    source: piHome,
    backup: archive,
    hash: await hashFile(archive),
    createdAt: new Date().toISOString(),
    type: "directory",
    format: "tar.gz",
  });
  const critical = [
    "settings.json",
    "auth.json",
    path.join("npm", "package.json"),
    path.join("npm", "package-lock.json"),
    path.join("npm", "pnpm-lock.yaml"),
    path.join("npm", "node_modules", "@galvinsan", "pi-mentis"),
    path.join("npm", ".pi-mentis"),
  ];
  for (const relative of critical) {
    const source = path.join(piHome, relative);
    if (!(await exists(source))) continue;
    const destination = path.join(backup, "critical", relative);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await cp(source, destination, {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
    });
    manifest.push({
      source,
      backup: destination,
      hash: await hashPath(destination),
      createdAt: new Date().toISOString(),
      type: (await stat(source)).isDirectory() ? "directory" : "file",
    });
  }
  const manifestFile = path.join(backup, "manifest.json");
  await writeJson(manifestFile, manifest);
  return { manifest, manifestFile, archive };
}

export async function restorePiState({ piHome, backup, logs }) {
  const archive = path.join(backup, "pi-home-before-install.tar.gz");
  const quarantine = `${piHome}.acceptance-failed-${Date.now()}`;
  await runCommand("mv", [piHome, quarantine], { logFile: path.join(logs, "restore-move.log") });
  try {
    await runCommand("tar", ["-xzf", archive, "-C", path.dirname(piHome)], {
      timeoutMs: 30 * 60_000,
      logFile: path.join(logs, "restore-pi-home.log"),
    });
  } catch (error) {
    await runCommand("mv", [quarantine, piHome], {
      allowFailure: true,
      logFile: path.join(logs, "restore-rollback.log"),
    });
    throw error;
  }
  return { restored: true, quarantine };
}
