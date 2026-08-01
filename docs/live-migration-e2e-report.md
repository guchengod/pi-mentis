# Pi Mentis Live Embedding Migration E2E Report

- Run ID: `live-e2e-20260801T051909069Z-bfcbcf`
- Suite: `migration`
- Status: **PASS**
- Artifact: `.artifacts/live-e2e/live-e2e-20260801T051909069Z-bfcbcf`

## Environment

| Item                        | Value                          |
| --------------------------- | ------------------------------ |
| Node                        | v24.14.1                       |
| Pi                          | 0.83.0 / v0.83.0 / 845d6ff     |
| OS / architecture           | darwin 25.5.0 / arm64          |
| Zvec SDK                    | 0.6.0                          |
| SiliconFlow Base URL        | https://api.siliconflow.cn/v1  |
| Embedding model / dimension | Qwen/Qwen3-Embedding-8B / 768  |
| Rerank model / context      | BAAI/bge-reranker-v2-m3 / 8192 |

No API key, Authorization header, request header, or input body is present in this report.

## Scenarios

| Scenario                                                          | Status | Duration ms |
| ----------------------------------------------------------------- | ------ | ----------: |
| D1/G1 real multi-dimension Zvec generation migration and rollback | PASS   |       10654 |

## Real remote requests

- Embedding requests: 9
- Embedding inputs: 9
- Rerank requests: 0
- Rerank documents: 0
- Estimated input units: 803
- Trace IDs returned: 9
- Retries: 0

## Persistence

- Isolated Zvec root: `.artifacts/live-e2e/live-e2e-20260801T051909069Z-bfcbcf/zvec`
- Full process restarts: 4
- Restart recall successes: 3

## Performance

- Remote request P50 / P95 / P99: 277.33220900000003 / 731.1633750000001 / 731.1633750000001 ms
- Embedding P50: 277.33220900000003 ms
- Rerank P50: n/a ms

The complete sanitized evidence is in `.artifacts/live-e2e/live-e2e-20260801T051909069Z-bfcbcf/reports/live-e2e.json`.
