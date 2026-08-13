# Performance

Foreground paths contain only query embedding, retrieval, optional Rerank, and context
assembly. Ingest, parsing, document embedding, writes, capability sync, capture, and
migration use bounded background scheduling with a binary priority heap, deduplication,
backpressure, cancellation, and a single Zvec writer process lock.

Pi automatic recall is a stricter foreground lane: it never performs remote embedding or
Rerank, searches memory only through cached vectors, local FTS, and materialized views, and has
a 50 ms hard wall-clock budget (25 ms soft budget). Explicit `search_memory` requests retain the
full semantic retrieval path. Episode capture starts only after the automatic-recall lane yields;
context refresh and snapshot persistence wait until the agent settles, so storage writes cannot
delay message submission or compete with response streaming.

Performance measurement is intentionally not part of the automated test matrix. Use production
telemetry and explicit profiling runs when changing a hot path; do not add benchmark-shaped tests to
the default unit or E2E suites. Measure local CPU, Zvec, and remote latency separately.
