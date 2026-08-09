import { cp, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { hashFile, repositoryRoot, runCommand, writeJson } from "./common.mjs";

const extensionNames = [
  "@galvinsan/pi-mentis",
  "@galvinsan/pi-mentis-knowledge",
  "@galvinsan/pi-mentis-memory",
];

export async function buildAndPack({ logs, state }) {
  const commands = [
    ["install", ["install", "--frozen-lockfile"]],
    ["format-check", ["format:check"]],
    ["lint", ["lint"]],
    ["typecheck", ["typecheck"]],
    ["versions", ["check:versions"]],
    ["unit", ["test"]],
    ["e2e", ["test:e2e"]],
    ["build", ["build"]],
    ["pack", ["pack:extensions"]],
  ];
  const commandResults = [];
  for (const [label, args] of commands) {
    const result = await runCommand("pnpm", args, {
      cwd: repositoryRoot,
      timeoutMs: label === "e2e" ? 30 * 60_000 : 15 * 60_000,
      logFile: path.join(logs, `build-${label}.log`),
    });
    commandResults.push({ label, durationMs: result.durationMs, exitCode: result.exitCode });
  }
  const archiveDirectory = path.join(repositoryRoot, "dist", "extensions");
  const archives = (await readdir(archiveDirectory))
    .filter((filename) => filename.endsWith(".tgz"))
    .map((filename) => path.join(archiveDirectory, filename))
    .sort();
  if (archives.length !== 3)
    throw new Error(`Expected 3 extension archives, got ${archives.length}`);
  const artifacts = [];
  for (const archive of archives) {
    const listing = await runCommand("tar", ["-tzf", archive], {
      logFile: path.join(logs, `${path.basename(archive)}.contents.log`),
    });
    if (/\.env|auth\.json|config\.json|node_modules/iu.test(listing.output)) {
      throw new Error(`Unsafe file in ${archive}`);
    }
    if (!/dist\/index\.js\.map/u.test(listing.output)) {
      throw new Error(`${archive} has no source map`);
    }
    artifacts.push({
      filename: archive,
      sha256: await hashFile(archive),
      files: listing.output.trim().split("\n"),
    });
  }
  await writeJson(path.join(state, "build-artifacts.json"), { commandResults, artifacts });
  return { commandResults, artifacts };
}

export async function installIsolated({ piHome, archive, authSource, logs }) {
  await mkdir(piHome, { recursive: true, mode: 0o700 });
  if (authSource !== undefined) {
    await cp(authSource, path.join(piHome, "auth.json"), { preserveTimestamps: true });
  }
  const npmRoot = path.join(piHome, "npm");
  await mkdir(npmRoot, { recursive: true, mode: 0o700 });
  await writeJson(path.join(npmRoot, "package.json"), {
    name: "pi-mentis-acceptance-extensions",
    private: true,
    dependencies: {},
  });
  await writeJson(path.join(piHome, "settings.json"), {
    packages: ["npm:@galvinsan/pi-mentis"],
  });
  const environment = { ...process.env, PI_CODING_AGENT_DIR: piHome };
  // `pi install <archive.tgz>` registers the archive path as an extension file.
  // Pi only loads JavaScript/TypeScript extension paths, so install the packed
  // npm package into the isolated Pi package tree and retain the canonical
  // npm package source in settings instead.
  const installed = await runCommand("npm", ["install", "--save-exact", archive], {
    cwd: npmRoot,
    env: environment,
    timeoutMs: 10 * 60_000,
    logFile: path.join(logs, "isolated-install.log"),
  });
  const list = await runCommand("pi", ["list"], {
    env: environment,
    logFile: path.join(logs, "isolated-pi-list.log"),
  });
  if (!list.output.includes("pi-mentis")) throw new Error("Isolated Pi did not list Pi Mentis");
  return { installed, list };
}

export async function installReal({ piHome, archive, logs }) {
  const npmRoot = path.join(piHome, "npm");
  const result = await runCommand("npm", ["install", "--no-save", archive], {
    cwd: npmRoot,
    timeoutMs: 15 * 60_000,
    logFile: path.join(logs, "real-install.log"),
  });
  const manifest = JSON.parse(
    await readFile(
      path.join(npmRoot, "node_modules", "@galvinsan", "pi-mentis", "package.json"),
      "utf8",
    ),
  );
  if (manifest.name !== extensionNames[0]) throw new Error("Real Pi installed the wrong package");
  const list = await runCommand("pi", ["list"], {
    env: { ...process.env, PI_CODING_AGENT_DIR: piHome },
    logFile: path.join(logs, "real-pi-list-after-install.log"),
  });
  if (!list.output.includes("npm:@galvinsan/pi-mentis")) {
    throw new Error("Real Pi settings no longer reference npm:@galvinsan/pi-mentis");
  }
  return { result, manifest, list };
}
