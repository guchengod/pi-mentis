import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { offloadToolResult } from "../src/offload.js";
import { recoverFullToolResult } from "../src/pi-capture.js";
import type { ArtifactRecord, PiEvidenceStore, ToolResultEnvelope } from "../src/types.js";

function envelope(text: string, details: unknown): ToolResultEnvelope {
  return {
    toolCallId: "call-1",
    toolName: "bash",
    input: { command: "node large-log.mjs" },
    text,
    details,
    isError: false,
    cwd: process.cwd(),
    completedAt: Date.now(),
  };
}

describe("Pi tool result capture", () => {
  it("recovers complete truncated bash output from Pi's bounded temporary file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-mentis-capture-"));
    const outputPath = path.join(directory, "pi-bash-0123456789abcdef.log");
    const complete = "BUILD_ERROR src/index.ts:42\n".repeat(10_000);
    try {
      await writeFile(outputPath, complete);
      const recovered = await recoverFullToolResult(
        envelope("truncated tail", {
          truncation: { truncated: true, totalBytes: Buffer.byteLength(complete) },
          fullOutputPath: outputPath,
        }),
      );
      expect(recovered.text).toBe(complete);
      expect(recovered.captureIntegrity).toMatchObject({
        complete: true,
        lossy: false,
        sourceReportedBytes: Buffer.byteLength(complete),
        capturedBytes: Buffer.byteLength(complete),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("marks a missing Pi full-output file as lossy instead of claiming completeness", async () => {
    const recovered = await recoverFullToolResult(
      envelope("truncated tail", {
        truncation: { truncated: true, totalBytes: 100_000 },
        fullOutputPath: path.join(tmpdir(), "pi-bash-ffffffffffffffff.log"),
      }),
    );
    expect(recovered.text).toBe("truncated tail");
    expect(recovered.captureIntegrity).toMatchObject({
      complete: false,
      lossy: true,
      sourceReportedBytes: 100_000,
      truncationStage: "host",
    });
  });

  it("recovers a complete truncated read result without requiring continuation calls", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-mentis-read-capture-"));
    const inputPath = path.join(directory, "SKILL.md");
    const lines = Array.from({ length: 2_400 }, (_, index) => `line ${index + 1}`);
    const complete = lines.join("\n");
    try {
      await writeFile(inputPath, complete);
      const recovered = await recoverFullToolResult({
        ...envelope("line 1\n\n[Showing lines 1-1 of 2400. Use offset=2 to continue.]", {
          truncation: { truncated: true, totalBytes: Buffer.byteLength(complete) },
        }),
        toolName: "read",
        input: { path: inputPath },
      });

      expect(recovered.text).toBe(complete);
      expect(recovered.captureIntegrity).toMatchObject({
        complete: true,
        lossy: false,
        sourceReportedBytes: Buffer.byteLength(complete),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists recovered capture integrity with the artifact", async () => {
    const written: Array<Record<string, unknown>> = [];
    const artifact = {
      id: "artifact-1",
      episodeId: "episode-1",
      securityNamespace: "local",
      mediaType: "text/plain; charset=utf-8",
      byteLength: 70_000,
      contentHash: "hash",
      relativePath: "artifacts/a/manifest.json",
      state: "ready",
      chunks: [],
      createdAt: 1,
      updatedAt: 1,
    } as ArtifactRecord;
    const evidence = {
      writeArtifact: async (input: Record<string, unknown>) => {
        written.push(input);
        return artifact;
      },
    } as unknown as PiEvidenceStore;
    const result = await offloadToolResult(
      evidence,
      "episode-1",
      "event-1",
      {
        ...envelope("x".repeat(70_000), undefined),
        captureIntegrity: { complete: true, lossy: false, capturedBytes: 70_000 },
      },
      { inlineMaxBytes: 8_192, truncateMaxBytes: 65_536, previewBytes: 4_096 },
    );
    expect(result.mode).toBe("artifact");
    expect(written[0]?.captureIntegrity).toEqual({
      complete: true,
      lossy: false,
      capturedBytes: 70_000,
      storedBytes: 70_000,
    });
    expect(result.symbolic.captureIntegrity).toMatchObject({ complete: true, lossy: false });
  });
});
