# Pi Mentis Live E2E Report

- Run ID: `live-e2e-20260801T045642538Z-476c61`
- Suite: `all`
- Status: **PASS**
- Artifact: `.artifacts/live-e2e/live-e2e-20260801T045642538Z-476c61`

## Environment

| Item                        | Value                          |
| --------------------------- | ------------------------------ |
| Node                        | v24.14.1                       |
| Pi                          | 0.83.0 / v0.83.0 / 845d6ff     |
| OS / architecture           | darwin 25.5.0 / arm64          |
| Zvec SDK                    | 0.6.0                          |
| SiliconFlow Base URL        | https://api.siliconflow.cn/v1  |
| Embedding model / dimension | BAAI/bge-m3 / 1024             |
| Rerank model / context      | BAAI/bge-reranker-v2-m3 / 8192 |

No API key, Authorization header, request header, or input body is present in this report.

## Scenarios

| Scenario                                                             | Status  | Duration ms |
| -------------------------------------------------------------------- | ------- | ----------: |
| I1 real Embedding and Rerank                                         | PASS    |         609 |
| D1/G1 multi-dimension Zvec generation migration                      | BLOCKED |           0 |
| K1-K2 real text and Markdown knowledge                               | PASS    |        4926 |
| K3 recursive directory ingestion with source path and symbol         | PASS    |        2707 |
| K4 incremental update and unchanged-document reuse                   | PASS    |        2033 |
| K5 source deletion preserves unrelated knowledge                     | PASS    |        1602 |
| M1-M4 real memory commit, semantic search, reinforcement, correction | PASS    |        3894 |
| M5 project, session, branch, and default contextual scope behavior   | PASS    |        2174 |
| C1-C2/C5 knowledge-first combined retrieval and Pi auto recall       | PASS    |       23102 |
| C3 authoritative knowledge conflicts and retires old memory          | PASS    |       23102 |
| C4 real Rerank changes RRF order before MMR                          | PASS    |       23102 |
| P1 packed Pi v0.83.0 extension surfaces                              | PASS    |        1719 |
| M6/Z4 complete process restart persistence                           | PASS    |        2066 |
| R1 long-context planned multi-batch real Rerank                      | PASS    |         646 |
| F1-F22 real declared parser formats                                  | PASS    |        8523 |
| E1-E3 real credential/model failure and Rerank recovery              | PASS    |        3483 |

## Real remote requests

- Embedding requests: 134
- Embedding inputs: 1181
- Rerank requests: 23
- Rerank documents: 164
- Estimated input units: 211607
- Trace IDs returned: 156
- Retries: 0

## Persistence

- Isolated Zvec root: `.artifacts/live-e2e/live-e2e-20260801T045642538Z-476c61/zvec`
- Full process restarts: 1
- Restart recall successes: 1

## Performance

- Remote request P50 / P95 / P99: 145.45091599999978 / 615.3909999999996 / 3017.2039160000004 ms
- Embedding P50: 139.71391700000004 ms
- Rerank P50: 169.42191699999967 ms

The complete sanitized evidence is in `.artifacts/live-e2e/live-e2e-20260801T045642538Z-476c61/reports/live-e2e.json`.
