import { homedir } from "node:os";
import path from "node:path";

/**
 * Resolves the single global Pi Mentis storage root.
 *
 * ONE physical store for all projects, all working directories.
 * Logical scope is handled by MemoryScope, not by directory layout.
 *
 * Resolution order:
 *   1. PI_MENTIS_HOME env var (absolute path, test override)
 *   2. process.env["PI_CODING_AGENT_DIR"] (Pi agent home)
 *   3. ~/.pi (standard Pi home on all platforms)
 */
export interface StorageRootResolution {
  readonly piHome: string;
  readonly mentisRoot: string;
  readonly zvecRoot: string;
  readonly source: "pi-mentis-env" | "pi-agent-dir" | "home-fallback";
  readonly isTestOverride: boolean;
}

function resolvePiHome(): { path: string; source: "pi-agent-dir" | "home-fallback" } {
  const piAgentDir = process.env["PI_CODING_AGENT_DIR"]?.trim();
  if (piAgentDir !== undefined && piAgentDir !== "") {
    return { path: path.resolve(piAgentDir), source: "pi-agent-dir" };
  }
  return { path: path.join(homedir(), ".pi"), source: "home-fallback" };
}

/**
 * The single global Mentis root. Every Pi process uses this, regardless of cwd.
 */
export function resolveStorageRoot(): StorageRootResolution {
  // 1. Explicit PI_MENTIS_HOME override (test mode only)
  const mentisHome = process.env["PI_MENTIS_HOME"]?.trim();
  if (mentisHome !== undefined && mentisHome !== "") {
    if (!path.isAbsolute(mentisHome)) {
      throw new Error(`PI_MENTIS_HOME must be an absolute path; received "${mentisHome}"`);
    }
    const resolved = path.resolve(mentisHome);
    return {
      piHome: resolved,
      mentisRoot: resolved,
      zvecRoot: path.join(resolved, "zvec"),
      source: "pi-mentis-env",
      isTestOverride: true,
    };
  }

  // 2. Standard Pi home
  const pi = resolvePiHome();
  const mentisRoot = path.join(pi.path, ".pi-mentis");
  return {
    piHome: pi.path,
    mentisRoot,
    zvecRoot: path.join(mentisRoot, "zvec"),
    source: pi.source,
    isTestOverride: false,
  };
}

/**
 * Global config file — always at PI_HOME/.pi-mentis/config.json
 */
export function globalConfigPath(): string {
  const root = resolveStorageRoot();
  return path.join(root.mentisRoot, "config.json");
}

/**
 * Create the Pi Mentis home directory structure.
 * Always under PI_HOME, never under cwd.
 */
export function mentisDirectoryLayout(root: StorageRootResolution) {
  return {
    root: root.mentisRoot,
    zvec: path.join(root.mentisRoot, "zvec"),
    config: path.join(root.mentisRoot, "config.json"),
    locks: path.join(root.mentisRoot, "locks"),
    jobs: path.join(root.mentisRoot, "jobs"),
    migrations: path.join(root.mentisRoot, "migrations"),
    diagnostics: path.join(root.mentisRoot, "diagnostics"),
    backups: path.join(root.mentisRoot, "backups"),
  };
}

/**
 * Detect if the current working directory has a legacy (project-local)
 * .pi-mentis directory that needs migration.
 */
export function detectLegacyProjectStore(cwd: string): {
  detected: boolean;
  path: string;
} {
  const legacyPath = path.join(cwd, ".pi-mentis");
  // Only detect if it's NOT the global store
  const globalRoot = resolveStorageRoot().mentisRoot;
  if (legacyPath === globalRoot) {
    return { detected: false, path: legacyPath };
  }
  // We can't check fs here (sync), caller should use fs.existsSync
  return { detected: true, path: legacyPath };
}

/**
 * Status summary for diagnostics.
 */
export interface StorageStatus {
  readonly storageMode: "global";
  readonly piHome: string;
  readonly mentisRoot: string;
  readonly zvecRoot: string;
  readonly rootSource: string;
  readonly isTestOverride: boolean;
  readonly legacyProjectStoreDetected: boolean;
  readonly legacyProjectStorePath?: string;
}

export function getStorageStatus(cwd: string, legacyDetected: boolean): StorageStatus {
  const root = resolveStorageRoot();
  const legacy = detectLegacyProjectStore(cwd);
  return {
    storageMode: "global",
    piHome: root.piHome,
    mentisRoot: root.mentisRoot,
    zvecRoot: root.zvecRoot,
    rootSource: root.source,
    isTestOverride: root.isTestOverride,
    legacyProjectStoreDetected: legacyDetected || legacy.detected,
    ...(legacy.detected ? { legacyProjectStorePath: legacy.path } : {}),
  };
}
