import { normalizeText } from "@pi-mentis/pi-mentis-core";

function terms(text: string): ReadonlySet<string> {
  const normalized = normalizeText(text).toLocaleLowerCase();
  const words = normalized.split(/[^\p{L}\p{N}_-]+/u).filter((item) => item.length >= 2);
  const han = [...normalized.matchAll(/[\p{Script=Han}]{2,}/gu)].flatMap((match) => {
    const value = match[0];
    return Array.from({ length: Math.max(0, value.length - 1) }, (_, index) =>
      value.slice(index, index + 2),
    );
  });
  return new Set([...words, ...han]);
}

/** Binds high user authority to the current Pi user message, not to a model-selected label. */
export function memoryContentGroundedInUserPrompt(
  content: string,
  userPrompt: string | undefined,
): boolean {
  if (userPrompt === undefined || userPrompt.trim() === "") return false;
  const contentTerms = terms(content);
  const promptTerms = terms(userPrompt);
  if (contentTerms.size === 0 || promptTerms.size === 0) return false;
  const overlap = [...contentTerms].filter((term) => promptTerms.has(term)).length;
  return overlap >= Math.min(2, contentTerms.size) && overlap / contentTerms.size >= 0.35;
}

/** Extracts only IDs carried in memory-id-shaped tool arguments, including nested inputs. */
export function referencedMemoryIds(value: unknown, keyHint = ""): readonly string[] {
  if (typeof value === "string") {
    return /memory.*id|id.*memory/i.test(keyHint) ? [value] : [];
  }
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap((item) => referencedMemoryIds(item, keyHint)))];
  }
  if (typeof value !== "object" || value === null) return [];
  return [
    ...new Set(
      Object.entries(value as Readonly<Record<string, unknown>>).flatMap(([key, item]) =>
        referencedMemoryIds(item, key),
      ),
    ),
  ];
}
