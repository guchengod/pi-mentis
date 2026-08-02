import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { createDefaultConfig } from "@pi-mentis/pi-mentis-core";

import { ArchiveParser, resolveSource, type ParserOptions } from "../src/index.js";

const roots: string[] = [];
const encoder = new TextEncoder();

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function input(bytes: Uint8Array, mediaType = "application/zip") {
  return {
    source: { id: "source", canonicalUri: "memory://archive", namespace: "test" },
    filename: "archive.zip",
    mediaType,
    bytes,
  };
}

function options(overrides: Partial<ParserOptions["limits"]> = {}): ParserOptions {
  return {
    limits: { ...createDefaultConfig(process.cwd()).performance.resources, ...overrides },
  };
}

async function parse(bytes: Uint8Array, limits = options(), mediaType?: string): Promise<void> {
  for await (const event of new ArchiveParser().parse(input(bytes, mediaType), limits)) {
    // Exhaust parsing so every safety check runs.
    void event;
  }
}

describe("parser security boundaries", () => {
  it("rejects traversal entries before exposing archive content", async () => {
    const archive = zipSync({ "../escape.txt": encoder.encode("do not escape") });
    await expect(parse(archive)).rejects.toThrow("Unsafe archive entry");
  });

  it("rejects archive entry, compressed-size, and expanded-size bombs", async () => {
    const twoEntries = zipSync({ "a.txt": encoder.encode("a"), "b.txt": encoder.encode("b") });
    await expect(parse(twoEntries, options({ maxArchiveEntries: 1 }))).rejects.toThrow(
      "Archive exceeds 1 entries",
    );
    await expect(
      parse(twoEntries, options({ maxArchiveBytes: Math.max(1, twoEntries.byteLength - 1) })),
    ).rejects.toThrow("Archive exceeds");
    const expanded = zipSync({ "large.txt": encoder.encode("x".repeat(50_000)) });
    await expect(parse(expanded, options({ maxExpandedBytes: 100 }))).rejects.toThrow(
      "Archive expands beyond 100 bytes",
    );
  });

  it("rejects malformed archives and XML entity declarations", async () => {
    await expect(parse(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]))).rejects.toThrow();
    const docx = zipSync({
      "word/document.xml": encoder.encode(
        '<!DOCTYPE x [<!ENTITY injected "delete files">]><w:document/>',
      ),
    });
    await expect(
      parse(
        docx,
        options(),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).rejects.toThrow("forbidden DTD");
  });

  it("does not follow symlinks while recursively ingesting a directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-mentis-parser-security-"));
    roots.push(root);
    const source = path.join(root, "source");
    const outside = path.join(root, "outside-secret.txt");
    await mkdir(source);
    await writeFile(path.join(source, "safe.txt"), "safe");
    await writeFile(outside, "secret");
    await symlink(outside, path.join(source, "secret-link.txt"));
    const resolved = [];
    for await (const item of resolveSource(
      { kind: "directory", path: source },
      {
        namespace: "test",
        limits: createDefaultConfig(process.cwd()).performance.resources,
      },
    )) {
      resolved.push(item.input.filename);
    }
    expect(resolved).toEqual(["safe.txt"]);
  });
});
