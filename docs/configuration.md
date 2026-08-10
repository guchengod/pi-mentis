# Configuration

The default profile reads `~/.pi/.pi-mentis/config.json`; it does not vary with
the current workspace. An explicit Pi profile reads
`<PI_CODING_AGENT_DIR>/.pi-mentis/config.json`, while `PI_MENTIS_HOME` selects an
intentional isolated absolute root. Omitted fields inherit safe defaults:

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
  "performance": {
    "queue": { "maxQueuedTaskAgeMs": 1800000 },
    "resources": { "maxWebPages": 1000, "maxWebBytes": 536870912 }
  },
  "intelligence": {
    "context": { "persistSnapshots": true, "capabilityMaxAgeMs": 60000 },
    "temporal": { "enabled": true },
    "views": { "enabled": true, "ttlMs": 300000 },
    "effectiveness": { "enabled": true, "flushIntervalMs": 250, "maxBatch": 64 },
    "adaptivePolicy": { "enabled": true, "cooldownMs": 1800000 }
  },
  "storage": { "rootDir": "/Users/your-name/.pi/.pi-mentis/zvec" }
}
```

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

Temporal truth is a protected safety invariant: `intelligence.temporal.enabled` must remain `true`.
Views, effectiveness tracing, and adaptive policy can be disabled independently. Disabling a derived
layer never disables atomic memory, security isolation, evidence integrity, or instruction safety.
Capability refresh and View expiry use stale-while-revalidate, so a failed background refresh keeps
the last valid state readable.

Tool results up to `inlineMaxBytes` remain unchanged. Results through `truncateMaxBytes` return a
preview plus an Artifact reference; larger results return only a structured symbolic result and the
reference. This byte-size policy is structural and does not classify memory semantics. The original text is stored below the private
storage root in all offloaded cases.
