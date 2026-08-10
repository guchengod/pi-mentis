import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { StorageRootMigrationRequiredError, StorageSplitBrainError } from "./errors.js";

/**
 * Resolves the single global Pi Mentis storage root.
 *
 * ONE physical store for all projects, all working directories.
 * Logical scope is handled by MemoryScope, not by directory layout.
 *
 * Resolution order:
 *   1. PI_MENTIS_HOME env var (absolute path, test override)
 *   2. process.env["PI_CODING_AGENT_DIR"] (explicit Pi profile)
 *   3. ~/.pi/.pi-mentis (stable default-profile storage)
 *
 * A store created by 0.1.41 at ~/.pi/agent/.pi-mentis remains compatible
 * when it is the only existing default-profile store.
 */
export interface StorageRootResolutionOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}

export interface StorageRootEvidence {
  readonly root: string;
  readonly configPath: string;
  readonly manifestPath: string;
  readonly configDetected: boolean;
  readonly manifestDetected: boolean;
  readonly detected: boolean;
}

export interface StorageRootResolution {
  readonly piHome: string;
  readonly mentisRoot: string;
  readonly zvecRoot: string;
  readonly source: "pi-mentis-env" | "pi-agent-dir" | "pi-default-agent-dir";
  readonly isExplicitOverride: boolean;
  readonly isDefaultProfile: boolean;
  readonly canonicalEvidence: StorageRootEvidence;
  readonly selectionStrategy:
    "explicit-override" | "explicit-profile-root" | "default-home-root" | "agent-root-compat";
  readonly inactiveAlternateEvidence?: StorageRootEvidence;
  readonly multipleStoresDetected: boolean;
  readonly migrationRequired: boolean;
  readonly splitBrainDetected: boolean;
}

function storageEvidence(root: string): StorageRootEvidence {
  const configPath = path.join(root, "config.json");
  const manifestPath = path.join(root, "zvec", "active-index-manifest.json");
  const configDetected = existsSync(configPath);
  const manifestDetected = existsSync(manifestPath);
  return {
    root,
    configPath,
    manifestPath,
    configDetected,
    manifestDetected,
    detected: configDetected || manifestDetected,
  };
}

function defaultPiAgentDir(homeDir: string): string {
  return path.join(homeDir, ".pi", "agent");
}

function resolvePiHome(
  environment: NodeJS.ProcessEnv,
  homeDir: string,
): {
  path: string;
  source: "pi-agent-dir" | "pi-default-agent-dir";
  isDefaultProfile: boolean;
} {
  const defaultAgentDir = defaultPiAgentDir(homeDir);
  const piAgentDir = environment["PI_CODING_AGENT_DIR"]?.trim();
  if (piAgentDir !== undefined && piAgentDir !== "") {
    const resolved = path.resolve(piAgentDir);
    return {
      path: resolved,
      source: "pi-agent-dir",
      isDefaultProfile: resolved === path.resolve(defaultAgentDir),
    };
  }
  return { path: defaultAgentDir, source: "pi-default-agent-dir", isDefaultProfile: true };
}

/**
 * The single global Mentis root. Every Pi process uses this, regardless of cwd.
 */
export function resolveStorageRoot(
  options: StorageRootResolutionOptions = {},
): StorageRootResolution {
  const environment = options.environment ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  // 1. Explicit PI_MENTIS_HOME override (tests or intentionally isolated storage)
  const mentisHome = environment["PI_MENTIS_HOME"]?.trim();
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
      isExplicitOverride: true,
      isDefaultProfile: false,
      canonicalEvidence: storageEvidence(resolved),
      selectionStrategy: "explicit-override",
      multipleStoresDetected: false,
      migrationRequired: false,
      splitBrainDetected: false,
    };
  }

  // 2. Standard Pi home
  const pi = resolvePiHome(environment, homeDir);
  if (!pi.isDefaultProfile) {
    const mentisRoot = path.join(pi.path, ".pi-mentis");
    return {
      piHome: pi.path,
      mentisRoot,
      zvecRoot: path.join(mentisRoot, "zvec"),
      source: pi.source,
      isExplicitOverride: false,
      isDefaultProfile: false,
      canonicalEvidence: storageEvidence(mentisRoot),
      selectionStrategy: "explicit-profile-root",
      multipleStoresDetected: false,
      migrationRequired: false,
      splitBrainDetected: false,
    };
  }

  // The default profile historically stored Mentis beside `agent/`. Release
  // 0.1.41 briefly selected `agent/.pi-mentis`; retain that location only when
  // it is the sole existing store. If both exist, the long-lived home root wins
  // deterministically and the alternate is reported as inactive. This keeps
  // every Pi mode on one active root without silently overwriting either store.
  const homeRoot = path.join(homeDir, ".pi", ".pi-mentis");
  const agentRoot = path.join(pi.path, ".pi-mentis");
  const homeEvidence = storageEvidence(homeRoot);
  const agentEvidence = storageEvidence(agentRoot);
  const selectAgentCompatibilityRoot = !homeEvidence.detected && agentEvidence.detected;
  const mentisRoot = selectAgentCompatibilityRoot ? agentRoot : homeRoot;
  const canonicalEvidence = selectAgentCompatibilityRoot ? agentEvidence : homeEvidence;
  const alternateEvidence = selectAgentCompatibilityRoot ? homeEvidence : agentEvidence;
  const multipleStoresDetected = homeEvidence.detected && agentEvidence.detected;
  return {
    piHome: pi.path,
    mentisRoot,
    zvecRoot: path.join(mentisRoot, "zvec"),
    source: pi.source,
    isExplicitOverride: false,
    isDefaultProfile: pi.isDefaultProfile,
    canonicalEvidence,
    selectionStrategy: selectAgentCompatibilityRoot ? "agent-root-compat" : "default-home-root",
    ...(alternateEvidence.detected ? { inactiveAlternateEvidence: alternateEvidence } : {}),
    multipleStoresDetected,
    migrationRequired: false,
    // Only the selected root is active. A second physical store is surfaced as
    // inactive evidence instead of disabling the entire memory extension.
    splitBrainDetected: false,
  };
}

/**
 * Refuse an implicit cutover when the previous default root still contains data.
 * An explicit PI_MENTIS_HOME override is already authoritative and never reaches
 * this branch.
 */
export function assertStorageRootReady(root: StorageRootResolution): void {
  if (!root.migrationRequired && !root.splitBrainDetected) return;
  const ErrorType = root.splitBrainDetected
    ? StorageSplitBrainError
    : StorageRootMigrationRequiredError;
  throw new ErrorType(
    root.splitBrainDetected
      ? `[STORAGE_SPLIT_BRAIN] Pi Mentis could not select one active store for ${root.mentisRoot}.`
      : `[STORAGE_ROOT_MIGRATION_REQUIRED] Pi Mentis storage at ${root.mentisRoot} requires migration.`,
    {
      operation: "storage-root-resolution",
      retryable: false,
      details: {
        canonicalRoot: root.mentisRoot,
        legacyRoot: root.inactiveAlternateEvidence?.root,
        splitBrainDetected: root.splitBrainDetected,
        migrationRequired: root.migrationRequired,
      },
    },
  );
}

/**
 * Global config file — always at PI_HOME/.pi-mentis/config.json
 */
export function globalConfigPath(options: StorageRootResolutionOptions = {}): string {
  const root = resolveStorageRoot(options);
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
export function detectLegacyProjectStore(
  cwd: string,
  options: StorageRootResolutionOptions = {},
): {
  detected: boolean;
  path: string;
  evidence: StorageRootEvidence;
} {
  const legacyPath = path.join(cwd, ".pi-mentis");
  // Only detect if it's NOT the global store
  const globalRoot = resolveStorageRoot(options).mentisRoot;
  const evidence = storageEvidence(legacyPath);
  if (legacyPath === globalRoot) {
    return { detected: false, path: legacyPath, evidence };
  }
  return { detected: evidence.detected, path: legacyPath, evidence };
}

/**
 * Status summary for diagnostics.
 */
export interface StorageStatus {
  readonly storageMode: "global-profile";
  readonly piHome: string;
  readonly mentisRoot: string;
  readonly zvecRoot: string;
  readonly effectiveZvecRoot: string;
  readonly rootSource: string;
  readonly isExplicitOverride: boolean;
  readonly isDefaultProfile: boolean;
  readonly migrationRequired: boolean;
  readonly splitBrainDetected: boolean;
  readonly selectionStrategy: StorageRootResolution["selectionStrategy"];
  readonly multipleStoresDetected: boolean;
  readonly inactiveAlternateStore?: StorageRootEvidence;
  readonly legacyProjectStoreDetected: boolean;
  readonly legacyProjectStorePath?: string;
  readonly legacyProjectStore?: StorageRootEvidence;
}

export function getStorageStatus(
  cwd: string,
  effectiveZvecRoot?: string,
  options: StorageRootResolutionOptions = {},
): StorageStatus {
  const root = resolveStorageRoot(options);
  const legacy = detectLegacyProjectStore(cwd, options);
  return {
    storageMode: "global-profile",
    piHome: root.piHome,
    mentisRoot: root.mentisRoot,
    zvecRoot: root.zvecRoot,
    effectiveZvecRoot: effectiveZvecRoot ?? root.zvecRoot,
    rootSource: root.source,
    isExplicitOverride: root.isExplicitOverride,
    isDefaultProfile: root.isDefaultProfile,
    migrationRequired: root.migrationRequired,
    splitBrainDetected: root.splitBrainDetected,
    selectionStrategy: root.selectionStrategy,
    multipleStoresDetected: root.multipleStoresDetected,
    ...(root.inactiveAlternateEvidence === undefined
      ? {}
      : { inactiveAlternateStore: root.inactiveAlternateEvidence }),
    legacyProjectStoreDetected: legacy.detected,
    ...(legacy.detected ? { legacyProjectStorePath: legacy.path } : {}),
    ...(legacy.detected ? { legacyProjectStore: legacy.evidence } : {}),
  };
}
