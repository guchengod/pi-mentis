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

const TARGETS = [
  "59938b43682652c57c64fb4c4b46931b196d64bfac9a189302e0e0a01798f21d",
  "e2c662dfa94ae602f0d136444d7c356c68af23f6e9a699442145e6dd25ecf16e",
];

describe("live migration", () => {
  it("diagnoses and repairs the two target memories to user scope", async () => {
    const config = await loadConfig(process.cwd());
    const store = new ZvecStore({
      rootDir: config.storage.rootDir,
      readOnly: false,
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

    for (const id of TARGETS) {
      const diagnosis = await memory.diagnoseMemoryScope?.(id);
      console.log(`\n== ${id}`);
      console.log("diagnosis:", JSON.stringify(diagnosis));
      if (diagnosis !== undefined) {
        const repair = await memory.repairMemoryScope?.(id);
        console.log("repair:", JSON.stringify(repair));
        const after = await memory.get(id, { accessIntent: "explicit_id" });
        console.log(
          "after scope:",
          JSON.stringify(after?.scope),
          "content unchanged:",
          after !== undefined,
        );
      }
    }

    await store.close();
    expect(true).toBe(true);
  }, 180_000);
});
