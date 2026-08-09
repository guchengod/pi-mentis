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

    const shadowedIds = new Set(latest.candidateIds);
    const projected = result.hits.map((hit): PublicRecallHit => {
      if (hit.id === latest.memoryId) {
        return { ...hit, provisional: true, projection: "provisional_latest" };
      }
      if (shadowedIds.has(hit.id)) {
        return {
          ...hit,
          projection: "shadowed_by_pending",
          shadowedByPendingId: latest.memoryId,
        };
      }
      return hit;
    });
    const rank = (hit: PublicRecallHit): number =>
      hit.projection === "provisional_latest"
        ? 0
        : hit.projection === "shadowed_by_pending"
          ? 2
          : 1;
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
