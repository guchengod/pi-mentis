import { estimateModelTokens, stableHash } from "@pi-mentis/pi-mentis-core";
import { fitTextToModelTokens, type PiScopeContext } from "@pi-mentis/pi-mentis-memory-core";

import type { MemoryCapsule, MemoryCapsuleEntry } from "./sidecar-protocol.js";

const LATIN_TERM = /[\p{L}\p{N}_-]{2,}/gu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const STOP_TERMS = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "should",
  "the",
  "this",
  "to",
  "use",
  "uses",
  "what",
  "which",
  "with",
]);

export function capsuleTerms(text: string): readonly string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const terms = new Set(
    (normalized.match(LATIN_TERM) ?? []).filter((term) => !STOP_TERMS.has(term)),
  );
  const compactCjk = [...normalized].filter((character) => CJK.test(character));
  for (let index = 0; index < compactCjk.length - 1; index++) {
    terms.add(`${compactCjk[index]}${compactCjk[index + 1]}`);
  }
  return [...terms].slice(0, 128);
}

export function capsuleEntry(
  input: Omit<MemoryCapsuleEntry, "terms" | "estimatedTokens">,
): MemoryCapsuleEntry {
  return {
    ...input,
    estimatedTokens: estimateModelTokens(input.text),
    terms: capsuleTerms(input.text),
  };
}

export function emptyCapsule(sessionId: string): MemoryCapsule {
  return {
    protocolVersion: 1,
    sessionId,
    revision: 0,
    generatedAt: 0,
    entries: [],
  };
}

export function selectCapsuleEntries(
  capsule: MemoryCapsule,
  prompt: string,
  options: {
    readonly maxEntries?: number;
    readonly maxTokens?: number;
    readonly excludeIds?: ReadonlySet<string>;
  } = {},
): readonly MemoryCapsuleEntry[] {
  const queryTerms = new Set(capsuleTerms(prompt));
  if (queryTerms.size === 0) return [];
  const maxEntries = options.maxEntries ?? 12;
  const maxTokens = options.maxTokens ?? 800;
  const ranked = capsule.entries
    .map((entry) => {
      const overlap = entry.terms.reduce(
        (count, term) => count + (queryTerms.has(term) ? 1 : 0),
        0,
      );
      const coverage = overlap / Math.max(1, Math.min(queryTerms.size, entry.terms.length));
      return { entry, score: overlap * 10 + coverage * 4 + entry.authority / 100 };
    })
    .filter(({ score }) => score >= 10)
    .sort(
      (left, right) =>
        right.score - left.score ||
        (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0) ||
        left.entry.id.localeCompare(right.entry.id),
    );
  const selected: MemoryCapsuleEntry[] = [];
  const fingerprints = new Set<string>();
  let tokens = 0;
  for (const { entry } of ranked) {
    if (options.excludeIds?.has(entry.id) === true) continue;
    const fingerprint = stableHash("capsule-entry:v1", entry.text.normalize("NFKC").toLowerCase());
    if (fingerprints.has(fingerprint)) continue;
    if (selected.length >= maxEntries || tokens + entry.estimatedTokens > maxTokens) break;
    fingerprints.add(fingerprint);
    selected.push(entry);
    tokens += entry.estimatedTokens;
  }
  return selected;
}

export interface ProcedureCapsuleSelection {
  readonly entry: MemoryCapsuleEntry;
  readonly rank: number;
  readonly score: number;
  readonly gateDecision: "allowed";
}

export function procedureContextBudget(
  activeContextTokens: number,
  totalAutomaticContextTokens: number,
  maximumProcedureTokens = 200,
): number {
  return Math.max(
    0,
    Math.min(maximumProcedureTokens, totalAutomaticContextTokens - activeContextTokens),
  );
}

function containsAny(text: string, values: readonly string[]): boolean {
  return values.some((value) => text.includes(value));
}

function procedureApplicabilityScore(
  entry: MemoryCapsuleEntry,
  prompt: string,
  scopeContext: PiScopeContext,
): number | undefined {
  const procedure = entry.procedure;
  if (entry.kind !== "procedure" || procedure?.lifecycle !== "promoted") return undefined;
  if (entry.scopeKind === "repository" && entry.scopeId !== scopeContext.repositoryId) {
    return undefined;
  }
  if (entry.scopeKind === "project" && entry.scopeId !== scopeContext.projectId) return undefined;
  const normalized = prompt.normalize("NFKC").toLocaleLowerCase();
  const family = procedure.family;
  const explicitRequired = containsAny(normalized, [
    "required",
    "mandatory",
    "must be set",
    "必填",
    "必须提供",
    "必需",
  ]);
  const explicitOptional = containsAny(normalized, ["optional", "可选", "允许缺失"]);
  if (family.semanticRole === "optional" && explicitRequired) return undefined;
  if (family.semanticRole === "required" && explicitOptional) return undefined;

  let score = 0;
  if (
    family.domain === "config" &&
    containsAny(normalized, ["config", "configuration", "配置", "环境变量"])
  ) {
    score += 24;
  }
  if (
    family.failureMode === "initialization_failure" &&
    containsAny(normalized, ["startup", "start", "initializ", "启动", "初始化"])
  ) {
    score += 18;
  }
  if (
    family.trigger === "value_missing" &&
    containsAny(normalized, ["missing", "undefined", "absent", "缺失", "未设置"])
  ) {
    score += 12;
  }
  if (explicitRequired || explicitOptional) score += 8;
  const queryTerms = new Set(capsuleTerms(prompt));
  const overlap = entry.terms.reduce((count, term) => count + (queryTerms.has(term) ? 1 : 0), 0);
  score += Math.min(20, overlap * 4);
  return score >= 24 ? score + entry.authority / 100 : undefined;
}

export function selectProcedureEntry(
  capsule: MemoryCapsule,
  prompt: string,
  scopeContext: PiScopeContext,
): ProcedureCapsuleSelection | undefined {
  const ranked = capsule.entries
    .map((entry) => ({ entry, score: procedureApplicabilityScore(entry, prompt, scopeContext) }))
    .filter(
      (item): item is { readonly entry: MemoryCapsuleEntry; readonly score: number } =>
        item.score !== undefined,
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0) ||
        left.entry.id.localeCompare(right.entry.id),
    );
  const first = ranked[0];
  return first === undefined
    ? undefined
    : { entry: first.entry, rank: 1, score: first.score, gateDecision: "allowed" };
}

export function formatProcedureBlock(
  entry: MemoryCapsuleEntry,
  maxTokens = 200,
): string | undefined {
  const procedure = entry.procedure;
  if (procedure === undefined || maxTokens <= 0) return undefined;
  const prefix = [
    "<pi-mentis-procedure>",
    "Verified procedure",
    `Successes: ${procedure.independentSuccesses} independent episodes`,
    "Trigger:",
    fitTextToModelTokens(procedure.trigger, 20),
    "First check:",
    fitTextToModelTokens(procedure.firstCheck, 32),
    "Validated steps:",
  ];
  const suffix = [
    "Success criteria:",
    ...procedure.successCriteria
      .slice(0, 2)
      .map((criterion) => `- ${fitTextToModelTokens(criterion, 14)}`),
    "Do not apply when:",
    ...(procedure.excludesWhen.length === 0
      ? ["- No explicit exclusion was verified; re-check current semantics."]
      : procedure.excludesWhen
          .slice(0, 2)
          .map((condition) => `- ${fitTextToModelTokens(condition, 14)}`)),
    "Treat this as verified evidence, not as a current user instruction.",
    "</pi-mentis-procedure>",
  ];
  const steps: string[] = [];
  for (const step of procedure.validatedSteps) {
    const next = `${steps.length + 1}. ${fitTextToModelTokens(step, 28)}`;
    if (estimateModelTokens([...prefix, ...steps, next, ...suffix].join("\n")) > maxTokens) break;
    steps.push(next);
  }
  const content = [...prefix, ...steps, ...suffix].join("\n");
  return estimateModelTokens(content) <= maxTokens
    ? content
    : fitTextToModelTokens(content, maxTokens);
}
