import { stableHash } from "@pi-mentis/pi-mentis-core";

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

export function capsuleEntry(input: Omit<MemoryCapsuleEntry, "terms">): MemoryCapsuleEntry {
  return { ...input, terms: capsuleTerms(input.text) };
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
  options: { readonly maxEntries?: number; readonly maxCharacters?: number } = {},
): readonly MemoryCapsuleEntry[] {
  const queryTerms = new Set(capsuleTerms(prompt));
  if (queryTerms.size === 0) return [];
  const maxEntries = options.maxEntries ?? 12;
  const maxCharacters = options.maxCharacters ?? 6_400;
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
  let characters = 0;
  for (const { entry } of ranked) {
    const fingerprint = stableHash("capsule-entry:v1", entry.text.normalize("NFKC").toLowerCase());
    if (fingerprints.has(fingerprint)) continue;
    if (selected.length >= maxEntries || characters + entry.text.length > maxCharacters) break;
    fingerprints.add(fingerprint);
    selected.push(entry);
    characters += entry.text.length;
  }
  return selected;
}
