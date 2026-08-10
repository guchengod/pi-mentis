import type { PublicRecallResult } from "./memory-tools.js";

interface RecallObservation {
  readonly query: string;
  readonly normalizedQuery: string;
  readonly result: PublicRecallResult;
}

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

  beginTurn(): void {
    this.#observations.length = 0;
  }

  repeated(request: {
    readonly query?: string;
    readonly id?: string;
  }): PublicRecallResult | undefined {
    const query = request.query;
    if (query === undefined) return undefined;
    const prior = [...this.#observations]
      .reverse()
      .find((observation) => similarity(query, observation.query) >= 0.82);
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
    if (request.query !== undefined) {
      this.#observations.push({
        query: request.query,
        normalizedQuery: normalize(request.query),
        result: grounded,
      });
      if (this.#observations.length > 8) this.#observations.shift();
    }
    return grounded;
  }
}
