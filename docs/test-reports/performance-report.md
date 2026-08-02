# Performance Report

Date: 2026-08-01

Overall release gate: **FAIL**

## Passing measurements

| Operation                         |      Limit | Measured P95 | Result |
| --------------------------------- | ---------: | -----------: | ------ |
| Hook capture                      |     < 2 ms |    0.0005 ms | PASS   |
| Hook capture P99                  |     < 5 ms |    0.0014 ms | PASS   |
| 100-candidate gate                |     < 5 ms |    0.5030 ms | PASS   |
| Exact memory fetch, 10k real Zvec |    < 20 ms |    0.4625 ms | PASS   |
| Local ANN search, 10k real Zvec   |   < 100 ms |    1.6394 ms | PASS   |
| Real remote request               | < 1,200 ms |  500.9267 ms | PASS   |

The 10k benchmark used real `@zvec/zvec` collections with 768-dimensional vectors. The live
remote measurement used SiliconFlow and Pi 0.83.0 in run
`live-e2e-20260801T122522668Z-7e242a`.

## Missing release proof

- No controlled Pi Baseline vs Pi + P7 vs Pi + P8-P13 comparison for first-token, tool-start,
  tool-result, full-turn, CPU, RSS, or event-loop lag.
- Therefore P8-P13 added latency P95 < 20 ms is not established end to end.
- 100k and 1m memory scales, 100 MB artifacts, and concurrency 4/16/32 are not measured.
- No completed 24-hour or 72-hour soak exists; memory, handle, queue, lease, view-delta, Zvec-size,
  and latency drift are unknown.

Any one of these missing release-candidate measurements blocks publication under the supplied
test specification.

## Evidence

- `.artifacts/test-reports/hook-gates-performance.json`
- `.artifacts/test-reports/zvec-10k-performance.json`
- `.artifacts/live-e2e/live-e2e-20260801T122522668Z-7e242a/reports/live-e2e.json`
