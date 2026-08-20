# Configuration

The default profile reads `~/.pi/.pi-mentis/config.json`; it does not vary with
the current workspace. An explicit Pi profile reads
`<PI_CODING_AGENT_DIR>/.pi-mentis/config.json`, while `PI_MENTIS_HOME` selects an
intentional isolated absolute root. Omitted fields inherit safe defaults:

Run `/mentis help` inside Pi to display the effective configuration path and detailed memory,
knowledge-base, automatic-recall, Sidecar, and performance guidance. `/kb help` displays the same
help from the knowledge command surface. Provider endpoint and model settings can be edited with
`/mentis config` and are activated without restarting Pi.

SiliconFlow is the only production provider in this release. `/mentis key` stores its credential in
macOS Keychain under service `pi-mentis` and account `provider:siliconflow:default`. The credential
resolver uses secure settings first, then the configured environment variable (default:
`SILICONFLOW_API_KEY`). API keys are never written to this JSON file or stored in Mentis memory.
Platforms without a secure backend keep the environment-variable fallback and do not write a
plaintext secret file.

```json
{
  "inference": {
    "siliconflow": {
      "apiKeyEnv": "SILICONFLOW_API_KEY",
      "embedding": { "model": "Qwen/Qwen3-Embedding-8B", "dimensions": 1024 },
      "rerank": { "model": "Qwen/Qwen3-Reranker-8B", "maxInputTokens": 32768 }
    }
  },
  "memory": {
    "offload": {
      "inlineMaxBytes": 8192,
      "truncateMaxBytes": 65536,
      "previewBytes": 4096
    }
  },
  "retrieval": {
    "automaticRecall": false,
    "automaticRecallTokens": 800,
    "totalAutomaticContextTokens": 1200
  },
  "performance": {
    "sidecar": {
      "cpuNice": 10,
      "knowledgeJobConcurrency": 2,
      "maintenanceDelayMs": 5000
    },
    "queue": { "maxQueuedTaskAgeMs": 1800000 },
    "resources": {
      "maxConcurrentParsers": 2,
      "maxWebPages": 1000,
      "maxWebBytes": 536870912
    }
  },
  "intelligence": {
    "context": { "persistSnapshots": true, "capabilityMaxAgeMs": 60000 },
    "workingMemory": {
      "enabled": true,
      "promptTokens": 900,
      "hardMaxTokens": 1200
    },
    "memoryFormation": {
      "enabled": true,
      "autoPromotion": false,
      "maxInputTokens": 900,
      "maxOutputTokens": 700
    },
    "consolidation": {
      "enabled": true,
      "maxDigestTokens": 1600,
      "procedureMinimumOutcomes": 3,
      "procedureMinimumSuccessEstimate": 0.7
    },
    "temporal": { "enabled": true },
    "views": { "enabled": true, "ttlMs": 300000 },
    "effectiveness": { "enabled": true, "flushIntervalMs": 250, "maxBatch": 64 },
    "adaptivePolicy": { "enabled": true, "cooldownMs": 1800000 }
  },
  "storage": { "rootDir": "/Users/your-name/.pi/.pi-mentis/zvec" }
}
```

`retrieval.automaticRecall` defaults to `false`; `retrieval.automaticRecallTokens` caps capsule
evidence and defaults to `800`. `retrieval.totalAutomaticContextTokens` is the combined envelope
for Working Memory plus Capsule and defaults to `1200`: Working Memory consumes its share first and
Capsule receives only the remainder. When `search_memory` is active for the turn, Pi
Mentis adds a compact system-prompt instruction telling Pi to search when information is unknown,
uncertain, historical, indexed, or missing from current context. The instruction is omitted when
the tool is not selected. This on-demand path keeps normal message submission independent of
retrieval and avoids spending prompt tokens on an unavailable tool.

To opt in to automatic capsule injection:

```json
{
  "retrieval": { "automaticRecall": true }
}
```

Automatic recall does not perform storage or network I/O in `before_agent_start`, but it injects
additional evidence into the model prompt and enables post-turn semantic capsule refresh. That
extra prompt/background work can produce perceptible TUI latency after sending a message. The
extension displays a warning once per process when this option is enabled.

`intelligence.workingMemory` is independent of automatic recall and defaults to enabled. Its
snapshot tracks the current goal, subgoals, confirmed facts, model hypotheses, decisions, open
loops, resources, outcomes, memory IDs, and Artifact IDs. `promptTokens` is the normal injection
budget; `hardMaxTokens` is the absolute reducer/rendering ceiling. Collection limits default to
`maxConfirmed: 24`, `maxHypotheses: 12`, `maxOpenLoops: 16`, `maxRecentOutcomes: 20`, and
`maxActiveResources: 24`; they bound persistent state as well as prompt projection. State is keyed
by the security namespace, Pi Session, and Pi Branch.

`intelligence.memoryFormation.enabled` enables post-turn Candidate analysis. Cheap local triggers
and Secret filtering run before the current Pi model is asked for strict structured output.
`maxInputTokens`, `maxOutputTokens`, `maxCandidatesPerTurn`, and `candidateMaxCharacters` bound the
request and result. Defaults are three candidates per turn, 500 characters per candidate, and a
30-day `candidateTtlMs`. Stable preferences and behavior require two
`minimumPreferenceObservations` and three `minimumBehaviorObservations` independent Evidence
observations. `autoPromotion` defaults to `false`; while false, candidates cannot enter retrieval.
When explicitly enabled, only candidates passing source, scope, evidence, confidence, durability,
and repetition gates are committed through the existing Memory service with lower authority than
an explicit current user instruction.

`intelligence.consolidation` controls TaskEpisode semantic and procedural learning. Digests are
bounded by `maxDigestTokens`; model output is bounded by `maxOutputTokens` and
`maxSemanticCandidates` (defaults: 1,600 input tokens, 1,200 output tokens, five candidates).
`longTaskCheckpointTurns` defaults to 12 turns. Semantic
assertions enter the same Candidate gates. Procedures require at least `procedureMinimumOutcomes`
unique evidence-backed outcomes and a Beta estimate at or above
`procedureMinimumSuccessEstimate`; aborted and unverified tasks do not qualify.

Set the credential in the environment, never the JSON file. Validation enforces Pi
0.84.0 or newer, HTTPS (except localhost tests), 768–4096 dimensions, 8K–32K Rerank context,
bounded queues/resources, and coherent context budgets.

The stable default Zvec root is `~/.pi/.pi-mentis/zvec`. A store created by 0.1.41 at
`~/.pi/agent/.pi-mentis` remains active when it is the only existing store. If both locations
exist, Pi Mentis deterministically selects the stable home root and reports the agent-root store
as inactive; it never copies, merges, deletes, or writes the inactive store implicitly. Use
`PI_MENTIS_HOME` when intentionally inspecting an isolated store.

`performance.queue.maxQueuedTaskAgeMs` applies to background and maintenance work, not
user-requested jobs. The scheduler reserves 20% of queue capacity and one worker lane for
user-requested work when concurrency is greater than one. Critical ingest/migration commands are
already durable before scheduling, so a rejected or interrupted in-memory schedule remains
recoverable on the next startup.

`performance.sidecar.cpuNice` best-effort applies the OS process priority after Sidecar
initialization (`10` is lower priority than Pi on Unix-like systems).
`performance.sidecar.knowledgeJobConcurrency` limits the total number of active knowledge ingest
jobs, while `performance.resources.maxConcurrentParsers` limits file parsing across all of those
jobs rather than separately inside each job. `performance.sidecar.maintenanceDelayMs` keeps
disk/CPU-heavy maintenance out of the immediate post-turn window. Multiple `/kb add`, memory
search, and independent memory commit requests can still execute concurrently, while provider
rate limits, queue capacity, parser capacity, and Zvec coordination remain bounded.

Temporal truth is a protected safety invariant: `intelligence.temporal.enabled` must remain `true`.
Views, effectiveness tracing, and adaptive policy can be disabled independently. Disabling a derived
layer never disables atomic memory, security isolation, evidence integrity, or instruction safety.
Capability refresh and View expiry use stale-while-revalidate, so a failed background refresh keeps
the last valid state readable.

Tool results up to `inlineMaxBytes` remain unchanged. Results through `truncateMaxBytes` return a
preview plus an Artifact reference; larger results return only a structured symbolic result and the
reference. A complete `read` selection is the exception: Mentis gives the model the complete result
once (up to 256 KiB), alongside its Artifact ID; when Pi truncates the result, Mentis reconstructs
the originally requested line range first. Later detail lookup can use `search_memory` with that ID
and focused keywords, rather than repeatedly reading chunks. Inline capture notifications are
batched until the agent settles (or the bounded batch fills). Larger result bodies are transferred
through a private mode-0600 spool file, so Node IPC does not structured-clone a second large string;
the Sidecar consumes and deletes the file. This byte-size policy is structural and does not classify
memory semantics. The original text is stored below the private storage root in all offloaded cases.
