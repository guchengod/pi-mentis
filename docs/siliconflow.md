# SiliconFlow

The provider calls `POST /v1/embeddings` and `POST /v1/rerank` with an API key read only
from the configured environment-variable name. Float and base64 embeddings are validated
for count, indexes, dimensions, and finite values. Rerank indexes, scores, duplicates,
and trace IDs are validated. HTTP 400/401/403/404/429/503/504 map to structured errors.
Retry uses exponential backoff, full jitter, `Retry-After`, timeout, and `AbortSignal`.

`PI_MENTIS_LIVE_E2E=1 pnpm test:e2e:live` runs the opt-in real Pi relationship E2E and requires `SILICONFLOW_API_KEY`,
`SILICONFLOW_EMBEDDING_MODEL`, and `SILICONFLOW_RERANKER_MODEL`. Both model identities
are read from the environment, checked against the verified capability catalog, used in
the real requests, and checked again in the responses. There are no fallback live-test
models. Fixtures and normal CI never spend API quota.
