import { describe, expect, it } from "vitest";

import { EvidenceAuthority, type SearchHit } from "@pi-mentis/pi-mentis-core";
import {
  authorityAndFreshness,
  decideRecall,
  maximalMarginalRelevance,
  reciprocalRankFusion,
  selectContext,
} from "../src/index.js";

function hit(id: string, kind: SearchHit["kind"], score = 1, tokenCount = 10): SearchHit {
  return {
    id,
    kind,
    text: id === "a" || id === "b" ? "same repeated content" : "different evidence",
    score,
    tokenCount,
    authority: EvidenceAuthority.UserKnowledge,
    namespace: "test",
    contentHash: id,
  };
}

describe("retrieval algorithms", () => {
  it("fuses ranks, applies authority/freshness, diversifies, and budgets context", () => {
    const fused = reciprocalRankFusion([
      { weight: 1, hits: [hit("a", "knowledge"), hit("c", "memory")] },
      { weight: 1, hits: [hit("c", "memory"), hit("b", "knowledge")] },
    ]);
    expect(fused[0]?.id).toBe("c");
    expect(authorityAndFreshness(hit("a", "knowledge"))).toBeGreaterThan(0);
    const diverse = maximalMarginalRelevance(
      [hit("a", "knowledge"), hit("b", "knowledge", 0.99), hit("c", "memory", 0.8)],
      2,
    );
    expect(diverse.map((item) => item.id)).toContain("c");
    const selected = selectContext(
      [hit("a", "knowledge", 1, 70), hit("c", "memory", 1, 30)],
      100,
      70,
      30,
    );
    expect(selected).toHaveLength(2);
  });

  it("computes exact reciprocal ranks and deterministic diversity order", () => {
    const fused = reciprocalRankFusion(
      [
        { weight: 2, hits: [hit("a", "knowledge"), hit("c", "memory")] },
        { weight: 1, hits: [hit("c", "memory"), hit("b", "knowledge")] },
      ],
      1,
    );
    expect(fused.map(({ id, score }) => [id, score])).toEqual([
      ["c", 2 / 3 + 1 / 2],
      ["a", 1],
      ["b", 1 / 3],
    ]);
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(
      maximalMarginalRelevance(
        [
          { ...hit("a", "knowledge", 1), text: "NODE api/path" },
          { ...hit("b", "knowledge", 0.99), text: "node api/path" },
          { ...hit("c", "memory", 0.8), text: "完全 不同 证据" },
        ],
        3,
        0.5,
      ).map((item) => item.id),
    ).toEqual(["a", "c", "b"]);
    expect(maximalMarginalRelevance([hit("a", "knowledge")], 0)).toEqual([]);
    expect(maximalMarginalRelevance([], 3)).toEqual([]);
  });

  it("calculates exact authority/freshness decay and token budgets", () => {
    const day = 86_400_000;
    const base = { ...hit("a", "knowledge", 0.8), authority: 80 };
    expect(authorityAndFreshness(base, 100, 0.1)).toBeCloseTo(0.82);
    expect(
      authorityAndFreshness({ ...base, metadata: { updatedAt: 100 - 30 * day } }, 100, 0.1),
    ).toBeCloseTo(0.77);
    expect(
      authorityAndFreshness({ ...base, metadata: { updatedAt: 100 + day } }, 100, 0.1),
    ).toBeCloseTo(0.82);
    expect(authorityAndFreshness(base, 100, 0)).toBeCloseTo(0.72);

    const selected = selectContext(
      [
        { ...hit("large", "knowledge", 1, 11), authority: 100 },
        { ...hit("k", "knowledge", 1, 5), authority: 100 },
        { ...hit("m", "memory", 0.9, 5), authority: 100 },
        { ...hit("artifact", "artifact", 0.8, 4), authority: 100 },
        { ...hit("zero", "memory", 0.1, 0), authority: 100 },
      ],
      14,
      5,
      5,
    );
    expect(selected.map((item) => item.id)).toEqual(["zero", "artifact", "k", "m"]);
    expect(selectContext([hit("k", "knowledge", 1, 6)], 10, 5, 10)).toEqual([]);
    expect(selectContext([hit("m", "memory", 1, 6)], 10, 10, 5)).toEqual([]);
    expect(selectContext([hit("x", "artifact", 1, 11)], 10, 10, 10)).toEqual([]);
  });

  it("keeps recall gate pure and skips command/no-signal turns", () => {
    expect(
      decideRecall({
        prompt: "/help",
        queryCacheHit: false,
        embeddingCacheHit: false,
        remainingContextTokens: 1000,
        isCommand: true,
      }).shouldRecall,
    ).toBe(false);
    expect(
      decideRecall({
        prompt: "Where is the project API documentation?",
        queryCacheHit: false,
        embeddingCacheHit: false,
        remainingContextTokens: 4000,
        isCommand: false,
      }),
    ).toMatchObject({ shouldRecall: true, sources: ["memory"], allowRerank: false });
  });
});
