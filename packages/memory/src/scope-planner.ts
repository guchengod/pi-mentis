/**
 * ScopePlanner — determines MemoryScope ownership semantically.
 *
 * Ownership-first: Memory Scope represents "where this fact belongs", NOT
 * "where the user happens to be when saying it". The active context (task,
 * topic, repo, project) describes where the observation happened; ownership
 * decides where the fact is visible in the future.
 *
 * The planner NEVER reads raw content via phrases/regex/keywords. It routes
 * the fact's semantic embedding against scope prototype clusters (see
 * scope-semantics.ts) and combines routing + binding + subject evidence.
 *
 * This file keeps only:
 *   - stableRepositoryId (deterministic id derivation, not content rules)
 *
 * All former phrase-based signals (profile/project/task/topic/correction)
 * have been deleted. Correction/retraction action detection now lives in
 * CommitSemanticPlanner (commit-semantics.ts).
 */

import { createHash } from "node:crypto";

export {
  ScopeSemanticPlanner,
  SCOPE_PROTOTYPES,
  SCOPE_SUBJECT_PROTOTYPES,
  SCOPE_OWNER_KINDS,
  FileScopePrototypeCache,
  resolveOwnerId,
  memoryScopeForDecision,
  embedFactContent,
  scopeCacheKey,
} from "./scope-semantics.js";
export type {
  ScopeOwnerKind,
  ExtractedFact,
  ScopeSemanticPrototype,
  ScopeRoutingResult,
  ScopeOwnershipDecision,
  ScopePrototypeCache,
  ScopePrototypeVectorCacheRecord,
} from "./scope-semantics.js";

import type { MemoryDomain, MemoryScope } from "./types.js";

/** Ownership plan produced by the semantic scope planner. */
export interface MemoryScopePlan {
  readonly domain: MemoryDomain;
  readonly scope: MemoryScope;
  readonly confidence: number;
  readonly reasonCodes: readonly string[];
  readonly alternatives: readonly { scope: MemoryScope; score: number }[];
}

// ─── Repository ID generation ─────────────────────────────────────

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function stableRepositoryId(canonicalGitRoot: string, normalizedRemoteUrl?: string): string {
  return sha256(canonicalGitRoot + "\n" + (normalizedRemoteUrl ?? ""));
}
