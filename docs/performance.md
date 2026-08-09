# Performance

Foreground paths contain only query embedding, retrieval, optional Rerank, and context
assembly. Ingest, parsing, document embedding, writes, capability sync, capture, and
migration use bounded background scheduling with a binary priority heap, deduplication,
backpressure, cancellation, and a single Zvec writer process lock.

Performance measurement is intentionally not part of the automated test matrix. Use production
telemetry and explicit profiling runs when changing a hot path; do not add benchmark-shaped tests to
the default unit or E2E suites. Measure local CPU, Zvec, and remote latency separately.
