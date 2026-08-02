import { systemClock, type SearchHit } from "@pi-mentis/pi-mentis-core";

export interface RankedList {
  readonly weight: number;
  readonly hits: readonly SearchHit[];
}

export function reciprocalRankFusion(
  lists: readonly RankedList[],
  rankConstant = 60,
): readonly SearchHit[] {
  const fused = new Map<string, SearchHit>();
  for (const list of lists) {
    for (const [rank, hit] of list.hits.entries()) {
      const score = list.weight / (rankConstant + rank + 1);
      const current = fused.get(hit.id);
      fused.set(hit.id, { ...hit, score: (current?.score ?? 0) + score });
    }
  }
  return [...fused.values()].sort((left, right) => right.score - left.score);
}

function terms(text: string): ReadonlySet<string> {
  return new Set(
    text
      .normalize("NFKC")
      .toLowerCase()
      .split(/[^\p{L}\p{N}_./:-]+/u)
      .filter((term) => term.length > 1),
  );
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection++;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function maximalMarginalRelevance(
  hits: readonly SearchHit[],
  limit: number,
  lambda = 0.75,
): readonly SearchHit[] {
  const remaining = [...hits];
  const selected: SearchHit[] = [];
  const tokenSets = new Map(remaining.map((hit) => [hit.id, terms(hit.text)]));
  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestUtility = Number.NEGATIVE_INFINITY;
    for (const [index, candidate] of remaining.entries()) {
      const candidateTerms = tokenSets.get(candidate.id) ?? new Set<string>();
      const redundancy = selected.reduce(
        (maximum, chosen) =>
          Math.max(maximum, jaccard(candidateTerms, tokenSets.get(chosen.id) ?? new Set())),
        0,
      );
      const utility = lambda * candidate.score - (1 - lambda) * redundancy;
      if (utility > bestUtility) {
        bestUtility = utility;
        bestIndex = index;
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    if (chosen !== undefined) selected.push(chosen);
  }
  return selected;
}

export function authorityAndFreshness(
  hit: SearchHit,
  now = systemClock.now(),
  freshnessWeight = 0.1,
): number {
  const updatedAt =
    typeof hit.metadata?.["updatedAt"] === "number" ? hit.metadata["updatedAt"] : now;
  const ageDays = Math.max(0, (now - updatedAt) / 86_400_000);
  const freshness = 1 / (1 + ageDays / 30);
  return hit.score * 0.65 + (hit.authority / 100) * 0.25 + freshness * freshnessWeight;
}

export function selectContext(
  hits: readonly SearchHit[],
  totalTokens: number,
  knowledgeTokens: number,
  memoryTokens: number,
): readonly SearchHit[] {
  const selected: SearchHit[] = [];
  let total = 0;
  let knowledge = 0;
  let memory = 0;
  const ordered = [...hits].sort(
    (left, right) =>
      authorityAndFreshness(right) / Math.max(1, right.tokenCount) -
      authorityAndFreshness(left) / Math.max(1, left.tokenCount),
  );
  for (const hit of ordered) {
    if (total + hit.tokenCount > totalTokens) continue;
    if (hit.kind === "knowledge" && knowledge + hit.tokenCount > knowledgeTokens) continue;
    if (hit.kind === "memory" && memory + hit.tokenCount > memoryTokens) continue;
    selected.push(hit);
    total += hit.tokenCount;
    if (hit.kind === "knowledge") knowledge += hit.tokenCount;
    if (hit.kind === "memory") memory += hit.tokenCount;
  }
  return selected;
}
