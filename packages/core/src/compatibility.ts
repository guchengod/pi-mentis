import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { UnsupportedPiVersionError } from "./errors.js";

export interface PiCompatibility {
  readonly minVersion: string;
  readonly sourceTag: string;
  readonly sourceCommit: string;
}

export const PI_COMPATIBILITY: PiCompatibility = {
  minVersion: "0.84.0",
  sourceTag: "v0.84.0",
  sourceCommit: "91b8e1a",
} as const;

export const PI_VERSION = PI_COMPATIBILITY.minVersion;

function parseSemver(version: string): [number, number, number] {
  const parts = version.split(".").map((s) => {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 0) return NaN;
    return n;
  });
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new UnsupportedPiVersionError(version, PI_COMPATIBILITY.minVersion);
  }
  return parts as [number, number, number];
}

export function isPiVersionSupported(currentVersion: string, minVersion: string): boolean {
  const [cMajor, cMinor, cPatch] = parseSemver(currentVersion);
  const [mMajor, mMinor, mPatch] = parseSemver(minVersion);
  if (cMajor > mMajor) return true;
  if (cMajor < mMajor) return false;
  if (cMinor > mMinor) return true;
  if (cMinor < mMinor) return false;
  return cPatch >= mPatch;
}

export function assertPiCompatibility(currentVersion: string): void {
  if (!isPiVersionSupported(currentVersion, PI_COMPATIBILITY.minVersion)) {
    throw new UnsupportedPiVersionError(currentVersion, PI_COMPATIBILITY.minVersion);
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

async function findRuntimePackageManifest(
  packageName: string,
  runtimeEntry: string | undefined,
): Promise<{ readonly path: string; readonly manifest: PackageManifest } | undefined> {
  if (runtimeEntry === undefined || runtimeEntry === "") return undefined;
  let entry: string;
  try {
    entry = await realpath(runtimeEntry);
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    if (code === "ENOENT") return undefined;
    throw error;
  }
  let directory = path.dirname(entry);
  const root = path.parse(directory).root;
  while (true) {
    const manifestPath = path.join(directory, "package.json");
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
  runtimeEntry: string | undefined = process.argv[1],
): Promise<string> {
  const direct = await findPackageManifest(packageName, fromUrl);
  if (direct !== undefined && typeof direct.manifest.version === "string") {
    return direct.manifest.version;
  }
  const runtime = await findRuntimePackageManifest(packageName, runtimeEntry);
  if (runtime !== undefined && typeof runtime.manifest.version === "string") {
    return runtime.manifest.version;
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
  runtimeEntry: string | undefined = process.argv[1],
): Promise<string> {
  const direct = await findPackageManifest(packageName, fromUrl);
  if (direct !== undefined) return path.dirname(direct.path);
  const runtime = await findRuntimePackageManifest(packageName, runtimeEntry);
  if (runtime !== undefined) return path.dirname(runtime.path);
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
