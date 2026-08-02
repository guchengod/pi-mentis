import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { EvidenceAuthority, type SearchHit } from "@pi-mentis/pi-mentis-core";
import {
  TurnCaptureBuffer,
  type MemoryRecord,
  type PiScopeContext,
} from "@pi-mentis/pi-mentis-memory-core";
import { gateSearchHit } from "@pi-mentis/pi-mentis-retrieval";
import { ZvecStore, type StoredVectorRecord } from "@pi-mentis/pi-mentis-zvec";

function percentile(values: readonly number[], value: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))] ?? 0;
}

const scope: PiScopeContext = {
  tenantId: "tenant",
  userId: "user",
  appId: "pi",
  agentId: "mentis",
  projectId: "project:benchmark",
  repositoryId: "repo:benchmark",
};

function memoryHit(index: number): SearchHit {
  const metadata: Omit<MemoryRecord, "embedding"> = {
    id: `memory:${index}`,
    content: `Use pnpm for benchmark project ${index}`,
    normalizedContent: `use pnpm for benchmark project ${index}`,
    contentHash: `hash-${index}`,
    type: "procedural",
    domain: "procedure",
    scope: { kind: "project", id: "project:benchmark" },
    scopeContext: scope,
    confidence: 0.9,
    importance: 0.8,
    authority: EvidenceAuthority.VerifiedToolObservation,
    evidenceRefs: [{ kind: "event", id: `event:${index}`, observedAt: 1 }],
    supersedesIds: [],
    conflictsWithIds: [],
    status: "active",
    embeddingSpaceId: "benchmark-768",
    createdAt: 1,
    updatedAt: 1,
    observedAt: 1,
    lastAccessedAt: 1,
    reinforceCount: 0,
    revision: 1,
    contentOrigin: "tool",
  };
  return {
    id: metadata.id,
    kind: "memory",
    text: metadata.content,
    score: 1,
    tokenCount: 8,
    authority: metadata.authority,
    namespace: "tenant:user:pi:mentis::project:project:benchmark",
    contentHash: metadata.contentHash,
    metadata,
  };
}

describe("release performance gates", () => {
  it("measures hook capture and 100-candidate applicability gates", async () => {
    const hook = new TurnCaptureBuffer();
    hook.startTurn(1);
    const hookSamples: number[] = [];
    for (let index = 0; index < 10_000; index++) {
      const started = performance.now();
      hook.capture({
        toolCallId: `tool-${index}`,
        toolName: "read",
        status: "completed",
        timestamp: index,
        filePaths: ["package.json"],
      });
      hookSamples.push(performance.now() - started);
    }
    const candidates = Array.from({ length: 100 }, (_, index) => memoryHit(index));
    const gateSamples: number[] = [];
    for (let round = 0; round < 500; round++) {
      const started = performance.now();
      for (const candidate of candidates) {
        expect(gateSearchHit(candidate, { scope }).allowed).toBe(true);
      }
      gateSamples.push(performance.now() - started);
    }
    const report = {
      generatedAt: new Date().toISOString(),
      hookCapture: {
        samples: hookSamples.length,
        p95Ms: percentile(hookSamples, 0.95),
        p99Ms: percentile(hookSamples, 0.99),
        limits: { p95Ms: 2, p99Ms: 5 },
      },
      candidateGate100: {
        samples: gateSamples.length,
        p95Ms: percentile(gateSamples, 0.95),
        limitP95Ms: 5,
      },
    };
    await mkdir(path.resolve(".artifacts/test-reports"), { recursive: true });
    await writeFile(
      path.resolve(".artifacts/test-reports/hook-gates-performance.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    expect(report.hookCapture.p95Ms).toBeLessThan(2);
    expect(report.hookCapture.p99Ms).toBeLessThan(5);
    expect(report.candidateGate100.p95Ms).toBeLessThan(5);
  });

  it("measures exact and ANN search against 10k real Zvec memories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-mentis-benchmark-"));
    const dimensions = 768;
    const store = new ZvecStore({
      rootDir: root,
      readOnly: false,
      lockTimeoutMs: 2_000,
      generationRetentionMs: 60_000,
      writeBatch: { maxOperations: 512, maxBytes: 16 * 1024 * 1024, maxWaitMs: 5 },
    });
    const embeddingSpace = {
      providerId: "benchmark",
      modelId: "deterministic-768",
      dimensions,
      normalization: "none" as const,
      preprocessingVersion: "benchmark-v1",
      inputKindVersion: "benchmark-v1",
    };
    try {
      await store.start({
        knowledge: embeddingSpace,
        memory: embeddingSpace,
        capability: embeddingSpace,
      });
      for (let start = 0; start < 10_000; start += 500) {
        const records: StoredVectorRecord[] = Array.from({ length: 500 }, (_, offset) => {
          const index = start + offset;
          const embedding = new Float32Array(dimensions);
          embedding[index % dimensions] = 1;
          return {
            id: `benchmark:memory:${index}`,
            kind: "memory",
            namespace: "tenant:user:pi:mentis::project:project:benchmark",
            status: "active",
            payload: { id: `benchmark:memory:${index}`, index },
            createdAt: 1,
            updatedAt: 1,
            searchableText: `benchmark memory ${index}`,
            contentHash: `hash-${index}`,
            sourceId: "benchmark",
            documentId: `document-${index}`,
            authority: EvidenceAuthority.VerifiedToolObservation,
            tokenCount: 4,
            revision: 1,
            embedding,
          };
        });
        await store.upsertVectors("memory", records);
      }
      const exactSamples: number[] = [];
      for (let index = 0; index < 200; index++) {
        const started = performance.now();
        const result = await store.fetchVectors("memory", [`benchmark:memory:${index * 47}`]);
        expect(result.size).toBe(1);
        exactSamples.push(performance.now() - started);
      }
      const query = new Float32Array(dimensions);
      query[7] = 1;
      const searchSamples: number[] = [];
      for (let index = 0; index < 50; index++) {
        const started = performance.now();
        const result = await store.vectorSearch({ kind: "memory", vector: query, topK: 10 });
        expect(result).toHaveLength(10);
        searchSamples.push(performance.now() - started);
      }
      const report = {
        generatedAt: new Date().toISOString(),
        realZvecMemoryCount: 10_000,
        exactFetch: { p95Ms: percentile(exactSamples, 0.95), limitP95Ms: 20 },
        localAnnSearch: { p95Ms: percentile(searchSamples, 0.95), limitP95Ms: 100 },
      };
      await mkdir(path.resolve(".artifacts/test-reports"), { recursive: true });
      await writeFile(
        path.resolve(".artifacts/test-reports/zvec-10k-performance.json"),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      expect(report.exactFetch.p95Ms).toBeLessThan(20);
      expect(report.localAnnSearch.p95Ms).toBeLessThan(100);
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
