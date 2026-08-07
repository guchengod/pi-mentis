import type { SearchHit } from "@pi-mentis/pi-mentis-core";

import type { QueryRetrievalMode } from "./semantic-query-planner.js";

export interface AdaptiveCutoffInput<T extends SearchHit = SearchHit> {
  readonly hits: readonly T[];
  readonly mode: QueryRetrievalMode;
  readonly absoluteFloor?: number;
}

export function adaptiveCutoff<T extends SearchHit>(input: AdaptiveCutoffInput<T>): readonly T[] {
  if (input.hits.length === 0) return [];
  const ordered = [...input.hits].sort((left, right) => right.score - left.score);
  const floor = input.absoluteFloor ?? 0.04;
  const eligible = ordered.filter((hit, index) => index === 0 || hit.score >= floor);
  const top = eligible[0];
  if (top === undefined || top.score < floor) return [];

  const relativeFloor = input.mode === "focused" ? 0.7 : 0.68;
  const gapFloor = Math.max(
    input.mode === "focused" ? 0.12 : 0.14,
    top.score * (input.mode === "focused" ? 0.24 : 0.18),
  );
  const kept: T[] = [top];
  for (let index = 1; index < eligible.length; index++) {
    const previous = eligible[index - 1];
    const current = eligible[index];
    if (previous === undefined || current === undefined) break;
    if (previous.score - current.score >= gapFloor) break;
    if (current.score / Math.max(Number.EPSILON, top.score) < relativeFloor) break;
    kept.push(current);
  }
  return kept;
}
