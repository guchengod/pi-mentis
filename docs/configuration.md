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
  "storage": { "rootDir": ".pi-mentis/zvec" }
}
```

Set the credential in the environment, never the JSON file. Validation enforces Pi
0.83.0, HTTPS (except localhost tests), 768–4096 dimensions, 8K–32K Rerank context,
bounded queues/resources, and coherent context budgets.

Tool results up to `inlineMaxBytes` remain unchanged. Results through `truncateMaxBytes` return a
preview plus an Artifact reference; larger results return only a structured symbolic result and the
reference. Classification is local and rule-driven. The original text is stored below the private
storage root in all offloaded cases.
