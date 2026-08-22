# SiliconFlow

The provider calls `POST /v1/embeddings`, `POST /v1/rerank`, and the authenticated
`GET /v1/models` catalog with `sub_type=embedding` or `sub_type=reranker`. Its API key is resolved from
macOS Keychain secure settings first and then from the configured environment-variable name.
`/mentis`, `/mentis key`, `/mentis status`, `/mentis config`, and `/mentis test` are local
control-plane commands. Provider selection opens masked key input directly when needed; selecting
a model or submitting a key persists and activates it immediately. The TUI does not expose the
endpoint or a separate Replace/Save flow. Secret input does not become a Pi user message, tool
event, or Mentis capture event. Remote model IDs are intersected with the verified local capability
catalog, with a safe local fallback when the catalog request fails. Float and base64 embeddings are validated
for count, indexes, dimensions, and finite values. Rerank indexes, scores, duplicates,
and trace IDs are validated. HTTP 400/401/403/404/429/503/504 map to structured errors.
Retry uses exponential backoff, full jitter, `Retry-After`, timeout, and `AbortSignal`.
Provider error bodies are discarded so an upstream echo cannot leak a credential into IPC, logs,
or TUI errors.

`PI_MENTIS_LIVE_E2E=1 pnpm test:e2e:live` runs the opt-in real Pi relationship E2E and requires `SILICONFLOW_API_KEY`,
`SILICONFLOW_EMBEDDING_MODEL`, and `SILICONFLOW_RERANKER_MODEL`. Both model identities
are read from the environment, checked against the verified capability catalog, used in
the real requests, and checked again in the responses. There are no fallback live-test
models. Fixtures and normal CI never spend API quota.
