# Retrieval

Retrieval keeps dense search, FTS, and weighted reciprocal rank fusion. The query planner
creates one remote-safe query embedding and reuses it for dense Memory and Knowledge
search. It does not build or warm a semantic prototype index, and `memoryNeed` remains a
conservative retrieval control rather than a content class prediction.

Ownership, tenant and explicit scope, lifecycle state, deterministic runtime constraints,
recall prerequisites, and resource permissions remain hard gates. Provider failure records
a degraded planner and continues with local FTS and the existing deterministic gates.

Knowledge hits can still provide symbols, paths, packages, and API terms that guide FTS
memory search, while the original query vector is reused for dense search. Optional
SiliconFlow Rerank is planned against an 8K–32K context, split into batches, normalized
across batches, and cached by query plus ordered document hashes. Failure degrades to
the fused local rank unless Rerank is configured as required. Adaptive cutoff then uses
the reranked score gap, relative-to-top score, and focused/broad mode before MMR and
separate knowledge and memory token budgets assemble final context. Recall summaries
are built only from those final hits. Automatic recall has 300 ms soft and 800 ms hard
defaults and never blocks a turn after timeout.

Explicit `search_memory` hits also form a turn-local relationship candidate set. This is not a
global cosine conflict search: the set is cleared on the next user input, historical and non-Memory
hits are excluded, and the write path never waits for relationship reasoning. Background
consolidation may compare the newly persisted assertion with up to three current records. Recalled
records have priority; without one, the strongest Core vector candidate can be reviewed pairwise.
Low-confidence or structurally ambiguous pairs remain independent.

An explicit user assertion awaiting pairwise review is also held in a bounded, session-local Recent
Assertion Overlay. A relevant `search_memory` result prefers it as a provisional latest assertion
and annotates concrete older hits as shadowed by pending consolidation. The overlay changes only
the returned projection: persistent statuses and relationship edges remain untouched until the
relationship-specific deterministic gate accepts the model's untrusted proposal.
