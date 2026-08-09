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

// ─── Classless Record Identity ───────────────────────────────────

export interface MemoryStructuralIdentity {
  readonly recordId?: string;
  readonly contentHash?: string;
  readonly namespace?: string;
}

export function memoryStructuralIdentity(hit: SearchHit): MemoryStructuralIdentity {
  return {
    recordId: hit.id,
    contentHash: hit.contentHash,
    namespace: hit.namespace,
  };
}

export type StructuralRelation = "same_record" | "same_content" | "unrelated";

/**
 * Structural relation between two candidates.
 *
 *   same_record  — the same persisted record.
 *   same_content — identical content inside one security namespace.
 *   unrelated    — everything else.
 */
export function structuralRelation(
  left: MemoryStructuralIdentity,
  right: MemoryStructuralIdentity,
): StructuralRelation {
  if (left.recordId !== undefined && left.recordId === right.recordId) return "same_record";
  if (
    left.contentHash !== undefined &&
    left.contentHash === right.contentHash &&
    left.namespace === right.namespace
  )
    return "same_content";
  return "unrelated";
}

/**
 * Structural deduplication before diversity selection. Similar text alone is
 * never an identity signal.
 */
export function structuralDedupe<T extends SearchHit>(hits: readonly T[]): readonly T[] {
  const bestByIdentity = new Map<string, T>();
  for (const hit of hits) {
    const identity = memoryStructuralIdentity(hit);
    const key = `${identity.namespace ?? ""}:${identity.contentHash ?? identity.recordId ?? hit.id}`;
    const existing = bestByIdentity.get(key);
    if (existing === undefined || hit.score > existing.score) bestByIdentity.set(key, hit);
  }
  return [...bestByIdentity.values()].sort((left, right) => right.score - left.score);
}

export interface DiversityTraceEntry {
  readonly candidateId: string;
  readonly pairwiseSimilarity: number;
  readonly structuralRelation: StructuralRelation;
  readonly mmrPenalty: number;
  readonly preservedByIndependentIdentity: boolean;
  readonly selected: boolean;
  readonly dropReason?: string;
}

export interface DiversityOptions {
  /**
   * Optional penalty for independently identified records. The default keeps
   * ordinary MMR behaviour while record identity prevents false dedupe.
   */
  readonly independentRecordPenalty?: number;
  readonly onTrace?: (entry: DiversityTraceEntry) => void;
}

export function maximalMarginalRelevanceWithTrace(
  hits: readonly SearchHit[],
  limit: number,
  lambda = 0.75,
  options: DiversityOptions = {},
): readonly SearchHit[] {
  const independentPenalty = options.independentRecordPenalty;
  const remaining = [...hits];
  const selected: SearchHit[] = [];
  const tokenSets = new Map(remaining.map((hit) => [hit.id, terms(hit.text)]));
  const identities = new Map(hits.map((hit) => [hit.id, memoryStructuralIdentity(hit)] as const));

  const traceEntry = (
    hit: SearchHit,
    pairwise: { similarity: number; relation: StructuralRelation; penalty: number },
    selectedFlag: boolean,
    dropReason?: string,
  ): DiversityTraceEntry => {
    return {
      candidateId: hit.id,
      pairwiseSimilarity: pairwise.similarity,
      structuralRelation: pairwise.relation,
      mmrPenalty: pairwise.penalty,
      preservedByIndependentIdentity: pairwise.relation === "unrelated",
      selected: selectedFlag,
      ...(dropReason === undefined ? {} : { dropReason }),
    };
  };

  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestUtility = Number.NEGATIVE_INFINITY;
    let bestPair: {
      similarity: number;
      relation: StructuralRelation;
      penalty: number;
    } = { similarity: 0, relation: "unrelated", penalty: 0 };
    for (const [index, candidate] of remaining.entries()) {
      const candidateTerms = tokenSets.get(candidate.id) ?? new Set<string>();
      let maxSimilarity = 0;
      let maxRelation: StructuralRelation = "unrelated";
      for (const chosen of selected) {
        const similarity = jaccard(candidateTerms, tokenSets.get(chosen.id) ?? new Set<string>());
        if (similarity > maxSimilarity) {
          maxSimilarity = similarity;
          maxRelation = structuralRelation(
            identities.get(candidate.id) ?? {},
            identities.get(chosen.id) ?? {},
          );
        }
      }
      const penalty =
        maxRelation === "unrelated" && independentPenalty !== undefined
          ? independentPenalty * maxSimilarity
          : (1 - lambda) * maxSimilarity;
      const utility = lambda * candidate.score - penalty;
      if (utility > bestUtility) {
        bestUtility = utility;
        bestIndex = index;
        bestPair = { similarity: maxSimilarity, relation: maxRelation, penalty };
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    if (chosen !== undefined) {
      selected.push(chosen);
      options.onTrace?.(traceEntry(chosen, bestPair, true));
    }
  }
  for (const dropped of remaining) {
    const candidateTerms = tokenSets.get(dropped.id) ?? new Set<string>();
    let maxSimilarity = 0;
    let maxRelation: StructuralRelation = "unrelated";
    for (const chosen of selected) {
      const similarity = jaccard(candidateTerms, tokenSets.get(chosen.id) ?? new Set<string>());
      if (similarity > maxSimilarity) {
        maxSimilarity = similarity;
        maxRelation = structuralRelation(
          identities.get(dropped.id) ?? {},
          identities.get(chosen.id) ?? {},
        );
      }
    }
    options.onTrace?.(
      traceEntry(
        dropped,
        {
          similarity: maxSimilarity,
          relation: maxRelation,
          penalty:
            maxRelation === "unrelated" && independentPenalty !== undefined
              ? independentPenalty * maxSimilarity
              : (1 - lambda) * maxSimilarity,
        },
        false,
        "diversity_limit",
      ),
    );
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
