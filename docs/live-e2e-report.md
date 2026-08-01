# Pi Mentis Live E2E Report

- Run ID: `live-e2e-20260729T161541826Z-53d34d`
- Suite: `all`
- Status: **PASS**
- Artifact: `.artifacts/live-e2e/live-e2e-20260729T161541826Z-53d34d`

## Environment

| Item                        | Value                          |
| --------------------------- | ------------------------------ |
| Node                        | v24.14.1                       |
| Pi                          | 0.82.1 / v0.82.1 / b4f2936     |
| OS / architecture           | darwin 25.5.0 / arm64          |
| Zvec SDK                    | 0.6.0                          |
| SiliconFlow Base URL        | https://api.siliconflow.cn/v1  |
| Embedding model / dimension | BAAI/bge-m3 / 1024             |
| Rerank model / context      | BAAI/bge-reranker-v2-m3 / 8192 |

No API key, Authorization header, request header, or input body is present in this report.

## Scenarios

| Scenario                                                             | Status  | Duration ms |
| -------------------------------------------------------------------- | ------- | ----------: |
| I1 real Embedding and Rerank                                         | PASS    |         656 |
| D1/G1 multi-dimension Zvec generation migration                      | BLOCKED |           0 |
| K1-K2 real text and Markdown knowledge                               | PASS    |        4591 |
| K3 recursive directory ingestion with source path and symbol         | PASS    |        4466 |
| K4 incremental update and unchanged-document reuse                   | PASS    |        2323 |
| K5 source deletion preserves unrelated knowledge                     | PASS    |        1635 |
| M1-M4 real memory commit, semantic search, reinforcement, correction | PASS    |        3670 |
| M5 project, session, branch, and global scope behavior               | PASS    |        2271 |
| C1-C2/C5 knowledge-first combined retrieval and Pi auto recall       | PASS    |       15984 |
| C3 authoritative knowledge conflicts and retires old memory          | PASS    |       15984 |
| C4 real Rerank changes RRF order before MMR                          | PASS    |       15984 |
| P1 packed Pi v0.82.1 extension surfaces                              | PASS    |        1774 |
| M6/Z4 complete process restart persistence                           | PASS    |        2115 |
| R1 long-context planned multi-batch real Rerank                      | PASS    |         591 |
| F1-F22 real declared parser formats                                  | PASS    |        8373 |
| E1-E3 real credential/model failure and Rerank recovery              | PASS    |        3093 |

## Real remote requests

- Embedding requests: 134
- Embedding inputs: 1171
- Rerank requests: 24
- Rerank documents: 170
- Estimated input units: 211225
- Trace IDs returned: 157
- Retries: 0

## Persistence

- Isolated Zvec root: `.artifacts/live-e2e/live-e2e-20260729T161541826Z-53d34d/zvec`
- Full process restarts: 1
- Restart recall successes: 1

## Performance

- Remote request P50 / P95 / P99: 128.32854199999974 / 529.6097499999996 / 1045.6388750000006 ms
- Embedding P50: 127.31579200000033 ms
- Rerank P50: 145.4665 ms

The complete sanitized evidence is in `.artifacts/live-e2e/live-e2e-20260729T161541826Z-53d34d/reports/live-e2e.json`.
