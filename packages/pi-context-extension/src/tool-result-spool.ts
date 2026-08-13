import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const SPOOL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function toolResultSpoolPath(storageRoot: string, spoolId: string): string {
  if (!SPOOL_ID_PATTERN.test(spoolId)) throw new Error("Invalid tool result spool ID");
  return path.join(path.dirname(storageRoot), "ipc-spool", "tool-results", `${spoolId}.txt`);
}

export async function createToolResultSpool(
  storageRoot: string,
  text: string,
): Promise<{ readonly spoolId: string }> {
  const spoolId = randomUUID();
  const filename = toolResultSpoolPath(storageRoot, spoolId);
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await writeFile(filename, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { spoolId };
}

export async function consumeToolResultSpool(
  storageRoot: string,
  spoolId: string,
): Promise<string> {
  const filename = toolResultSpoolPath(storageRoot, spoolId);
  try {
    return await readFile(filename, "utf8");
  } finally {
    await rm(filename, { force: true });
  }
}

export async function removeToolResultSpool(storageRoot: string, spoolId: string): Promise<void> {
  await rm(toolResultSpoolPath(storageRoot, spoolId), { force: true });
}
