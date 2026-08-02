# Pi Mentis Live E2E Report

- Run ID: `live-e2e-20260801T142540374Z-a4c398`
- Suite: `all`
- Status: **PASS**
- Artifact: `.artifacts/live-e2e/live-e2e-20260801T142540374Z-a4c398`

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
| I1 real Embedding and Rerank                                         | PASS    |         699 |
| D1/G1 multi-dimension Zvec generation migration                      | BLOCKED |           0 |
| K1-K2 real text and Markdown knowledge                               | PASS    |        5417 |
| K3 recursive directory ingestion with source path and symbol         | PASS    |        2883 |
| K4 incremental update and unchanged-document reuse                   | PASS    |        2186 |
| K5 source deletion preserves unrelated knowledge                     | PASS    |        3011 |
| M1-M4 real memory commit, semantic search, reinforcement, correction | PASS    |        7728 |
| M5 project, session, branch, and default contextual scope behavior   | PASS    |        3646 |
| C1-C2/C5 knowledge-first combined retrieval and Pi auto recall       | PASS    |       10508 |
| C3 authoritative knowledge conflicts and retires old memory          | PASS    |       10508 |
| C4 real Rerank changes RRF order before MMR                          | PASS    |       10508 |
| P1 packed Pi v0.83.0 extension surfaces                              | PASS    |        5359 |
| M6/Z4 complete process restart persistence                           | PASS    |        4135 |
| R1 long-context planned multi-batch real Rerank                      | PASS    |         575 |
| F1-F22 real declared parser formats                                  | PASS    |        9801 |
| E1-E3 real credential/model failure and Rerank recovery              | PASS    |       15282 |

D1/G1 is blocked only for the production `BAAI/bge-m3` configuration because that model exposes a fixed 1024 dimensions. The same scenario is completed with real selectable dimensions in the [migration report](./live-migration-e2e-report.md).

## Real remote requests

- Embedding requests: 156
- Embedding inputs: 1708
- Rerank requests: 26
- Rerank documents: 136
- Estimated input units: 259199
- Trace IDs returned: 181
- Retries: 0

## Persistence

- Isolated Zvec root: `.artifacts/live-e2e/live-e2e-20260801T142540374Z-a4c398/zvec`
- Full process restarts: 1
- Restart recall successes: 1

## Performance

- Remote request P50 / P95 / P99: 127.53625000000466 / 449.4771250000001 / 641.896 ms
- Embedding P50: 128.5523749999993 ms
- Rerank P50: 114.1347080000005 ms

The complete sanitized evidence is in `.artifacts/live-e2e/live-e2e-20260801T142540374Z-a4c398/reports/live-e2e.json`.
