import type { PublicRecallResult } from "./memory-tools.js";

interface RecallObservation {
  readonly query: string;
  readonly normalizedQuery: string;
  readonly id?: string;
  readonly result: PublicRecallResult;
}

const MAX_RECALLS_PER_TURN = 4;

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replaceAll(/[\p{P}\p{S}\s]+/gu, "");
}

function ngrams(value: string, width = 2): ReadonlySet<string> {
  const normalized = normalize(value);
  if (normalized.length <= width) return new Set(normalized === "" ? [] : [normalized]);
  const output = new Set<string>();
  for (let index = 0; index <= normalized.length - width; index += 1) {
    output.add(normalized.slice(index, index + width));
  }
  return output;
}

function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared += 1;
  return shared / Math.max(left.size, right.size);
}

function similarity(left: string, right: string): number {
  const a = ngrams(left);
  const b = ngrams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export function assessRecallSupport(
  request: { readonly query?: string; readonly id?: string },
  result: PublicRecallResult,
): PublicRecallResult {
  if (result.lookupMode === "exact_id" && result.entityFound === true && result.found) {
    return { ...result, supportLevel: "direct", noDirectSupport: false };
  }
  if (result.hits.length === 0) {
    return { ...result, supportLevel: "none", noDirectSupport: true };
  }
  if (request.id !== undefined && result.hits.some((hit) => hit.id === request.id)) {
    return { ...result, supportLevel: "direct", noDirectSupport: false };
  }
  const query = request.query;
  if (query === undefined) return { ...result, supportLevel: "related", noDirectSupport: true };
  const queryFeatures = ngrams(query);
  const strongest = Math.max(
    0,
    ...result.hits.map((hit) =>
      hit.match === "anchored" || hit.match === "exact"
        ? 1
        : overlap(queryFeatures, ngrams(hit.content)),
    ),
  );
  const supportLevel =
    strongest >= 0.72 ? "direct" : strongest >= 0.4 ? "related" : strongest > 0 ? "weak" : "none";
  return { ...result, supportLevel, noDirectSupport: supportLevel !== "direct" };
}

/** Turn-local semantic duplicate guard. It allows genuine reformulation but stops repeat loops. */
export class CurrentTurnRecallGuard {
  readonly #observations: RecallObservation[] = [];
  #anchorId: string | undefined;
  #anchorEntityFound: boolean | undefined;

  beginTurn(): void {
    this.#observations.length = 0;
    this.#anchorId = undefined;
    this.#anchorEntityFound = undefined;
  }

  /**
   * Establishes a strict retrieval boundary for the rest of the current user
   * turn. A model cannot escape an exact/anchored lookup by issuing a later
   * query-only call; that call inherits the existing ID at execution time.
   */
  scope(request: { readonly query?: string; readonly id?: string }): {
    readonly query?: string;
    readonly id?: string;
  } {
    if (request.id !== undefined) {
      if (this.#anchorId === undefined) this.#anchorId = request.id;
      return request.query === undefined
        ? { id: this.#anchorId }
        : { query: request.query, id: this.#anchorId };
    }
    if (this.#anchorId === undefined || request.query === undefined) return request;
    return { query: request.query, id: this.#anchorId };
  }

  repeated(request: {
    readonly query?: string;
    readonly id?: string;
  }): PublicRecallResult | undefined {
    const query = request.query;
    if (query === undefined) return undefined;
    if (this.#observations.length >= MAX_RECALLS_PER_TURN) {
      return {
        found: false,
        ...(request.id === undefined || this.#anchorEntityFound === undefined
          ? {}
          : { entityFound: this.#anchorEntityFound }),
        contentFound: false,
        lookupMode: request.id === undefined ? "global_query" : "anchored_query",
        resourceType: request.id === undefined ? "search" : "unknown",
        anchored: request.id !== undefined,
        reason: "no_direct_memory_support",
        summary:
          "The per-turn recall limit was reached. Use the evidence already returned and do not issue more memory searches in this turn.",
        hits: [],
        supportLevel: "none",
        noDirectSupport: true,
        alreadySearchedThisTurn: true,
        searchLimitReachedThisTurn: true,
      };
    }
    const prior = [...this.#observations]
      .reverse()
      .find(
        (observation) =>
          observation.id === request.id && similarity(query, observation.query) >= 0.82,
      );
    if (prior === undefined) return undefined;
    const reason = prior.result.noDirectSupport ? "no_direct_memory_support" : prior.result.reason;
    return {
      ...prior.result,
      ...(reason === undefined ? {} : { reason }),
      summary:
        "A semantically equivalent memory query was already searched in this turn. Use the existing evidence and do not repeat the same recall.",
      alreadySearchedThisTurn: true,
    };
  }

  record(
    request: { readonly query?: string; readonly id?: string },
    result: PublicRecallResult,
  ): PublicRecallResult {
    const grounded = assessRecallSupport(request, result);
    if (request.id !== undefined && result.entityFound !== undefined) {
      this.#anchorEntityFound = result.entityFound;
    }
    if (request.query !== undefined) {
      this.#observations.push({
        query: request.query,
        normalizedQuery: normalize(request.query),
        ...(request.id === undefined ? {} : { id: request.id }),
        result: grounded,
      });
      if (this.#observations.length > 8) this.#observations.shift();
    }
    return grounded;
  }
}
