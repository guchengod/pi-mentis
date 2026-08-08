/**
 * FactIdentityBuilder — deterministic fact-key construction.
 *
 * The SEMANTIC predicate is decided by CommitSemanticPlanner
 * (commit-semantics.ts), which routes the content embedding against the
 * PredicateRegistry semantic texts. This module NEVER reads natural language:
 * it only builds the stable identity string from the chosen predicate,
 * the ownership domain, and the subject key.
 */

import { normalizeText } from "@pi-mentis/pi-mentis-core";

import type { MemoryDomain, PiScopeContext } from "./types.js";
import { predicateDefinition, type KnownPredicate } from "./predicate-registry.js";

// ─── FactKey Result ───────────────────────────────────────────────

export interface FactKeyResult {
  readonly factKey: string;
  /**
   * Member-level identity for set/ordered predicates: `${factKey}/${setMemberKey}`.
   * Temporal heads, value-relation comparison and dedup operate on this key.
   * Undefined for single facts and when no member key can be derived.
   */
  readonly memberFactKey?: string;
  readonly subjectKey: string;
  readonly predicateKey: KnownPredicate | undefined;
  readonly confidence: number;
  readonly fallbackUsed: boolean;
  readonly reasons: string[];
  readonly normalizedValue?: string;
  readonly setMemberKey?: string;
}

// ─── Subject Key Extraction (deterministic metadata, not content rules) ──

function subjectKey(domain: MemoryDomain, scopeContext?: PiScopeContext): string {
  switch (domain) {
    case "project":
    case "environment":
      // Require a real repository or project ID — never "unknown-project"
      return (
        scopeContext?.repositoryId ?? scopeContext?.projectId ?? scopeContext?.userId ?? "local"
      );
    case "user":
      return scopeContext?.userId ?? "local";
    case "task":
      return scopeContext?.taskId ?? scopeContext?.userId ?? "local";
    case "capability":
      return scopeContext?.capabilitySnapshotId ?? scopeContext?.userId ?? "local";
    case "topic":
      return scopeContext?.topicIds?.[0] ?? scopeContext?.userId ?? "local";
    case "procedure":
      return scopeContext?.repositoryId ?? scopeContext?.projectId ?? "local";
    case "episodic":
      return (
        scopeContext?.repositoryId ?? scopeContext?.projectId ?? scopeContext?.userId ?? "local"
      );
    default:
      return scopeContext?.userId ?? "local";
  }
}

// ─── Post-predicate value extraction (deterministic, predicate-gated) ──

const LANGUAGE_PATTERN =
  /\b(?:go\b|golang|rust|types?cript|python|java(?!script)|kotlin|swift|zig|elixir|c\b|c#|c\+\+|ruby|php|scala|haskell|clojure|dart|lua|perl|r\b)\b/gi;

function extractLanguages(content: string): string | undefined {
  const normalized = normalizeText(content).toLowerCase();
  const langs = [...new Set(normalized.match(LANGUAGE_PATTERN) ?? [])].map((lang) =>
    lang === "golang" ? "go" : lang,
  );
  return langs.length > 0 ? langs.join(", ") : undefined;
}

function extractNormalizedValue(
  content: string,
  predicate: KnownPredicate | undefined,
): string | undefined {
  if (predicate === undefined) return undefined;
  const normalized = normalizeText(content).toLowerCase();
  if (predicate === "programming_language_preference" || predicate === "language") {
    return extractLanguages(normalized);
  }
  return undefined;
}

// ─── FactKey Derivation (consumes the SEMANTIC predicate) ─────────

/**
 * Derive a controlled FactKey from content, ownership domain, context, and
 * the predicate chosen by CommitSemanticPlanner.
 *
 * FactKey format: `<domain>:<subjectKey>/<predicateKey>`
 * Member identity (set/ordered): memberFactKey = `<factKey>/<setMemberKey>`
 *
 * If no predicate was confidently selected, returns a deterministic
 * content-hash fallback (stable identity, never a phrase rule).
 */
export function deriveFactKey(
  content: string,
  domain: MemoryDomain,
  scopeContext?: PiScopeContext,
  predicate?: KnownPredicate,
): FactKeyResult {
  const subjKey = subjectKey(domain, scopeContext);
  const reasons: string[] = [];
  const normalizedValue = extractNormalizedValue(content, predicate);
  const cardinality = predicate !== undefined ? predicateDefinition(predicate)?.cardinality : undefined;
  const setMemberKey =
    cardinality === "set" ? (normalizedValue ?? normalizeText(content).toLowerCase().slice(0, 60)) : undefined;

  if (predicate !== undefined) {
    reasons.push(`predicate "${predicate}" selected semantically`);
    const groupFactKey = `${domain}:${subjKey}/${predicate}`;
    const memberFactKey =
      (cardinality === "set" || cardinality === "ordered") && setMemberKey !== undefined
        ? `${groupFactKey}/${setMemberKey.replaceAll("/", "_")}`
        : undefined;
    return {
      factKey: groupFactKey,
      ...(memberFactKey === undefined ? {} : { memberFactKey }),
      subjectKey: subjKey,
      predicateKey: predicate,
      confidence: 0.7,
      fallbackUsed: false,
      reasons,
      ...(normalizedValue !== undefined ? { normalizedValue } : {}),
      ...(setMemberKey !== undefined ? { setMemberKey } : {}),
    };
  }

  // No semantic predicate — use a deterministic content-hash fallback so the
  // identity stays stable for the exact same wording.
  const normalized = normalizeText(content).toLowerCase();
  const shortHash = normalized
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .replace(/[^a-z0-9\u4e00-\u9fff\s]/gi, "_");
  reasons.push("no semantic predicate selected, using deterministic fallback");
  return {
    factKey: `${domain}:${subjKey}/fallback:${shortHash.slice(0, 40)}`,
    subjectKey: subjKey,
    predicateKey: undefined,
    confidence: 0.3,
    fallbackUsed: true,
    reasons,
  };
}

// ─── FactKey Conflict Check ───────────────────────────────────────

export interface FactKeyConflictCheck {
  readonly wouldConflict: boolean;
  readonly reason?: string;
}

export function checkFactKeyConflict(
  oldPredicate: KnownPredicate | undefined,
  newPredicate: KnownPredicate | undefined,
  oldDomain: MemoryDomain,
  newDomain: MemoryDomain,
  oldSubjectKey: string,
  newSubjectKey: string,
): FactKeyConflictCheck {
  if (oldSubjectKey !== newSubjectKey) {
    return { wouldConflict: false };
  }
  if (oldDomain !== newDomain) {
    return { wouldConflict: false };
  }
  if (oldPredicate !== undefined && newPredicate !== undefined && oldPredicate !== newPredicate) {
    return {
      wouldConflict: true,
      reason: `Different predicates on same subject: ${oldPredicate} vs ${newPredicate}`,
    };
  }
  return { wouldConflict: false };
}
