# Performance

Foreground paths contain only query embedding, retrieval, optional Rerank, and context
assembly. Ingest, parsing, document embedding, writes, capability sync, capture, and
migration use bounded background scheduling with a binary priority heap, deduplication,
backpressure, cancellation, and a single Zvec writer process lock.

Run `pnpm benchmark:smoke` for the assertion-based smoke profile and `pnpm benchmark`
for repeat-sampled hot-path measurements. The generated `benchmark-results/smoke.json`
separates local algorithm time, Zvec, SiliconFlow, and network measurements, while
`benchmark-results/full.json` records reciprocal-rank fusion over two 10K result sets
and Rerank budget planning for 100 documents. Larger profiles should add 100K/1M Zvec
datasets, concurrent indexing/search, cache-hit ratios, RSS, and remote latency without
combining network wait with local CPU time.
