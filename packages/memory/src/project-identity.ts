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
  readonly repositorySignature?: string;
  readonly packageManager?: string;
  readonly packageManagerVersion?: string;
  readonly language?: string;
  readonly branchName?: string;
  readonly commitId?: string;
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
      ["ENOENT", "ENOTDIR"].includes(String((error as { code?: unknown }).code))
    ) {
      return undefined;
    }
    throw error;
  }
}

async function resolveGitDirectory(
  repositoryRoot: string | undefined,
): Promise<string | undefined> {
  if (repositoryRoot === undefined) return undefined;
  const marker = path.join(repositoryRoot, ".git");
  try {
    const metadata = await stat(marker);
    if (metadata.isDirectory()) return marker;
    if (!metadata.isFile()) return undefined;
    const pointer = await readFile(marker, "utf8");
    const gitdir = pointer.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    return gitdir === undefined ? undefined : path.resolve(repositoryRoot, gitdir);
  } catch {
    return undefined;
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

function packageManagerDeclaration(packageJson: string | undefined): string | undefined {
  if (packageJson === undefined) return undefined;
  try {
    const parsed = JSON.parse(packageJson) as Record<string, unknown>;
    return typeof parsed["packageManager"] === "string" ? parsed["packageManager"] : undefined;
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
  const gitDirectory = await resolveGitDirectory(repositoryRoot);
  const commonDirectoryPointer =
    gitDirectory === undefined
      ? undefined
      : (await optionalText(path.join(gitDirectory, "commondir")))?.trim();
  const gitCommonDirectory =
    gitDirectory === undefined
      ? undefined
      : commonDirectoryPointer === undefined
        ? gitDirectory
        : path.resolve(gitDirectory, commonDirectoryPointer);
  const head =
    gitDirectory === undefined ? undefined : await optionalText(path.join(gitDirectory, "HEAD"));
  const headRef = head?.match(/^ref:\s*(.+)$/)?.[1]?.trim();
  const branchName = headRef?.replace(/^refs\/heads\//, "");
  const looseCommitId =
    headRef === undefined
      ? head?.trim()
      : gitDirectory === undefined
        ? undefined
        : (await optionalText(path.join(gitDirectory, headRef)))?.trim();
  const packedRefs =
    looseCommitId !== undefined || gitDirectory === undefined
      ? undefined
      : await optionalText(path.join(gitDirectory, "packed-refs"));
  const commitId =
    looseCommitId ??
    (headRef === undefined
      ? undefined
      : packedRefs
          ?.split("\n")
          .find((line) => line.endsWith(` ${headRef}`))
          ?.split(" ")[0]);
  const manifestRoot = repositoryRoot ?? workspacePath;
  const [gitConfig, gitLog, packageJson, goMod, pyproject, cargoToml, lockfiles] =
    await Promise.all([
      gitCommonDirectory === undefined
        ? Promise.resolve(undefined)
        : optionalText(path.join(gitCommonDirectory, "config")),
      gitCommonDirectory === undefined
        ? Promise.resolve(undefined)
        : optionalText(path.join(gitCommonDirectory, "logs", "HEAD")),
      optionalText(path.join(manifestRoot, "package.json")),
      optionalText(path.join(manifestRoot, "go.mod")),
      optionalText(path.join(manifestRoot, "pyproject.toml")),
      optionalText(path.join(manifestRoot, "Cargo.toml")),
      Promise.all(
        ["pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lock", "bun.lockb"].map(
          async (name) => ((await exists(path.join(manifestRoot, name))) ? name : undefined),
        ),
      ),
    ]);
  const remote = gitRemote(gitConfig);
  const manifestName = packageName(packageJson) ?? goModule(goMod);
  const manifests = [
    ...(packageJson === undefined
      ? []
      : [{ type: "package.json", name: packageName(packageJson) ?? "" }]),
    ...(goMod === undefined ? [] : [{ type: "go.mod", name: goModule(goMod) ?? "" }]),
    ...(pyproject === undefined ? [] : [{ type: "pyproject.toml", name: "" }]),
    ...(cargoToml === undefined ? [] : [{ type: "Cargo.toml", name: "" }]),
    ...lockfiles
      .filter((name): name is string => name !== undefined)
      .map((name) => ({ type: name, name: "" })),
  ];
  const manifestHash = manifests.length === 0 ? undefined : contentHash(JSON.stringify(manifests));
  const firstCommit = gitLog?.split("\n").find(Boolean)?.trim().split(/\s+/)[1];
  const repositorySignature =
    remote !== undefined
      ? `remote:${remote}`
      : firstCommit !== undefined && !/^0+$/.test(firstCommit)
        ? `history:${firstCommit}`
        : manifestHash === undefined
          ? undefined
          : `manifest-path:${manifestHash}:${path.basename(repositoryRoot ?? workspacePath)}`;
  const repositoryId =
    explicitProjectId !== undefined
      ? `repo:explicit:${stableHash("explicit-repository:v1", explicitProjectId)}`
      : remote !== undefined
        ? `repo:remote:${stableHash("remote-repository:v1", remote)}`
        : repositorySignature !== undefined
          ? `repo:signature:${stableHash("repository-signature:v1", repositorySignature)}`
          : repositoryRoot === undefined
            ? undefined
            : `repo:path:${stableHash("path-repository:v1", repositoryRoot)}`;
  const projectId =
    explicitProjectId !== undefined
      ? `project:explicit:${stableHash("explicit-project:v1", explicitProjectId)}`
      : repositoryId === undefined
        ? undefined
        : `project:${stableHash("pi-project:v1", repositoryId, manifestName ?? path.basename(manifestRoot))}`;
  const packageManager = lockfiles.includes("pnpm-lock.yaml")
    ? "pnpm"
    : lockfiles.includes("yarn.lock")
      ? "yarn"
      : lockfiles.includes("bun.lock") || lockfiles.includes("bun.lockb")
        ? "bun"
        : lockfiles.includes("package-lock.json")
          ? "npm"
          : goMod !== undefined
            ? "go"
            : cargoToml !== undefined
              ? "cargo"
              : pyproject !== undefined
                ? "python"
                : undefined;
  const declaredPackageManager = packageManagerDeclaration(packageJson);
  const packageManagerVersion = declaredPackageManager?.split("@").slice(1).join("@") || undefined;
  const language =
    packageJson !== undefined
      ? "javascript/typescript"
      : goMod !== undefined
        ? "go"
        : cargoToml !== undefined
          ? "rust"
          : pyproject !== undefined
            ? "python"
            : undefined;
  return {
    workspacePath,
    ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
    ...(repositoryId === undefined ? {} : { repositoryId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(remote === undefined ? {} : { gitRemote: remote }),
    ...(manifestName === undefined ? {} : { manifestName }),
    manifestTypes: manifests.map((manifest) => manifest.type),
    ...(manifestHash === undefined ? {} : { manifestHash }),
    ...(repositorySignature === undefined ? {} : { repositorySignature }),
    ...(packageManager === undefined ? {} : { packageManager }),
    ...(packageManagerVersion === undefined ? {} : { packageManagerVersion }),
    ...(language === undefined ? {} : { language }),
    ...(branchName === undefined ? {} : { branchName }),
    ...(commitId === undefined || commitId === "" ? {} : { commitId }),
  };
}
