import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SemanticQueryPlanner, FilePredicateVectorCache } from "../src/semantic-query-planner.js";
import { DEFAULT_PREDICATE_REGISTRY } from "@pi-mentis/pi-mentis-memory-core";

function mockProvider() {
  let embedCalls = 0;
  return {
    provider: {
      id: "mock",
      models: [{ id: "m", dimensions: 64, maxTokens: 512, supportedInputKinds: ["query", "document"] }],
      async embed(req: { inputs: string[] }) {
        embedCalls++;
        return { vectors: req.inputs.map((_, i) => ({ values: seeded(i) })) };
      },
      async health() { return { status: "healthy" as const, checkedAt: Date.now() }; },
    },
    get calls() { return embedCalls; },
  };
}

function seeded(seed: number): Float32Array {
  const v = new Float32Array(64);
  let s = seed * 2654435761;
  for (let i = 0; i < 64; i++) { s = (s * 1664525 + 1013904223) >>> 0; v[i] = (s / 0xffffffff) * 2 - 1; }
  return v;
}

describe("Semantic cache fingerprint (performance fix)", () => {
  it("second session reuses cache without remote embedding", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cache-test-"));
    const cacheFile = path.join(dir, "predicate-semantic-index.json");

    const m1 = mockProvider();
    const p1 = new SemanticQueryPlanner({
      embedding: m1.provider as never,
      modelId: "m",
      dimensions: 64,
      registry: DEFAULT_PREDICATE_REGISTRY,
      cache: new FilePredicateVectorCache(cacheFile),
    });
    await p1.ready();
    expect(m1.calls).toBeGreaterThan(0);
    const cachedOnDisk = JSON.parse(await readFile(cacheFile, "utf8"));
    expect(cachedOnDisk.textFingerprint).toBeDefined();

    const m2 = mockProvider();
    const p2 = new SemanticQueryPlanner({
      embedding: m2.provider as never,
      modelId: "m",
      dimensions: 64,
      registry: DEFAULT_PREDICATE_REGISTRY,
      cache: new FilePredicateVectorCache(cacheFile),
    });
    const started = performance.now();
    await p2.ready();
    const elapsed = performance.now() - started;
    expect(m2.calls).toBe(0);
    expect(elapsed).toBeLessThan(500);
  });

  it("tampered fingerprint forces rebuild", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cache-test-"));
    const cacheFile = path.join(dir, "predicate-semantic-index.json");

    const m1 = mockProvider();
    const p1 = new SemanticQueryPlanner({
      embedding: m1.provider as never,
      modelId: "m",
      dimensions: 64,
      registry: DEFAULT_PREDICATE_REGISTRY,
      cache: new FilePredicateVectorCache(cacheFile),
    });
    await p1.ready();
    const cachedOnDisk = JSON.parse(await readFile(cacheFile, "utf8"));

    await writeFile(cacheFile, JSON.stringify({ ...cachedOnDisk, textFingerprint: "tampered" }), "utf8");
    const m2 = mockProvider();
    const p2 = new SemanticQueryPlanner({
      embedding: m2.provider as never,
      modelId: "m",
      dimensions: 64,
      registry: DEFAULT_PREDICATE_REGISTRY,
      cache: new FilePredicateVectorCache(cacheFile),
    });
    await p2.ready();
    expect(m2.calls).toBeGreaterThan(0);
  });
});
