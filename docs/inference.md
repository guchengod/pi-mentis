# Inference

`EmbeddingProvider` and `RerankProvider` are provider-neutral. An embedding space is
identified by provider, model, dimensions, normalization, preprocessing version, and
input-kind version. Production dimensions are 768–4096 and must also be supported by
the selected model. Query vectors use bounded LRU+TTL caches; durable document vectors
are reused from Zvec when deterministic chunk IDs are unchanged.

Rerank budgeting reserves protocol, output, and safety tokens before packing documents.
Provider result indexes are always mapped back to local document IDs.
