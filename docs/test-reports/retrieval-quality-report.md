# Retrieval Quality Report

Date: 2026-08-01

Overall release gate: **FAIL**

## Verified behavior

- Cross-tenant/user/app/agent candidates are hard rejected before ranking.
- Project and repository mismatches are rejected for scoped facts.
- Package-manager, runtime, version, OS, architecture, premise, trust, branch, temporal, and
  evidence gates are covered by deterministic and property-based tests.
- Live combined retrieval verified Knowledge -> Memory -> RRF -> gates -> authority/freshness ->
  Rerank -> MMR -> context budget.
- Live Rerank changed the pre-MMR order and stayed below the 1,200 ms remote-search P95 target.
- Superseded facts remained available in historical mode while current mode selected the current
  fact.
- The real Pi book crawl retrieved both a middle chapter and the final boundary chapter.

## Required metrics not yet established

| Metric              | Required | Actual                                                      | Result |
| ------------------- | -------: | ----------------------------------------------------------- | ------ |
| Required Recall@10  |   >= 95% | No versioned PiMentisEval dataset result                    | FAIL   |
| Forbidden Exposure  |        0 | Zero in covered invariant cases, no complete benchmark rate | FAIL   |
| Project Mismatch    |  <= 0.5% | Zero in covered invariant cases, no complete benchmark rate | FAIL   |
| Superseded Exposure |    <= 1% | Covered scenarios pass, no complete benchmark rate          | FAIL   |
| Evidence Coverage   |   >= 95% | Covered scenarios pass, no complete benchmark rate          | FAIL   |

The adaptive policy replay API computes recall, forbidden exposure, and evidence coverage, but
the repository does not yet contain the required labeled Code/General/Adversarial evaluation
corpus and a release artifact with aggregate Precision@K, nDCG, and the metrics above.

## Evidence

- `packages/retrieval/test/gates-policy.property.test.ts`
- `integration-tests/intelligence-state.integration.test.ts`
- `.artifacts/live-e2e/live-e2e-20260801T122522668Z-7e242a/reports/live-e2e.json`
- `.artifacts/live-e2e/live-e2e-20260801T121559622Z-291082/reports/live-e2e.json`
