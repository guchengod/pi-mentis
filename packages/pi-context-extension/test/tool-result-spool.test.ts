import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  consumeToolResultSpool,
  createToolResultSpool,
  removeToolResultSpool,
  toolResultSpoolPath,
} from "../src/tool-result-spool.js";

describe("tool-result IPC spool", () => {
  it("hands a large result to the Sidecar without retaining a second IPC copy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-mentis-spool-"));
    const storageRoot = path.join(root, "zvec");
    try {
      const text = "large tool result\n".repeat(16_384);
      const receipt = await createToolResultSpool(storageRoot, text);
      const filename = toolResultSpoolPath(storageRoot, receipt.spoolId);

      expect((await stat(filename)).mode & 0o777).toBe(0o600);
      await expect(consumeToolResultSpool(storageRoot, receipt.spoolId)).resolves.toBe(text);
      await expect(access(filename)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects path traversal and supports sender-side failure cleanup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-mentis-spool-cleanup-"));
    const storageRoot = path.join(root, "zvec");
    try {
      expect(() => toolResultSpoolPath(storageRoot, "../../escape")).toThrow(
        "Invalid tool result spool ID",
      );
      const receipt = await createToolResultSpool(storageRoot, "cleanup");
      const filename = toolResultSpoolPath(storageRoot, receipt.spoolId);
      await removeToolResultSpool(storageRoot, receipt.spoolId);
      await expect(access(filename)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
