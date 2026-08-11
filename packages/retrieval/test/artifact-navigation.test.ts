import { describe, expect, it, vi } from "vitest";
import type {
  ArtifactReadOptions,
  ArtifactRecord,
  PiEvidenceStore,
  PiScopeContext,
} from "@pi-mentis/pi-mentis-memory-core";

import { DefaultArtifactQueryService } from "../src/artifact-query.js";
import { DefaultRecallCoordinator } from "../src/recall-coordinator.js";

const scopeContext: PiScopeContext = {
  tenantId: "local",
  userId: "local",
  appId: "pi",
  agentId: "pi-mentis",
};

function fixture(
  contentParts: readonly string[],
  artifactId = "a".repeat(64),
): {
  artifact: ArtifactRecord;
  evidence: PiEvidenceStore;
  readArtifactRange: ReturnType<typeof vi.fn>;
} {
  const buffers = contentParts.map((part) => Buffer.from(part, "utf8"));
  const content = Buffer.concat(buffers);
  let offset = 0;
  const chunks = buffers.map((buffer, ordinal) => {
    const chunk = {
      ordinal,
      relativePath: `artifacts/${artifactId}/${ordinal}.txt`,
      byteOffset: offset,
      byteLength: buffer.byteLength,
      contentHash: `${ordinal}`.padStart(64, "0"),
    };
    offset += buffer.byteLength;
    return chunk;
  });
  const artifact: ArtifactRecord = {
    id: artifactId,
    episodeId: "episode",
    securityNamespace: "local:local:pi:pi-mentis",
    mediaType: "text/plain",
    byteLength: content.byteLength,
    contentHash: "f".repeat(64),
    relativePath: `artifacts/${artifactId}`,
    state: "ready",
    chunks,
    createdAt: 1,
    updatedAt: 1,
  };
  const readArtifactRange = vi.fn(async (_id: string, options: ArtifactReadOptions = {}) => {
    const requestedOffset = options.offset ?? 0;
    const requestedLength = options.length ?? content.byteLength - requestedOffset;
    const end = Math.min(content.byteLength, requestedOffset + requestedLength);
    return {
      content: content.subarray(requestedOffset, end).toString("utf8"),
      offset: requestedOffset,
      nextOffset: end,
      byteLength: end - requestedOffset,
      eof: end >= content.byteLength,
    };
  });
  const evidence = {
    async getArtifact(id: string) {
      return id === artifactId ? artifact : undefined;
    },
    async getEvent() {
      return undefined;
    },
    async readArtifact(id: string) {
      return id === artifactId ? content.toString("utf8") : undefined;
    },
    readArtifactRange,
  } as unknown as PiEvidenceStore;
  return { artifact, evidence, readArtifactRange };
}

describe("artifact navigation invariants", () => {
  it("distinguishes exact artifact existence from content matching", async () => {
    const id = "b".repeat(64);
    const { evidence } = fixture(["small artifact"], id);
    const coordinator = new DefaultRecallCoordinator({
      getMemory: () => undefined,
      getRetrieval: () => undefined,
      getEvidence: () => evidence,
    });

    const result = await coordinator.recall({ id }, { scopeContext });

    expect(result).toMatchObject({
      found: true,
      entityFound: true,
      contentFound: false,
      lookupMode: "exact_id",
      artifactId: id,
      resourceType: "artifact",
      anchored: true,
      hits: [],
    });
    expect(JSON.parse(result.summary ?? "{}")).toMatchObject({ id, chunkCount: 1 });
  });

  it("projects anchored chunk coordinates through the public recall contract", async () => {
    const id = "9".repeat(64);
    const { evidence } = fixture(["header\nPUBLIC_CHUNK_DETAIL = recovered\nfooter"], id);
    const coordinator = new DefaultRecallCoordinator({
      getMemory: () => undefined,
      getRetrieval: () => undefined,
      getEvidence: () => evidence,
    });

    const result = await coordinator.recall({ id, query: "PUBLIC_CHUNK_DETAIL" }, { scopeContext });

    expect(result).toMatchObject({
      found: true,
      entityFound: true,
      contentFound: true,
      lookupMode: "anchored_query",
      artifactId: id,
      hits: [
        {
          id,
          artifactChunkIndex: 0,
          byteStart: 0,
          content: expect.stringContaining("PUBLIC_CHUNK_DETAIL = recovered"),
        },
      ],
    });
    expect(result.hits[0]?.byteEnd).toBeGreaterThan(0);
  });

  it("fails closed for an unknown exact ID without invoking global retrieval", async () => {
    const { evidence } = fixture(["small artifact"]);
    const retrieval = { search: vi.fn() };
    const coordinator = new DefaultRecallCoordinator({
      getMemory: () => undefined,
      getRetrieval: () => retrieval as never,
      getEvidence: () => evidence,
    });

    const result = await coordinator.recall({ id: "e".repeat(64) }, { scopeContext });

    expect(result).toMatchObject({
      found: false,
      entityFound: false,
      contentFound: false,
      lookupMode: "exact_id",
      anchored: true,
      reason: "not_found",
    });
    expect(retrieval.search).not.toHaveBeenCalled();
  });

  it("finds a distinctive detail in the final chunk despite common early matches", async () => {
    const common = "RUN_COMMON navigation line\n".repeat(42_000);
    const tailMarker = "DETAIL_TAIL_7f3a = final recovery value";
    const { evidence, artifact, readArtifactRange } = fixture([
      common,
      common,
      `${common}${tailMarker}\n`,
    ]);
    expect(artifact.byteLength).toBeGreaterThan(1_048_576);
    const service = new DefaultArtifactQueryService({ getEvidence: () => evidence });

    const result = await service.query(artifact.id, "请定位 DETAIL_TAIL_7f3a 的最终恢复值", {
      scopeContext,
    });

    expect(result.found).toBe(true);
    expect(result.entityFound).toBe(true);
    expect(result.hits[0]).toMatchObject({ artifactId: artifact.id, chunkIndex: 2 });
    expect(result.hits[0]?.content).toContain(tailMarker);
    expect(result.diagnostics).toMatchObject({
      artifactBytes: artifact.byteLength,
      chunksScanned: 3,
      bytesRead: artifact.byteLength,
    });
    expect(result.diagnostics.returnedBytes).toBeLessThan(10_000);
    expect(readArtifactRange).toHaveBeenCalledTimes(3);
  });

  it("keeps anchored results inside the requested artifact", async () => {
    const firstId = "1".repeat(64);
    const secondId = "2".repeat(64);
    const first = fixture(["FIRST_ONLY_SCOPE"], firstId);
    const second = fixture(["SECOND_ONLY_SCOPE"], secondId);
    const evidence = {
      async getArtifact(id: string) {
        if (id === firstId) return first.artifact;
        if (id === secondId) return second.artifact;
        return undefined;
      },
      async readArtifact(id: string) {
        if (id === firstId) return "FIRST_ONLY_SCOPE";
        if (id === secondId) return "SECOND_ONLY_SCOPE";
        return undefined;
      },
    } as unknown as PiEvidenceStore;
    const service = new DefaultArtifactQueryService({ getEvidence: () => evidence });

    const result = await service.query(firstId, "SECOND_ONLY_SCOPE", { scopeContext });

    expect(result).toMatchObject({
      found: false,
      entityFound: true,
      artifactId: firstId,
      hits: [],
    });
  });
});
