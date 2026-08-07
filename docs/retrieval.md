# Retrieval

Retrieval keeps dense search, FTS, and weighted reciprocal rank fusion. A semantic query
planner reuses the same remote-safe query embedding used by dense Memory and Knowledge
search. It compares that vector in memory with the registered Predicate descriptions,
producing predicate and subject candidates, temporal intent, focused/broad mode, and a
`memoryNeed` decision. The 37 Predicate vectors are generated in startup batches and
persisted under the storage root; they are regenerated only when the Registry schema,
provider, model, or dimensions change.

Predicate routing is a soft ranking prior. It never rejects a Memory because a semantic
predicate appears incompatible. Ownership, tenant and explicit scope, tombstone and
retraction state, deterministic temporal constraints, and resource permissions remain
hard gates. Provider or Predicate-index failure records a degraded planner and continues
with local FTS and the existing deterministic gates.

Knowledge hits can still provide symbols, paths, packages, and API terms that guide FTS
memory search, while the original query vector is reused for dense search. Optional
SiliconFlow Rerank is planned against an 8K–32K context, split into batches, normalized
across batches, and cached by query plus ordered document hashes. Failure degrades to
the fused local rank unless Rerank is configured as required. Adaptive cutoff then uses
the reranked score gap, relative-to-top score, and focused/broad mode before MMR and
separate knowledge and memory token budgets assemble final context. Recall summaries
are built only from those final hits. Automatic recall has 300 ms soft and 800 ms hard
defaults and never blocks a turn after timeout.
