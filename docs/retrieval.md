# Retrieval

Retrieval is knowledge-first. Dense and FTS lists are fused with weighted reciprocal
rank fusion, then authority and freshness are applied. Knowledge hits provide symbols,
paths, packages, and API terms that guide memory search. Optional SiliconFlow Rerank is
planned against an 8K–32K context, split into batches, normalized across batches, and
cached by query plus ordered document hashes. Failure degrades to local rank unless
Rerank is configured as required. MMR reduces redundancy; separate knowledge and memory
token budgets assemble the final context. Automatic recall has 300 ms soft and 800 ms
hard defaults and never blocks a turn after timeout.
