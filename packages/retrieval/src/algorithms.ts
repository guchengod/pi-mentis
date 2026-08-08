import { systemClock, type SearchHit } from "@pi-mentis/pi-mentis-core";

export interface RankedList {
  readonly weight: number;
  readonly hits: readonly SearchHit[];
}export function reciprocalRankFusion(
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

// ─── Structural Fact Identity (Set Recall Completeness) ───────────

/**
 * Structural memory identity extracted from candidate metadata — never from
 * natural language. The write path already records predicate / cardinality /
 * factKey / memberFactKey / setMemberKey on every memory payload.
 */
export interface MemoryStructuralIdentity {
  readonly predicate?: string;
  readonly cardinality?: string;
  readonly factKey?: string;
  readonly memberFactKey?: string;
  readonly setMemberKey?: string;
}

export function memoryStructuralIdentity(hit: SearchHit): MemoryStructuralIdentity {
  const metadata = hit.metadata ?? {};
  const factKey =
    typeof metadata["factKey"] === "string" ? metadata["factKey"] : undefined;
  const memberFactKey =
    typeof metadata["memberFactKey"] === "string" ? metadata["memberFactKey"] : undefined;
  const cardinality =
    typeof metadata["cardinality"] === "string" ? metadata["cardinality"] : undefined;
  const setMemberKey =
    typeof metadata["setMemberKey"] === "string" ? metadata["setMemberKey"] : undefined;
  let predicate = typeof metadata["predicate"] === "string" ? metadata["predicate"] : undefined;
  if (predicate === undefined && factKey !== undefined) {
    const segments = factKey.split("/");
    predicate = segments.length >= 2 ? segments[1] : undefined;
  }
  return {
    ...(predicate === undefined ? {} : { predicate }),
    ...(cardinality === undefined ? {} : { cardinality }),
    ...(factKey === undefined ? {} : { factKey }),
    ...(memberFactKey === undefined ? {} : { memberFactKey }),
    ...(setMemberKey === undefined ? {} : { setMemberKey }),
  };
}

export type StructuralRelation = "same_member" | "set_sibling" | "unrelated";

/**
 * Structural relation between two candidates.
 *
 *   same_member  — same member identity (memberFactKey, or factKey for
 *                  single facts / legacy unkeyed set records): duplicates
 *                  or temporal versions of the SAME fact.
 *   set_sibling  — same set group (same predicate factKey, cardinality
 *                  set/ordered) but DIFFERENT setMemberKey: distinct facts
 *                  that must NOT be suppressed as semantic duplicates.
 *   unrelated    — everything else.
 *
 * Structural fact identity always wins over embedding/text similarity.
 */
export function structuralRelation(
  left: MemoryStructuralIdentity,
  right: MemoryStructuralIdentity,
): StructuralRelation {
  const leftIdentity = left.memberFactKey ?? left.factKey;
  const rightIdentity = right.memberFactKey ?? right.factKey;
  if (leftIdentity !== undefined && leftIdentity === rightIdentity) return "same_member";
  const leftSet = left.cardinality === "set" || left.cardinality === "ordered";
  const rightSet = right.cardinality === "set" || right.cardinality === "ordered";
  if (
    leftSet &&
    rightSet &&
    left.factKey !== undefined &&
    left.factKey === right.factKey &&
    left.memberFactKey !== right.memberFactKey
  ) {
    return "set_sibling";
  }
  return "unrelated";
}

/**
 * Structural deduplication BEFORE diversity selection: keep only the
 * best-scoring candidate per member identity. Set members (different
 * setMemberKey) are distinct identities and are never collapsed.
 */
export function structuralDedupe<T extends SearchHit>(hits: readonly T[]): readonly T[] {
  const bestByIdentity = new Map<string, T>();
  const unidentifiable: T[] = [];
  for (const hit of hits) {
    const identity = memoryStructuralIdentity(hit);
    const key = identity.memberFactKey ?? identity.factKey;
    if (key === undefined) {
      unidentifiable.push(hit);
      continue;
    }
    const existing = bestByIdentity.get(key);
    if (existing === undefined || hit.score > existing.score) bestByIdentity.set(key, hit);
  }
  return [...bestByIdentity.values(), ...unidentifiable].sort(
    (left, right) => right.score - left.score,
  );
}

export interface DiversityTraceEntry {
  readonly candidateId: string;
  readonly predicate?: string;
  readonly cardinality?: string;
  readonly setMemberKey?: string;
  readonly memberFactKey?: string;
  readonly pairwiseSimilarity: number;
  readonly structuralRelation: StructuralRelation;
  readonly mmrPenalty: number;
  readonly preservedBySetCompleteness: boolean;
  readonly selected: boolean;
  readonly dropReason?: string;
}

export interface DiversityOptions {
  /**
   * Redundancy penalty applied between SET SIBLINGS (same set predicate,
   * different setMemberKey). Default 0: siblings are distinct facts and must
   * not be suppressed for content similarity. Applies only between siblings;
   * ordinary candidates keep the normal similarity penalty.
   */
  readonly setSiblingPenalty?: number;
  readonly onTrace?: (entry: DiversityTraceEntry) => void;
}

export function maximalMarginalRelevanceWithTrace(
  hits: readonly SearchHit[],
  limit: number,
  lambda = 0.75,
  options: DiversityOptions = {},
): readonly SearchHit[] {
  const siblingPenalty = options.setSiblingPenalty ?? 0;
  const remaining = [...hits];
  const selected: SearchHit[] = [];
  const tokenSets = new Map(remaining.map((hit) => [hit.id, terms(hit.text)]));
  const identities = new Map(
    hits.map((hit) => [hit.id, memoryStructuralIdentity(hit)] as const),
  );

  const traceEntry = (
    hit: SearchHit,
    pairwise: { similarity: number; relation: StructuralRelation; penalty: number },
    selectedFlag: boolean,
    dropReason?: string,
  ): DiversityTraceEntry => {
    const identity = identities.get(hit.id) ?? {};
    return {
      candidateId: hit.id,
      ...(identity.predicate === undefined ? {} : { predicate: identity.predicate }),
      ...(identity.cardinality === undefined ? {} : { cardinality: identity.cardinality }),
      ...(identity.setMemberKey === undefined
        ? {}
        : { setMemberKey: identity.setMemberKey }),
      ...(identity.memberFactKey === undefined
        ? {}
        : { memberFactKey: identity.memberFactKey }),
      pairwiseSimilarity: pairwise.similarity,
      structuralRelation: pairwise.relation,
      mmrPenalty: pairwise.penalty,
      preservedBySetCompleteness:
        pairwise.relation === "set_sibling" && pairwise.penalty === 0,
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
        const similarity = jaccard(
          candidateTerms,
          tokenSets.get(chosen.id) ?? new Set<string>(),
        );
        if (similarity > maxSimilarity) {
          maxSimilarity = similarity;
          maxRelation = structuralRelation(
            identities.get(candidate.id) ?? {},
            identities.get(chosen.id) ?? {},
          );
        }
      }
      const isSibling = maxRelation === "set_sibling";
      const penalty = isSibling ? siblingPenalty : (1 - lambda) * maxSimilarity;
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
          penalty: maxRelation === "set_sibling" ? siblingPenalty : (1 - lambda) * maxSimilarity,
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
