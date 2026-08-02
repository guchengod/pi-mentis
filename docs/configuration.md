# Configuration

Create `.pi-mentis/config.json`; omitted fields inherit safe defaults:

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
    "temporal": { "enabled": true, "repairOnStartup": true },
    "views": { "enabled": true, "ttlMs": 300000 },
    "effectiveness": { "enabled": true, "flushIntervalMs": 250, "maxBatch": 64 },
    "adaptivePolicy": { "enabled": true, "cooldownMs": 1800000 }
  },
  "storage": { "rootDir": ".pi-mentis/zvec" }
}
```

Set the credential in the environment, never the JSON file. Validation enforces Pi
0.83.0, HTTPS (except localhost tests), 768–4096 dimensions, 8K–32K Rerank context,
bounded queues/resources, and coherent context budgets.

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
reference. Classification is local and rule-driven. The original text is stored below the private
storage root in all offloaded cases.
