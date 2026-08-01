import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { UnsupportedPiVersionError } from "./errors.js";

export interface PiCompatibility {
  readonly supportedVersion: "0.83.0";
  readonly sourceTag: "v0.83.0";
  readonly sourceCommit: "845d6ff";
}

export const PI_COMPATIBILITY: PiCompatibility = {
  supportedVersion: "0.83.0",
  sourceTag: "v0.83.0",
  sourceCommit: "845d6ff",
};

export function assertPiCompatibility(currentVersion: string): asserts currentVersion is "0.83.0" {
  if (currentVersion !== PI_COMPATIBILITY.supportedVersion) {
    throw new UnsupportedPiVersionError(currentVersion);
  }
}

interface PackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
}

async function findPackageManifest(
  packageName: string,
  fromUrl: string,
): Promise<{ readonly path: string; readonly manifest: PackageManifest } | undefined> {
  let directory = path.dirname(fileURLToPath(fromUrl));
  const root = path.parse(directory).root;
  const packageSegments = packageName.split("/");
  while (true) {
    const manifestPath = path.join(directory, "node_modules", ...packageSegments, "package.json");
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest;
      if (manifest.name === packageName) return { path: manifestPath, manifest };
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { readonly code?: unknown }).code
          : undefined;
      if (code !== "ENOENT") throw error;
    }
    if (directory === root) return undefined;
    directory = path.dirname(directory);
  }
}

export async function detectInstalledPackageVersion(
  packageName: string,
  fromUrl: string,
): Promise<string> {
  const direct = await findPackageManifest(packageName, fromUrl);
  if (direct !== undefined && typeof direct.manifest.version === "string") {
    return direct.manifest.version;
  }
  const require = createRequire(fromUrl);
  const entry = require.resolve(packageName);
  let directory = path.dirname(entry);
  const root = path.parse(directory).root;
  while (directory !== root) {
    const manifestPath = path.join(directory, "package.json");
    try {
      const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest;
      if (parsed.name === packageName && typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { readonly code?: unknown }).code
          : undefined;
      if (code !== "ENOENT") throw error;
    }
    directory = path.dirname(directory);
  }
  throw new Error(`Unable to detect installed version for ${packageName}`);
}

export async function findInstalledPackageRoot(
  packageName: string,
  fromUrl: string,
): Promise<string> {
  const direct = await findPackageManifest(packageName, fromUrl);
  if (direct !== undefined) return path.dirname(direct.path);
  const require = createRequire(fromUrl);
  const entry = require.resolve(packageName);
  let directory = path.dirname(entry);
  const root = path.parse(directory).root;
  while (directory !== root) {
    try {
      const parsed = JSON.parse(
        await readFile(path.join(directory, "package.json"), "utf8"),
      ) as PackageManifest;
      if (parsed.name === packageName) return directory;
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { readonly code?: unknown }).code
          : undefined;
      if (code !== "ENOENT") throw error;
    }
    directory = path.dirname(directory);
  }
  throw new Error(`Unable to find installed package root for ${packageName}`);
}
