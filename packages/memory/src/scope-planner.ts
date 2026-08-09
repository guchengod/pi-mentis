/**
 * ScopePlanner — determines MemoryScope ownership semantically.
 *
 * Ownership-first: Memory Scope represents "where this fact belongs", NOT
 * "where the user happens to be when saying it". The active context (task,
 * topic, repo, project) describes where the observation happened; ownership
 * decides where the fact is visible in the future.
 *
 * V2 uses conservative structural ownership; user assertions remain durable
 * user memories while internal producers pass an explicit scope.
 *
 * This file keeps only:
 *   - stableRepositoryId (deterministic id derivation, not content rules)
 *
 * Relationship evolution is intentionally outside this ownership planner.
 */

import { createHash } from "node:crypto";

export {
  ScopeSemanticPlanner,
  resolveOwnerId,
  memoryScopeForDecision,
  embedFactContent,
} from "./scope-semantics.js";
export type { ScopeOwnerKind, ExtractedFact, ScopeOwnershipDecision } from "./scope-semantics.js";

// ─── Repository ID generation ─────────────────────────────────────

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function stableRepositoryId(canonicalGitRoot: string, normalizedRemoteUrl?: string): string {
  return sha256(canonicalGitRoot + "\n" + (normalizedRemoteUrl ?? ""));
}
