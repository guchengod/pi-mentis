# Functional Coverage Report

Date: 2026-08-01

Overall release gate: **FAIL**

## Verified

- Formatting, ESLint, architecture rules, and TypeScript type checking passed.
- All 14 workspace packages built successfully.
- Unit tests: 84/84 passed across 13 files.
- Real-Zvec integration tests: 16/16 passed across 3 files.
- Performance tests: 3/3 passed across 2 files.
- Mutation testing: 793 mutants, 80.96% overall score and 82.20% score on covered code.
- Live Pi 0.83.0 / SiliconFlow / Zvec E2E passed in run
  `live-e2e-20260801T122522668Z-7e242a` with 150 Embedding requests and 26 Rerank requests.
- The live run covered knowledge create/search/update/delete, memory create/reinforce/correct,
  contextual isolation, combined retrieval, authoritative conflict handling, packed Pi extension
  loading, complete process restart, long-context Rerank, all 22 declared input formats, and
  provider failure/recovery.
- The real ordered-book crawl passed separately in run
  `live-e2e-20260801T121559622Z-291082`: 35 ordered menu pages, 35 documents, 1,161 chunks,
  middle-chapter and final-chapter retrieval.
- Real dimension migration and rollback passed separately in run
  `live-e2e-20260801T051909069Z-bfcbcf` using Qwen/Qwen3-Embedding-8B, including four full
  process restarts.

## Failed release requirements

| Requirement                     | Required |               Actual | Result |
| ------------------------------- | -------: | -------------------: | ------ |
| Core module branch coverage     |   >= 95% |               64.10% | FAIL   |
| Ordinary module branch coverage |   >= 85% |       49.32% overall | FAIL   |
| Core state transition coverage  |     100% |     Not demonstrated | FAIL   |
| Twenty golden E2E scenarios     |    20/20 | Partial mapping only | FAIL   |

The current suite proves the implemented happy path and several critical failure paths, but it
does not yet prove every parser's empty/corrupt/oversized/update/delete/restart matrix, every Pi
load/unload/capability transition, or all twenty named golden scenarios.

## Evidence

- `coverage/coverage-summary.json`
- `.artifacts/test-reports/mutation.json`
- `.artifacts/live-e2e/live-e2e-20260801T122522668Z-7e242a/reports/live-e2e.json`
- `.artifacts/live-e2e/live-e2e-20260801T121559622Z-291082/reports/live-e2e.json`
- [Live E2E report](../live-e2e-report.md)
- [Migration E2E report](../live-migration-e2e-report.md)
