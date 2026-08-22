# Executive Summary

Pi Mentis now exposes a local provider control plane through `/mentis`. The production registry
contains only SiliconFlow. On macOS, credentials are stored by the native OS Keychain through
`@napi-rs/keyring`; existing `SILICONFLOW_API_KEY` users remain compatible. Settings changes are
persisted separately from secrets and activate through the existing sidecar using reloadable
provider delegates, without rebuilding the cognition or memory architecture.
The TUI now follows Pi's immediate-apply pattern: provider selection leads directly to masked key
input when required, and model choices are saved and hot-reloaded as soon as they are selected.

# Existing SiliconFlow Configuration Before Change

- API key source: `config.inference.siliconflow.apiKeyEnv`, defaulting to
  `SILICONFLOW_API_KEY`.
- Endpoint: `https://api.siliconflow.cn/v1`.
- Embedding: `Qwen/Qwen3-Embedding-8B`, 1024 dimensions.
- Rerank: `Qwen/Qwen3-Reranker-8B`.
- Factory/runtime path: integrated extension starts `MentisSidecarClient`; the sidecar loaded
  `PiMentisConfig` and created `SiliconFlowEmbeddingProvider` and
  `SiliconFlowRerankProvider` once during initialization.
- Config path: `~/.pi/.pi-mentis/config.json`, adjusted by the existing Pi profile and
  `PI_MENTIS_HOME` rules.
- There was no config reload or secret-store abstraction.

# New User Experience

- `/mentis`: opens the provider selector. Selecting SiliconFlow opens masked key input immediately
  when no credential is configured, then exposes model selectors and the connection test.
- `/mentis status`: shows only configured/not configured and the credential source; no secret
  fragment is displayed.
- `/mentis config`: opens the current provider's Embedding and Rerank model selectors. Selecting a
  model persists and activates it immediately; there is no Save action.
- `/mentis key`: directly opens a dedicated masked input component. Submitting a new value replaces
  the stored value and activates it immediately; there is no Replace action.
- `/mentis test`: runs a minimal embedding request and, when enabled, a rerank request.
- `/mentis provider`: opens the provider selector, which currently contains SiliconFlow.

The endpoint remains supported by config and environment compatibility paths but is not displayed
or edited in the TUI. Model candidates are fetched from authenticated SiliconFlow
`GET /v1/models` using `sub_type=embedding` and `sub_type=reranker`, then intersected with the
verified Mentis capability catalog.

The legacy `/mentis help` and `/mentis doctor` aliases remain available for compatibility;
`doctor` now projects provider status.

# Architecture

```text
Pi registerCommand("mentis")
  -> MentisSettingsController
     -> ProviderConfigStore -----------------> config.json (non-secret)
     -> MacOSKeychainSecretStore ------------> macOS Keychain (secret)
     -> MentisSidecarClient (no secret IPC)
        -> provider.status / provider.reload / provider.test / provider.models
           -> CredentialResolver
           -> SiliconFlow provider factory
           -> ReloadableEmbeddingProvider / ReloadableRerankProvider
           -> existing Knowledge / Memory / Retrieval services
```

# Secret Boundary

The password editor is an extension custom UI component. It does not use Pi's ordinary editor,
`ui.input`, readline, a kill ring, an undo stack, session entries, messages, or tools. Its render
method derives the visible state only from the secret length and returns bullets. Esc clears the component's live value
and resolves without a value.

The extension writes the submitted value directly to the Keychain backend. The sidecar is told
only to reload; it independently reads Keychain. Thus the API key is absent from sidecar IPC,
provider status, config JSON, telemetry, capture notifications, task episodes, working memory,
memory candidates, semantic memory, experiences, and artifacts. Provider HTTP error bodies are
discarded before structured errors are created, closing an upstream echo path.

# Credential Precedence

1. Native secure settings (macOS Keychain)
2. Configured environment variable (`SILICONFLOW_API_KEY` by default)
3. Missing

When both secure settings and environment are present, status reports secure settings and notes
that the environment value is overridden. Removing the secure entry naturally activates the
environment fallback.

# SiliconFlow Provider Definition

The production `ProviderRegistry` contains one `MentisProviderDefinition` with id
`siliconflow`, display name `SiliconFlow`, deterministic credential id
`provider:siliconflow:default`, the existing environment name/default endpoint/default models,
and embedding/rerank capabilities.

# Future Provider Extension Path

A second provider requires a provider definition, provider runtime adapter/factory, and a config
mapping. The settings controller and provider selector consume registry metadata. No fake provider
is registered in production; a fake definition test proves that the registry is not limited to a
SiliconFlow id.

# Runtime Reload

Config saves increment `mentisSettings.revision` and use a mode-0600 temporary file followed by an
atomic rename. The sidecar loads and validates the new config, resolves its credential, constructs
replacement provider clients, and only then swaps the delegates held by the existing services.
If preparation fails, the previous delegates remain active and the UI reports that the saved
settings were not activated. Embedding dimension changes are rejected because they require the
existing storage migration workflow.

Model selection also normalizes dependent verified capabilities: fixed-dimension Embedding models
receive their supported dimension, and Rerank context limits are clamped to the selected verified
model. Endpoint values are preserved rather than edited by model selection.

# Failure Handling

- Missing credentials do not prevent sidecar or Pi startup; provider calls are unavailable while
  Pi itself remains usable.
- Keychain write failure keeps the previous credential and never falls back to a plaintext file.
- Authentication, permission, model, timeout, network, and configuration errors use a bounded safe
  projection without response bodies, headers, request bodies, causes, or credentials.
- A stored credential rejected by SiliconFlow remains stored so the user can enter an updated key
  or remove the secure entry to use the environment fallback.
- Model-catalog failures use a bounded safe error and fall back to the local verified list. Remote
  model IDs that are not in the verified capability catalog are not exposed as selectable values.
- Cancel never persists a provider draft or credential draft.

# Tests

- Unit: 27 files, 221 tests passed on the final implementation.
- Real Zvec E2E: 2 files, 14 tests passed.
- Typecheck: 14 workspace packages passed.
- Lint/workspace architecture/version checks passed.
- Build: 14 workspace packages passed.
- All 14 packages built, and all three version 0.1.68 extension tarballs were generated.
- Prettier check and `git diff --check` passed.

# Security Tests

Tests cover credential precedence, environment compatibility, native Keychain adapter isolation,
config serialization without secrets, masked rendering, Cancel, environment fallback, safe error
projection, upstream HTTP response echo, control-plane-only reload IPC, production registry
contents, preservation of an existing reloadable delegate, and persisted-config rollback after a
failed runtime activation. Additional tests cover direct key input, the absence of
Endpoint/Replace/Save actions, immediate model persistence, official `sub_type` catalog requests,
catalog error-body redaction, and verified-model fallback.

A generated nonce search is performed against runtime/generated outputs. Nonces occur only as
intentional declarations in security test source.

# Real Pi Smoke Test

Pi 0.84.2 was launched twice with isolated `PI_CODING_AGENT_DIR`, isolated `PI_MENTIS_HOME`, offline
mode, and the locally built extension.

- Without a credential, `/mentis` displayed `Select Provider`; selecting SiliconFlow immediately
  opened the visible `API Key [ ]` masked input without an intermediate action menu.
- Typing a placeholder displayed bullets only. Esc cancelled without writing Keychain.
- With an isolated invalid environment placeholder, the SiliconFlow menu displayed only API Key,
  Embedding Model, Rerank Model, Test Connection, and Back—no Endpoint, Replace, or Save.
- Selecting Embedding opened the model selector. The expected HTTP 401 was safely projected and the
  verified local fallback appeared.
- Selecting `BAAI/bge-m3` immediately persisted, hot-reloaded, and returned to the menu showing the
  new model without a Save step.

The isolated Pi directories were moved to Trash after the tests. A separate randomly named native
Keychain item passed set/get/delete and was deleted in `finally`. No production credential was
read, replaced, or deleted.

# Files Changed

- `packages/pi-context-extension/src/provider-settings.ts`
- `packages/pi-context-extension/src/secret-input.ts`
- `packages/pi-context-extension/src/mentis-settings-controller.ts`
- `packages/pi-context-extension/src/index.ts`
- `packages/pi-context-extension/src/sidecar-protocol.ts`
- `packages/pi-context-extension/src/sidecar-runtime.ts`
- `packages/pi-extension-support/src/mentis-help.ts`
- `packages/inference/src/model-catalog.ts`
- `packages/inference/src/reloadable-provider.ts`
- `packages/inference/src/index.ts`
- `packages/siliconflow-provider/src/provider.ts`
- `packages/siliconflow-provider/src/http.ts`
- provider/extension tests, package metadata, lockfile, README, and provider/config docs

# Compatibility

Environment-only users keep the prior behavior. Secure settings intentionally override the
environment only after the user stores a credential. Existing endpoint/model environment
fallbacks and config schema remain accepted. Pi starts fail-open when no provider credential is
available.

# Known Limitations

- SiliconFlow remains the only production provider.
- Secure credential storage is enabled only on macOS in this release. Other platforms keep the
  environment-variable fallback and receive no plaintext fallback.
- The remote catalog is restricted to models in Mentis' verified capability catalog; newly listed
  SiliconFlow models require capability metadata before they become selectable.
- Endpoint configuration remains available through JSON/environment compatibility paths but is not
  exposed in the TUI.
- Embedding dimension changes continue to require the established migration workflow.
