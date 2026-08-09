import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const productionCore = [
  "../src/remember-coordinator.ts",
  "../src/service.ts",
  "../src/relationship-resolver.ts",
  "../src/relationship-evidence.ts",
  "../../pi-extension-support/src/pairwise-memory-reasoner.ts",
  "../src/temporal.ts",
  "../src/experience.ts",
  "../src/learning.ts",
  "../src/scope-semantics.ts",
  "../../retrieval/src/semantic-query-planner.ts",
  "../../retrieval/src/service.ts",
];

describe("classless production audit", () => {
  it("contains no V1 classification runtime or prototype cache", async () => {
    const source = (
      await Promise.all(
        productionCore.map((file) => readFile(new URL(file, import.meta.url), "utf8")),
      )
    ).join("\n");
    for (const forbidden of [
      "PredicateRegistry",
      "CommitSemanticPlanner",
      "predicate-semantic-index",
      "commit-semantic-index",
      "semanticKey",
      "setMemberKey",
      "memberFactKey",
      "branchClaimState",
      "anchors",
      "negativeBoundary",
      "hasPhrase",
      "explicitOperation",
      "hasPairwiseOpposition",
      "改成|更改为|换成",
      "不再|不算|撤回",
      "cardinality classifier",
      "memory-type classifier",
    ])
      expect(source).not.toContain(forbidden);
  });
});
