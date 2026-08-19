import { estimateModelTokens, normalizeText } from "@pi-mentis/pi-mentis-core";

import type { PiScopeContext } from "./types.js";

export function securityNamespaceForScope(
  scope: Pick<PiScopeContext, "tenantId" | "userId" | "appId" | "agentId">,
): string {
  return [scope.tenantId, scope.userId, scope.appId, scope.agentId]
    .map(encodeURIComponent)
    .join(":");
}

export function boundedText(text: string, maxCharacters: number): string {
  const normalized = normalizeText(text).replaceAll(/\s+/gu, " ").trim();
  if (normalized.length <= maxCharacters) return normalized;
  return `${normalized.slice(0, Math.max(0, maxCharacters - 1)).trimEnd()}…`;
}

export function fitTextToModelTokens(text: string, maxTokens: number): string {
  if (estimateModelTokens(text) <= maxTokens) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${text.slice(0, middle).trimEnd()}…`;
    if (estimateModelTokens(candidate) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return `${text.slice(0, low).trimEnd()}…`;
}

export function lexicalTerms(text: string): ReadonlySet<string> {
  const normalized = normalizeText(text).toLocaleLowerCase();
  const words = normalized
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((item) => item.length >= 2)
    .slice(0, 128);
  const han = [...normalized.matchAll(/[\p{Script=Han}]{2,}/gu)].flatMap((match) => {
    const value = match[0];
    return Array.from({ length: Math.max(0, value.length - 1) }, (_, index) =>
      value.slice(index, index + 2),
    );
  });
  return new Set([...words, ...han].slice(0, 256));
}

export function lexicalOverlap(left: string, right: string): number {
  const a = lexicalTerms(left);
  const b = lexicalTerms(right);
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((term) => b.has(term)).length;
  return intersection / Math.max(a.size, b.size);
}

export function appendUniqueBounded<T>(
  items: readonly T[],
  incoming: T,
  key: (item: T) => string,
  limit: number,
): readonly T[] {
  const incomingKey = key(incoming);
  return [...items.filter((item) => key(item) !== incomingKey), incoming].slice(-limit);
}
