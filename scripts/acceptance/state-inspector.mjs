import path from "node:path";

import { repositoryRoot, writeJson } from "./common.mjs";

const scalarKinds = {
  knowledge_sources_v1: ["knowledge-source"],
  knowledge_documents_v1: ["knowledge-document"],
  relationships_v1: ["relationship", "experience-candidate", "capability-fingerprint"],
  jobs_v1: ["knowledge-ingest", "embedding-migration", "view-delta"],
  episodes_v1: ["episode"],
  events_v1: ["event", "retrieval-trace", "retrieval-outcome"],
  artifacts_v1: ["artifact"],
  mentis_state_v1: [
    "memory-idempotency",
    "temporal-head",
    "temporal-saga",
    "adaptive-policy",
    "policy-pointer",
    "policy-control",
    "memory-utility",
    "task-node",
    "context-snapshot",
    "context-latest",
    "topic-identity",
    "task-identity",
    "capability-snapshot",
  ],
  mentis_views_v1: ["view"],
};

function logicalId(payload) {
  if (typeof payload.id === "string") return payload.id;
  if (typeof payload.jobId === "string") return payload.jobId;
  if (typeof payload.traceId === "string") return payload.traceId;
  if (typeof payload._acceptanceStorageId === "string") return payload._acceptanceStorageId;
  return undefined;
}

export async function inspectZvec({ rootDir, outputFile, prefix, requireAcceptanceMemory = true }) {
  const { createDefaultConfig } = await import(
    path.join(repositoryRoot, "packages", "core", "dist", "index.js")
  );
  const { ZvecStore, decodeStoredPayload, readActiveManifest } = await import(
    path.join(repositoryRoot, "packages", "zvec-storage", "dist", "index.js")
  );
  const manifest = await readActiveManifest(rootDir);
  if (manifest === undefined) throw new Error(`No Zvec manifest at ${rootDir}`);
  const activeSpace = (kind) =>
    manifest.generations.find(
      (generation) =>
        generation.kind === kind && generation.generationId === manifest[`${kind}Generation`],
    )?.embeddingSpace;
  const store = new ZvecStore({
    ...createDefaultConfig(repositoryRoot).storage,
    rootDir,
    readOnly: true,
  });
  await store.start({
    knowledge: activeSpace("knowledge"),
    memory: activeSpace("memory"),
    capability: activeSpace("capability"),
  });
  const report = {
    inspectedAt: new Date().toISOString(),
    rootDir,
    prefix,
    manifest,
    collections: {},
    invariants: [],
    errors: [],
  };
  try {
    const allPayloads = [];
    for (const [collection, kinds] of Object.entries(scalarKinds)) {
      const records = [];
      for (const kind of kinds) {
        try {
          const documents = await store.filterScalar(collection, `kind = "${kind}"`, 100_000);
          for (const document of documents) {
            records.push({
              ...decodeStoredPayload(document),
              _acceptanceStorageId: document.id,
              _acceptanceKind: kind,
            });
          }
        } catch (error) {
          if (!/does not exist|not found|No such/iu.test(String(error))) throw error;
        }
      }
      report.collections[collection] = {
        count: records.length,
        statuses: Object.fromEntries(
          Object.entries(
            Object.groupBy(records, (record) => String(record.status ?? "unknown")),
          ).map(([status, values]) => [status, values.length]),
        ),
      };
      allPayloads.push(...records);
    }
    for (const kind of ["knowledge", "memory", "capability"]) {
      const documents = await store.filterVectors(kind, "created_at >= 0", 100_000);
      const payloads = documents.map((document) => ({
        ...decodeStoredPayload(document),
        _acceptanceStorageId: document.id,
        _acceptanceKind: kind,
      }));
      report.collections[`${kind}_active_generation`] = {
        count: payloads.length,
        acceptanceCount: payloads.filter((payload) => JSON.stringify(payload).includes(prefix))
          .length,
      };
      allPayloads.push(...payloads);
    }
    const jobs = allPayloads.filter((payload) =>
      ["knowledge-ingest", "embedding-migration", "view-delta"].includes(
        String(payload.kind ?? payload._acceptanceKind),
      ),
    );
    const permanentlyRunning = jobs.filter(
      (job) => job.state === "running" && job.leaseUntil < Date.now(),
    );
    report.invariants.push({
      name: "no expired permanently-running jobs",
      passed: permanentlyRunning.length === 0,
      offenders: permanentlyRunning.map((job) => job.id),
    });
    const statesById = new Map(
      allPayloads
        .map((payload) => [logicalId(payload), payload])
        .filter(([id]) => typeof id === "string"),
    );
    const heads = allPayloads.filter(
      (payload) => (payload.kind ?? payload._acceptanceKind) === "temporal-head",
    );
    const invalidHeads = heads.filter((head) => {
      const claimId = head.value?.claimId ?? head.value?.currentClaimId;
      return typeof claimId === "string" && !statesById.has(claimId);
    });
    report.invariants.push({
      name: "temporal heads reference existing claims",
      passed: invalidHeads.length === 0,
      offenders: invalidHeads.map((head) => head.id),
    });
    const missingLogicalIds = allPayloads.filter((payload) => logicalId(payload) === undefined);
    report.invariants.push({
      name: "all inspected payloads have kind-appropriate logical ids",
      passed: missingLogicalIds.length === 0,
      offenders: missingLogicalIds.map((payload) => ({
        kind: payload.kind ?? payload._acceptanceKind ?? "unknown",
        keys: Object.keys(payload).sort(),
      })),
    });
    report.invariants.push({
      name: "acceptance memory reached the active generation",
      passed:
        !requireAcceptanceMemory || report.collections.memory_active_generation.acceptanceCount > 0,
      optional: !requireAcceptanceMemory,
    });
    report.status = report.invariants.every((invariant) => invariant.passed) ? "PASS" : "FAIL";
  } catch (error) {
    report.status = "FAIL";
    report.errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    await store.close();
  }
  if (outputFile !== undefined) await writeJson(outputFile, report);
  return report;
}

export async function readCapabilityMatches({ rootDir, prefix }) {
  const { createDefaultConfig } = await import(
    path.join(repositoryRoot, "packages", "core", "dist", "index.js")
  );
  const { ZvecStore, decodeStoredPayload, readActiveManifest } = await import(
    path.join(repositoryRoot, "packages", "zvec-storage", "dist", "index.js")
  );
  const manifest = await readActiveManifest(rootDir);
  if (manifest === undefined) return [];
  const generation = manifest.generations.find(
    (item) => item.kind === "capability" && item.generationId === manifest.capabilityGeneration,
  );
  const store = new ZvecStore({
    ...createDefaultConfig(repositoryRoot).storage,
    rootDir,
    readOnly: true,
  });
  await store.start({
    knowledge: manifest.generations.find(
      (item) => item.kind === "knowledge" && item.generationId === manifest.knowledgeGeneration,
    )?.embeddingSpace,
    memory: manifest.generations.find(
      (item) => item.kind === "memory" && item.generationId === manifest.memoryGeneration,
    )?.embeddingSpace,
    capability: generation?.embeddingSpace,
  });
  try {
    const documents = await store.filterVectors("capability", "created_at >= 0", 100_000);
    return documents
      .map(decodeStoredPayload)
      .filter((payload) => JSON.stringify(payload).includes(prefix));
  } finally {
    await store.close();
  }
}
