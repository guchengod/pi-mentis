import { createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir, readFile, readdir, readlink, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { clearTimeout, setTimeout } from "node:timers";

export const repositoryRoot = path.resolve(import.meta.dirname, "../..");
export const acceptanceBase = path.join(os.homedir(), ".cache", "pi-mentis-acceptance");

export function createRunId() {
  const stamp = new Date().toISOString().replaceAll(/[-:.]/gu, "").replace("Z", "Z");
  return `MENTIS_ACCEPTANCE_${stamp}_${randomBytes(4).toString("hex")}`;
}

export function assertAcceptanceRoot(root, runId) {
  const resolved = path.resolve(root);
  const relative = path.relative(acceptanceBase, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative) || path.basename(resolved) !== runId) {
    throw new Error(`Unsafe acceptance root: ${resolved}`);
  }
  if (!runId.startsWith("MENTIS_ACCEPTANCE_")) {
    throw new Error(`Unsafe acceptance run id: ${runId}`);
  }
}

export async function ensureDirectories(root, names) {
  const result = {};
  for (const name of names) {
    const directory = path.join(root, name);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    result[name] = directory;
  }
  return result;
}

export async function writeJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function runCommand(command, args, options = {}) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const chunks = [];
  let capturedBytes = 0;
  const captureLimit = options.captureLimit ?? 8 * 1024 * 1024;
  const child = spawn(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const capture = (chunk) => {
    if (capturedBytes >= captureLimit) return;
    const remaining = captureLimit - capturedBytes;
    const sliced = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
    chunks.push(sliced);
    capturedBytes += sliced.byteLength;
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  if (options.input !== undefined) child.stdin.end(options.input);
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
  });
  clearTimeout(timeout);
  const output = Buffer.concat(chunks).toString("utf8");
  if (options.logFile !== undefined) {
    await mkdir(path.dirname(options.logFile), { recursive: true, mode: 0o700 });
    await writeFile(options.logFile, output, { mode: 0o600 });
  }
  const result = {
    command,
    args,
    cwd: options.cwd ?? repositoryRoot,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: performance.now() - started,
    exitCode,
    timedOut,
    output,
    truncated: capturedBytes >= captureLimit,
  };
  if (exitCode !== 0 && options.allowFailure !== true) {
    const error = new Error(
      `${command} ${args.join(" ")} failed with exit ${exitCode}${timedOut ? " after timeout" : ""}: ${output.slice(-2_000)}`,
    );
    error.result = result;
    throw error;
  }
  return result;
}

export async function hashFile(filename) {
  const hash = createHash("sha256");
  hash.update(await readFile(filename));
  return hash.digest("hex");
}

export async function hashPath(target) {
  const metadata = await stat(target);
  if (metadata.isFile()) return hashFile(target);
  if (!metadata.isDirectory()) throw new Error(`Cannot hash unsupported path ${target}`);
  const hash = createHash("sha256");
  async function visit(directory, relative = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const entryRelative = path.join(relative, entry.name);
      hash.update(
        `${entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : "f"}:${entryRelative}\0`,
      );
      if (entry.isDirectory()) await visit(entryPath, entryRelative);
      else if (entry.isSymbolicLink()) hash.update(`${await readlink(entryPath)}\0`);
      else hash.update(await readFile(entryPath));
    }
  }
  await visit(target);
  return hash.digest("hex");
}

export function scrub(value, key = "") {
  if (/api.?key|authorization|token|secret|credential|password/iu.test(key)) {
    return value === undefined || value === null ? value : "<redacted>";
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, scrub(item, name)]),
    );
  }
  return value;
}

export function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
