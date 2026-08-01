import { bench, describe } from "vitest";

import { EvidenceAuthority, contentHash } from "@pi-mentis/pi-mentis-core";
import {
  ConservativeUtf8TokenEstimator,
  createRerankBudget,
  planRerankBatches,
} from "@pi-mentis/pi-mentis-inference";
import { reciprocalRankFusion } from "@pi-mentis/pi-mentis-retrieval";

const hits = Array.from({ length: 10_000 }, (_, index) => ({
  id: `chunk-${index}`,
  kind: "knowledge" as const,
  text: `chunk ${index}`,
  score: 1 / (index + 1),
  tokenCount: 4,
  authority: EvidenceAuthority.UserKnowledge,
  namespace: "benchmark",
  contentHash: contentHash(String(index)),
}));
const reversedHits = [...hits].reverse();
const estimator = new ConservativeUtf8TokenEstimator();
const budget = createRerankBudget("query", "rank evidence", estimator, {
  modelContextTokens: 8_192,
});
const documents = hits.slice(0, 100).map((hit) => ({ id: hit.id, text: hit.text.repeat(40) }));

describe("local retrieval hot paths", () => {
  bench(
    "reciprocal rank fusion over two 10k result sets",
    () => {
      reciprocalRankFusion([
        { weight: 1, hits },
        { weight: 0.9, hits: reversedHits },
      ]);
    },
    { time: 500, warmupTime: 100 },
  );

  bench(
    "rerank budget planning for 100 documents",
    () => {
      planRerankBatches(documents, budget, estimator);
    },
    { time: 500, warmupTime: 100 },
  );
});
