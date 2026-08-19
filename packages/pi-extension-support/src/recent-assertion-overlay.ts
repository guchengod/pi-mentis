import { estimateModelTokens } from "@pi-mentis/pi-mentis-core";

import type { PublicRecallHit, PublicRecallResult } from "./memory-tools.js";

export interface RecentAssertion {
  readonly memoryId: string;
  readonly content: string;
  readonly observedAt: number;
  readonly authority: "explicit_user";
  readonly candidateIds: readonly string[];
  readonly consolidationState: "pending";
}

export interface RecentAssertionOverlayOptions {
  readonly clock?: () => number;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

export interface DurablePendingProjectionReader {
  getRelationshipLearning?(incomingId: string): Promise<
    | {
        readonly incomingId: string;
        readonly state: string;
        readonly candidates: readonly { readonly id: string }[];
      }
    | undefined
  >;
  listPendingRelationshipLearning?(input?: { readonly limit?: number }): Promise<
    readonly {
      readonly incomingId: string;
      readonly state: string;
      readonly candidates: readonly { readonly id: string }[];
    }[]
  >;
  get(
    id: string,
    options?: Readonly<Record<string, unknown>>,
  ): Promise<
    | {
        readonly content: string;
        readonly observedAt: number;
        readonly authority?: number;
        readonly scope?: { readonly kind?: string };
      }
    | undefined
  >;
}

export interface AutomaticRecallHit {
  readonly id: string;
  readonly kind: "knowledge" | "memory" | "capability";
  readonly text: string;
  readonly score: number;
  readonly tokenCount: number;
  readonly authority: number;
  readonly namespace: string;
  readonly contentHash: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Applies the same durable pending projection to before-agent automatic recall. */
export async function projectDurablePendingAutomaticRecall<
  T extends { readonly hits: readonly AutomaticRecallHit[] },
>(reader: DurablePendingProjectionReader, result: T): Promise<T> {
  const listed = (await reader.listPendingRelationshipLearning?.({ limit: 32 })) ?? [];
  const unresolved = listed.filter(
    (work) =>
      work.state === "pending" || work.state === "processing" || work.state === "failed_retryable",
  );
  if (unresolved.length === 0 || result.hits.length === 0) return result;

  const connectedIds = new Set(result.hits.map((hit) => hit.id));
  const relevant = new Map<string, (typeof unresolved)[number]>();
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const work of unresolved) {
      if (relevant.has(work.incomingId)) continue;
      if (
        !connectedIds.has(work.incomingId) &&
        !work.candidates.some((candidate) => connectedIds.has(candidate.id))
      ) {
        continue;
      }
      relevant.set(work.incomingId, work);
      connectedIds.add(work.incomingId);
      for (const candidate of work.candidates) connectedIds.add(candidate.id);
      expanded = true;
    }
  }
  if (relevant.size === 0) return result;

  const candidateIds = new Set(
    [...relevant.values()].flatMap((work) => work.candidates.map((candidate) => candidate.id)),
  );
  const leaves = [...relevant.values()].filter((work) => !candidateIds.has(work.incomingId));
  const projected = await Promise.all(
    leaves.map(async (work) => ({ work, record: await reader.get(work.incomingId) })),
  );
  const records = projected.filter(
    (item): item is typeof item & { readonly record: NonNullable<typeof item.record> } =>
      item.record !== undefined,
  );
  if (records.length === 0) return result;

  const nonLeafIncomingIds = new Set(
    [...relevant.keys()].filter(
      (incomingId) => !leaves.some((leaf) => leaf.incomingId === incomingId),
    ),
  );
  const shadowedIds = new Set([...candidateIds, ...nonLeafIncomingIds]);
  const retained = result.hits.filter((hit) => !shadowedIds.has(hit.id));
  const bestScore = Math.max(1, ...result.hits.map((hit) => hit.score));
  const fallback = result.hits.find((hit) => hit.kind === "memory") ?? result.hits[0];
  if (fallback === undefined) return result;
  const provisional: AutomaticRecallHit[] = records
    .toSorted((left, right) => right.record.observedAt - left.record.observedAt)
    .map(({ work, record }, index) => ({
      id: work.incomingId,
      kind: "memory",
      text: record.content,
      score: bestScore + 1 - index / 100,
      tokenCount: estimateModelTokens(record.content),
      authority: record.authority ?? fallback.authority,
      namespace: fallback.namespace,
      contentHash: `pending:${work.incomingId}`,
      metadata: {
        pendingRelationship: true,
        provisionalLatest: true,
        shadowedCandidateIds: work.candidates.map((candidate) => candidate.id),
      },
    }));
  return { ...result, hits: [...provisional, ...retained] };
}

function publicKind(scopeKind: string | undefined): PublicRecallHit["kind"] {
  switch (scopeKind) {
    case "agent":
    case "project":
    case "repository":
    case "task":
    case "topic":
    case "event":
      return scopeKind;
    default:
      return "user";
  }
}

function normalizedBigrams(value: string): ReadonlySet<string> {
  const normalized = value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replaceAll(/[\p{P}\p{S}\s]+/gu, "");
  if (normalized.length <= 2) return new Set(normalized === "" ? [] : [normalized]);
  return new Set(
    Array.from({ length: normalized.length - 1 }, (_, index) => normalized.slice(index, index + 2)),
  );
}

function queryMatchesPending(query: string | undefined, content: string): boolean {
  if (query === undefined) return false;
  const queryFeatures = normalizedBigrams(query);
  const contentFeatures = normalizedBigrams(content);
  if (queryFeatures.size === 0 || contentFeatures.size === 0) return false;
  let shared = 0;
  for (const feature of queryFeatures) if (contentFeatures.has(feature)) shared++;
  return shared / queryFeatures.size >= 0.35;
}

/** Reconstructs read-your-writes projection from durable pending state after restart. */
export async function projectDurablePendingAssertions(
  reader: DurablePendingProjectionReader,
  request: { readonly query?: string; readonly id?: string },
  result: PublicRecallResult,
): Promise<PublicRecallResult> {
  if (reader.getRelationshipLearning === undefined) return result;
  const overlay = new RecentAssertionOverlay({ ttlMs: Number.MAX_SAFE_INTEGER });
  const hitIds = new Set(result.hits.map((hit) => hit.id));
  const listed = (await reader.listPendingRelationshipLearning?.({ limit: 32 })) ?? [];
  const listedRecords = new Map(
    (
      await Promise.all(
        listed.map(async (work) => [work.incomingId, await reader.get(work.incomingId)] as const),
      )
    ).filter(
      (item): item is readonly [string, NonNullable<(typeof item)[1]>] => item[1] !== undefined,
    ),
  );
  const direct = await Promise.all(
    result.hits.map(async (hit) => reader.getRelationshipLearning?.(hit.id)),
  );
  const works = [
    ...listed.filter(
      (work) =>
        hitIds.has(work.incomingId) ||
        work.candidates.some((candidate) => hitIds.has(candidate.id)) ||
        request.id === work.incomingId ||
        queryMatchesPending(request.query, listedRecords.get(work.incomingId)?.content ?? ""),
    ),
    ...direct.filter((work) => work !== undefined),
  ];
  const augmentedHits = [...result.hits];
  for (const work of new Map(works.map((item) => [item.incomingId, item])).values()) {
    if (
      work === undefined ||
      (work.state !== "pending" && work.state !== "processing" && work.state !== "failed_retryable")
    ) {
      continue;
    }
    const record = listedRecords.get(work.incomingId) ?? (await reader.get(work.incomingId));
    if (record === undefined) continue;
    if (!hitIds.has(work.incomingId)) {
      augmentedHits.push({
        id: work.incomingId,
        content: record.content,
        kind: publicKind(record.scope?.kind),
        status: "current",
        match: "semantic",
        resourceType: "memory",
        sanitized: false,
      });
      hitIds.add(work.incomingId);
    }
    overlay.record({
      memoryId: work.incomingId,
      content: record.content,
      observedAt: record.observedAt,
      authority: "explicit_user",
      candidateIds: work.candidates.map((candidate) => candidate.id),
    });
  }
  return overlay.project(request, {
    ...result,
    // Preserve exact entity success. ID-only Artifact/Evidence lookups return
    // metadata without content hits, so hit cardinality cannot redefine the
    // coordinator's entity-level `found` contract.
    found: result.found || augmentedHits.length > 0,
    contentFound: result.contentFound === true || augmentedHits.length > 0,
    hits: augmentedHits,
  });
}

/**
 * Session-local read-your-writes projection. This class never writes memory
 * records or changes persistent temporal status.
 */
export class RecentAssertionOverlay {
  readonly #clock: () => number;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #pending = new Map<string, RecentAssertion>();

  constructor(options: RecentAssertionOverlayOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#ttlMs = options.ttlMs ?? 5 * 60_000;
    this.#maxEntries = options.maxEntries ?? 32;
  }

  record(assertion: Omit<RecentAssertion, "consolidationState">): RecentAssertion {
    this.#prune();
    const candidateIds = [...new Set(assertion.candidateIds)].filter(
      (id) => id.length > 0 && id !== assertion.memoryId,
    );
    const pending: RecentAssertion = {
      ...assertion,
      candidateIds,
      consolidationState: "pending",
    };
    this.#pending.delete(assertion.memoryId);
    this.#pending.set(assertion.memoryId, pending);
    while (this.#pending.size > this.#maxEntries) {
      const oldestId = this.#pending.keys().next().value as string | undefined;
      if (oldestId === undefined) break;
      this.#pending.delete(oldestId);
    }
    return pending;
  }

  resolve(memoryId: string): void {
    this.#pending.delete(memoryId);
  }

  snapshot(): readonly RecentAssertion[] {
    this.#prune();
    return [...this.#pending.values()];
  }

  project(
    request: { readonly query?: string; readonly id?: string },
    result: PublicRecallResult,
  ): PublicRecallResult {
    this.#prune();
    if (result.hits.length === 0 || this.#pending.size === 0) return result;

    const hitIds = new Set(result.hits.map((hit) => hit.id));
    const relevant = [...this.#pending.values()]
      .reverse()
      .filter((assertion) => hitIds.has(assertion.memoryId) || request.id === assertion.memoryId)
      .sort((left, right) => right.observedAt - left.observedAt);
    const latest = relevant[0];
    if (latest === undefined) return result;

    const projected = result.hits.map((hit): PublicRecallHit => {
      if (hit.id === latest.memoryId) {
        return { ...hit, provisional: true, projection: "provisional_latest" };
      }
      return hit;
    });
    const rank = (hit: PublicRecallHit): number =>
      hit.projection === "provisional_latest" ? 0 : 1;
    projected.sort((left, right) => rank(left) - rank(right));

    const pendingSummary =
      `Session projection prefers recent assertion ${latest.memoryId}; ` +
      "persistent relationship consolidation is still pending.";
    return {
      ...result,
      found: true,
      summary:
        result.summary === undefined ? pendingSummary : `${result.summary} ${pendingSummary}`,
      hits: projected,
      consistency: "pending_relationship",
      provisionalLatestId: latest.memoryId,
      pendingRelationshipIds: relevant.map((assertion) => assertion.memoryId),
    };
  }

  #prune(): void {
    const cutoff = this.#clock() - this.#ttlMs;
    for (const [id, assertion] of this.#pending) {
      if (assertion.observedAt < cutoff) this.#pending.delete(id);
    }
  }
}
