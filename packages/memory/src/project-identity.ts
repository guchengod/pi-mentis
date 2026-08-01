import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { contentHash, stableHash } from "@pi-mentis/pi-mentis-core";

export interface PiProjectIdentity {
  readonly workspacePath: string;
  readonly repositoryRoot?: string;
  readonly repositoryId?: string;
  readonly projectId?: string;
  readonly gitRemote?: string;
  readonly manifestName?: string;
  readonly manifestTypes: readonly string[];
  readonly manifestHash?: string;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function findRepositoryRoot(cwd: string): Promise<string | undefined> {
  let current = path.resolve(cwd);
  while (true) {
    if (await exists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function optionalText(filename: string): Promise<string | undefined> {
  try {
    return await readFile(filename, "utf8");
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

export function normalizeRemote(remote: string): string {
  return remote
    .trim()
    .replace(/^ssh:\/\//, "")
    .replace(/^https?:\/\//, "")
    .replace(/^git@/, "")
    .replace(/^([^/]+):/, "$1/")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function gitRemote(config: string | undefined): string | undefined {
  if (config === undefined) return undefined;
  const section = config.match(/\[remote\s+"origin"\]([\s\S]*?)(?=\n\[|$)/)?.[1];
  const origin = section?.match(/^\s*url\s*=\s*(.+)$/m)?.[1]?.trim();
  return origin === undefined ? undefined : normalizeRemote(origin);
}

function packageName(packageJson: string | undefined): string | undefined {
  if (packageJson === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(packageJson);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const name = (parsed as Record<string, unknown>)["name"];
    return typeof name === "string" && name !== "" ? name : undefined;
  } catch {
    return undefined;
  }
}

function goModule(goMod: string | undefined): string | undefined {
  return goMod?.match(/^module\s+(.+)$/m)?.[1]?.trim();
}

export async function resolvePiProjectIdentity(
  cwd: string,
  explicitProjectId?: string,
): Promise<PiProjectIdentity> {
  const workspacePath = path.resolve(cwd);
  const repositoryRoot = await findRepositoryRoot(workspacePath);
  const manifestRoot = repositoryRoot ?? workspacePath;
  const [gitConfig, packageJson, goMod] = await Promise.all([
    repositoryRoot === undefined
      ? Promise.resolve(undefined)
      : optionalText(path.join(repositoryRoot, ".git", "config")),
    optionalText(path.join(manifestRoot, "package.json")),
    optionalText(path.join(manifestRoot, "go.mod")),
  ]);
  const remote = gitRemote(gitConfig);
  const manifestName = packageName(packageJson) ?? goModule(goMod);
  const manifests = [
    ...(packageJson === undefined
      ? []
      : [{ type: "package.json", name: packageName(packageJson) ?? "" }]),
    ...(goMod === undefined ? [] : [{ type: "go.mod", name: goModule(goMod) ?? "" }]),
  ];
  const manifestHash = manifests.length === 0 ? undefined : contentHash(JSON.stringify(manifests));
  const repositoryId =
    explicitProjectId !== undefined
      ? `repo:explicit:${stableHash("explicit-repository:v1", explicitProjectId)}`
      : remote !== undefined
        ? `repo:remote:${stableHash("remote-repository:v1", remote)}`
        : manifests.length > 0
          ? `repo:manifest:${stableHash("manifest-repository:v1", JSON.stringify(manifests))}`
          : repositoryRoot === undefined
            ? undefined
            : `repo:path:${stableHash("path-repository:v1", repositoryRoot)}`;
  const projectId =
    explicitProjectId !== undefined
      ? `project:explicit:${stableHash("explicit-project:v1", explicitProjectId)}`
      : repositoryId === undefined
        ? undefined
        : `project:${stableHash("pi-project:v1", repositoryId, manifestName ?? path.basename(manifestRoot))}`;
  return {
    workspacePath,
    ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
    ...(repositoryId === undefined ? {} : { repositoryId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(remote === undefined ? {} : { gitRemote: remote }),
    ...(manifestName === undefined ? {} : { manifestName }),
    manifestTypes: manifests.map((manifest) => manifest.type),
    ...(manifestHash === undefined ? {} : { manifestHash }),
  };
}
