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
    ).toMatchObject({ shouldRecall: true, sources: ["knowledge"], allowRerank: true });
  });
});
