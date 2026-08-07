import { describe, it, expect } from "vitest";
import { loadConfig } from "@pi-mentis/pi-mentis-core";
import { SiliconFlowEmbeddingProvider } from "@pi-mentis/pi-mentis-siliconflow";
import { ZvecStore } from "@pi-mentis/pi-mentis-zvec";
import {
  createMemoryService,
  ScopeSemanticPlanner,
  FileScopePrototypeCache,
  CommitSemanticPlanner,
  FileCommitSemanticCache,
} from "@pi-mentis/pi-mentis-memory-core";
import path from "node:path";

describe("live recall verification", () => {
  it("recalls the two migrated memories via natural query in a fresh context", async () => {
    const config = await loadConfig(process.cwd());
    const store = new ZvecStore({
      rootDir: config.storage.rootDir,
      readOnly: true,
      lockTimeoutMs: 500,
      generationRetentionMs: 60_000,
      writeBatch: { maxOperations: 256, maxBytes: 8 * 1024 * 1024, maxWaitMs: 5 },
    });
    const space = {
      providerId: "siliconflow",
      modelId: config.inference.siliconflow.embedding.model,
      dimensions: config.inference.siliconflow.embedding.dimensions,
      normalization: "none",
      preprocessingVersion: "pi-mentis-text-v1",
      inputKindVersion: "pi-mentis-input-kind-v1",
    };
    await store.start({ knowledge: space, memory: space, capability: space });
    const embedding = new SiliconFlowEmbeddingProvider(config.inference.siliconflow);
    const planner = new ScopeSemanticPlanner({
      embedding,
      dimensions: config.inference.siliconflow.embedding.dimensions,
      cache: new FileScopePrototypeCache(
        path.join(config.storage.rootDir, "scope-semantic-index.json"),
      ),
    });
    const commitPlanner = new CommitSemanticPlanner({
      embedding,
      dimensions: config.inference.siliconflow.embedding.dimensions,
      cache: new FileCommitSemanticCache(
        path.join(config.storage.rootDir, "commit-semantic-index.json"),
      ),
    });
    const memory = createMemoryService({
      store,
      embedding,
      embeddingSpace: space,
      dimensions: config.inference.siliconflow.embedding.dimensions,
      scopePlanner: planner,
      commitPlanner,
    });

    // /new-like fresh context: no task, no topic, only the user boundary.
    const freshContext = {
      tenantId: "local",
      userId: "local",
      appId: "pi",
      agentId: "pi-mentis",
    };

    const queries = [
      {
        label: "默认方案",
        target: "59938b43682652c57c64fb4c4b46931b196d64bfac9a189302e0e0a01798f21d",
        text: "我说默认方案时通常是什么意思？",
      },
      {
        label: "雾松",
        target: "e2c662dfa94ae602f0d136444d7c356c68af23f6e9a699442145e6dd25ecf16e",
        text: "我给临时实验环境取的内部代号是什么？",
      },
    ];

    for (const q of queries) {
      const result = await memory.search(
        {
          text: q.text,
          limit: 10,
          scopeContext: freshContext,
          scopes: [{ kind: "user", id: "local" }],
        },
        { timeoutMs: 15_000 },
      );
      const hit = result.hits.find((h) => h.id === q.target);
      console.log(
        `\n[${q.label}] query="${q.text}"\n  recalled: ${hit !== undefined} ` +
          `degraded=${JSON.stringify(result.diagnostics?.degraded)}`,
      );
      if (hit !== undefined) {
        console.log(`  content: ${hit.text.slice(0, 80)}`);
      }
      expect(hit).toBeDefined();
    }

    await store.close();
  }, 120_000);
});
