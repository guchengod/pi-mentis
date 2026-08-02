import path from "node:path";
import { performance } from "node:perf_hooks";

import { repositoryRoot, runCommand, writeJson } from "./common.mjs";
import { PiRpcAcceptanceDriver } from "./rpc-driver.mjs";

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] ?? 0;
}

function result(id, name, stage, status, started, details = {}) {
  return { id, name, stage, status, durationMs: performance.now() - started, ...details };
}

export async function runScalePerformance({ directories, runId, maxRecords = 100_000 }) {
  const started = performance.now();
  const rootDir = path.join(directories.state, "scale-zvec");
  const { EvidenceAuthority, createDefaultConfig } = await import(
    path.join(repositoryRoot, "packages", "core", "dist", "index.js")
  );
  const { ZvecStore } = await import(
    path.join(repositoryRoot, "packages", "zvec-storage", "dist", "index.js")
  );
  const dimensions = 1_024;
  const embeddingSpace = {
    providerId: "acceptance",
    modelId: "deterministic-1024",
    dimensions,
    normalization: "none",
    preprocessingVersion: "acceptance-v1",
    inputKindVersion: "acceptance-v1",
  };
  const store = new ZvecStore({
    ...createDefaultConfig(repositoryRoot).storage,
    rootDir,
    readOnly: false,
    writeBatch: { maxOperations: 512, maxBytes: 16 * 1024 * 1024, maxWaitMs: 5 },
  });
  const checkpoints = [1_000, 10_000, 100_000, 1_000_000].filter((value) => value <= maxRecords);
  const measurements = [];
  let inserted = 0;
  let peakRss = process.memoryUsage().rss;
  try {
    await store.start({
      knowledge: embeddingSpace,
      memory: embeddingSpace,
      capability: embeddingSpace,
    });
    for (const checkpoint of checkpoints) {
      const insertStarted = performance.now();
      for (let start = inserted; start < checkpoint; start += 512) {
        const size = Math.min(512, checkpoint - start);
        const records = Array.from({ length: size }, (_, offset) => {
          const index = start + offset;
          const embedding = new Float32Array(dimensions);
          embedding[index % dimensions] = 1;
          return {
            id: `${runId}:scale:memory:${index}`,
            kind: "memory",
            namespace: `local:local:pi:pi-mentis::${runId}`,
            status: "active",
            payload: { id: `${runId}:scale:memory:${index}`, index },
            createdAt: 1,
            updatedAt: 1,
            searchableText: `${runId} scale memory ${index}`,
            contentHash: `${runId}:hash:${index}`,
            sourceId: runId,
            documentId: `${runId}:document:${index}`,
            authority: EvidenceAuthority.VerifiedToolObservation,
            tokenCount: 8,
            revision: 1,
            embedding,
          };
        });
        await store.upsertVectors("memory", records);
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }
      inserted = checkpoint;
      const exact = [];
      for (let sample = 0; sample < 100; sample++) {
        const sampleStarted = performance.now();
        const fetched = await store.fetchVectors("memory", [
          `${runId}:scale:memory:${(sample * 997) % checkpoint}`,
        ]);
        if (fetched.size !== 1) throw new Error(`Exact fetch failed at ${checkpoint}`);
        exact.push(performance.now() - sampleStarted);
      }
      const query = new Float32Array(dimensions);
      query[7] = 1;
      const ann = [];
      for (let sample = 0; sample < 30; sample++) {
        const sampleStarted = performance.now();
        const hits = await store.vectorSearch({ kind: "memory", vector: query, topK: 10 });
        if (hits.length !== 10) throw new Error(`ANN search failed at ${checkpoint}`);
        ann.push(performance.now() - sampleStarted);
      }
      const disk = await runCommand("du", ["-sk", rootDir], { allowFailure: true });
      measurements.push({
        records: checkpoint,
        insertMs: performance.now() - insertStarted,
        exactP95Ms: percentile(exact, 0.95),
        exactP99Ms: percentile(exact, 0.99),
        localSearchP95Ms: percentile(ann, 0.95),
        localSearchP99Ms: percentile(ann, 0.99),
        diskKiB: Number.parseInt(disk.output, 10),
        rssBytes: process.memoryUsage().rss,
      });
    }
  } finally {
    await store.close();
  }
  const report = {
    runId,
    dimensions,
    maxRecords,
    peakRssBytes: peakRss,
    measurements,
    limits: { exactP95Ms: 20, localSearchP95Ms: 100 },
  };
  const evidence = path.join(directories.reports, "evidence", "scale-performance.json");
  await writeJson(evidence, report);
  const passed =
    measurements.length === checkpoints.length &&
    measurements.every(
      (measurement) =>
        measurement.exactP95Ms < report.limits.exactP95Ms &&
        measurement.localSearchP95Ms < report.limits.localSearchP95Ms,
    );
  return result(
    "M02",
    `${maxRecords.toLocaleString("en-US")} real-Zvec memory scale and latency`,
    "Performance",
    passed ? "PASS" : "FAIL",
    started,
    {
      evidence,
      ...(passed ? {} : { error: "Exact or local ANN P95 exceeded the release budget" }),
    },
  );
}

export async function runPiStartupLatencyComparison({
  piHome,
  workspace,
  directories,
  runId,
  environment,
  samples = 10,
}) {
  const started = performance.now();
  const variants = [
    { name: "baseline", noExtensions: true },
    { name: "tencent", noExtensions: false },
    { name: "full-p8-p13", noExtensions: false },
  ];
  const measurements = {};
  for (const variant of variants) {
    if (!variant.noExtensions) {
      await writeJson(path.join(workspace, ".pi-mentis", "config.json"), {
        storage: {
          rootDir: path.join(directories.state, `latency-${variant.name}-zvec`),
          lockTimeoutMs: 10_000,
        },
        intelligence: {
          context: {
            persistSnapshots: variant.name === "full-p8-p13",
            capabilityMaxAgeMs: 60_000,
          },
          temporal: { enabled: true, repairOnStartup: true },
          views: { enabled: variant.name === "full-p8-p13", ttlMs: 300_000 },
          effectiveness: {
            enabled: variant.name === "full-p8-p13",
            flushIntervalMs: 250,
            maxBatch: 64,
          },
          adaptivePolicy: {
            enabled: variant.name === "full-p8-p13",
            cooldownMs: 1_800_000,
          },
        },
      });
    }
    const values = [];
    for (let sample = 0; sample < samples; sample++) {
      const driver = new PiRpcAcceptanceDriver({
        piHome,
        cwd: workspace,
        provider: environment.provider.piDefault,
        model: environment.provider.piModel,
        sessionDir: path.join(directories.state, `latency-${variant.name}-sessions`),
        sessionId: `${runId}_LATENCY_${variant.name}_${sample}`,
        tools: ["commit_memory", "search_memory"],
        noExtensions: variant.noExtensions,
        evidenceFile: path.join(
          directories.reports,
          "evidence",
          `latency-${variant.name}-${sample}.json`,
        ),
        logFile: path.join(directories.logs, `latency-${variant.name}-${sample}.jsonl`),
      });
      const sampleStarted = performance.now();
      await driver.start();
      values.push(performance.now() - sampleStarted);
      await driver.stop();
    }
    measurements[variant.name] = {
      samples: values,
      p50Ms: percentile(values, 0.5),
      p95Ms: percentile(values, 0.95),
      p99Ms: percentile(values, 0.99),
    };
  }
  const baseline = measurements.baseline;
  const tencent = measurements.tencent;
  const full = measurements["full-p8-p13"];
  const report = {
    runId,
    metric: "real Pi RPC process startup through get_state; no model request",
    measurements,
    addedP95Ms: {
      tencentVsBaseline: tencent.p95Ms - baseline.p95Ms,
      fullVsBaseline: full.p95Ms - baseline.p95Ms,
      p8P13VsTencent: full.p95Ms - tencent.p95Ms,
    },
    caveat:
      "The monolithic safety-required Temporal engine cannot be disabled; the tencent variant is a repeated full package startup comparator, not a claim that P8-P13 was bypassed.",
  };
  const evidence = path.join(directories.reports, "evidence", "pi-added-latency.json");
  await writeJson(evidence, report);
  return result(
    "M03",
    "Real Pi baseline vs repeated package startup latency",
    "Performance",
    "PASS",
    started,
    { evidence },
  );
}
