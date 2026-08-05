import { execFile } from "node:child_process";
import { lstat, readFile, realpath, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  UnsupportedKnowledgeSourceError,
  contentHash,
  sourceId,
  type ResourceLimits,
} from "@pi-mentis/pi-mentis-core";

import { detectMediaType } from "./detection.js";
import type { KnowledgeSourceRef, ParserInput } from "./types.js";
import { resolveWebSource } from "./web-source.js";

const execFileAsync = promisify(execFile);

export type KnowledgeSourceInput =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "directory"; readonly path: string; readonly maxDepth?: number }
  | { readonly kind: "workspace"; readonly path: string; readonly maxDepth?: number }
  | { readonly kind: "git"; readonly path: string }
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "text"; readonly text: string; readonly name?: string }
  | { readonly kind: "buffer"; readonly bytes: Uint8Array; readonly name: string }
  | { readonly kind: "pi-package" | "skill" | "mcp"; readonly path: string };

export interface ResolveOptions {
  readonly namespace: string;
  readonly limits: ResourceLimits;
  readonly signal?: AbortSignal;
}

export interface ResolvedParserInput {
  readonly source: KnowledgeSourceRef;
  readonly input: ParserInput;
  readonly fingerprint: string;
}

function assertFileSize(bytes: Uint8Array, limits: ResourceLimits): void {
  if (bytes.byteLength > limits.maxFileBytes) {
    throw new UnsupportedKnowledgeSourceError(
      `Source contains ${bytes.byteLength} bytes; limit is ${limits.maxFileBytes}`,
      { operation: "source-resolve", retryable: false },
    );
  }
}

async function fileInput(
  filename: string,
  namespace: string,
  limits: ResourceLimits,
): Promise<ResolvedParserInput> {
  const canonicalPath = await realpath(filename);
  const bytes = await readFile(canonicalPath);
  assertFileSize(bytes, limits);
  const canonicalUri = pathToFileURL(canonicalPath).href;
  const source = {
    id: sourceId(namespace, canonicalUri),
    canonicalUri,
    namespace,
  };
  return {
    source,
    input: {
      source,
      filename: path.basename(canonicalPath),
      mediaType: detectMediaType(bytes, canonicalPath),
      bytes,
    },
    fingerprint: contentHash(bytes),
  };
}

async function* walkDirectory(
  root: string,
  namespace: string,
  limits: ResourceLimits,
  maxDepth = 1,
): AsyncIterable<ResolvedParserInput> {
  const canonicalRoot = await realpath(root);
  const pending: Array<[string, number]> = [[canonicalRoot, 0]];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined) continue;
    const [directory, depth] = item;
    if (visited.has(directory)) continue;
    visited.add(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if ([".git", "node_modules", "dist", ".turbo", ".pi-mentis"].includes(entry.name)) {
        continue;
      }
      const target = path.join(directory, entry.name);
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) {
        if (depth < maxDepth) pending.push([target, depth + 1]);
      } else if (metadata.isFile()) {
        yield await fileInput(target, namespace, limits);
      }
    }
  }
}

async function* gitInputs(
  root: string,
  namespace: string,
  limits: ResourceLimits,
): AsyncIterable<ResolvedParserInput> {
  const canonicalRoot = await realpath(root);
  const { stdout } = await execFileAsync("git", ["-C", canonicalRoot, "ls-files", "-z"], {
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  const files = stdout
    .toString("utf8")
    .split("\0")
    .filter((name) => name !== "");
  for (const relative of files) {
    const target = path.resolve(canonicalRoot, relative);
    if (!target.startsWith(`${canonicalRoot}${path.sep}`)) continue;
    yield await fileInput(target, namespace, limits);
  }
}

export async function* resolveSource(
  sourceInput: KnowledgeSourceInput,
  options: ResolveOptions,
): AsyncIterable<ResolvedParserInput> {
  if (sourceInput.kind === "directory" || sourceInput.kind === "workspace") {
    const depth = sourceInput.maxDepth ?? 1;
    yield* walkDirectory(sourceInput.path, options.namespace, options.limits, depth);
    return;
  }
  if (sourceInput.kind === "git") {
    yield* gitInputs(sourceInput.path, options.namespace, options.limits);
    return;
  }
  if (sourceInput.kind === "url") {
    yield* resolveWebSource(sourceInput.url, options.namespace, options.limits, options.signal);
    return;
  }
  if (sourceInput.kind === "text" || sourceInput.kind === "buffer") {
    const bytes =
      sourceInput.kind === "text" ? new TextEncoder().encode(sourceInput.text) : sourceInput.bytes;
    assertFileSize(bytes, options.limits);
    const name =
      sourceInput.kind === "text" ? (sourceInput.name ?? "inline.txt") : sourceInput.name;
    const canonicalUri = `memory://${contentHash(bytes)}/${encodeURIComponent(name)}`;
    const source = {
      id: sourceId(options.namespace, canonicalUri),
      canonicalUri,
      namespace: options.namespace,
    };
    yield {
      source,
      input: {
        source,
        filename: name,
        mediaType: detectMediaType(bytes, name),
        bytes,
      },
      fingerprint: contentHash(bytes),
    };
    return;
  }
  const filename = sourceInput.kind === "file" ? sourceInput.path : sourceInput.path;
  yield await fileInput(filename, options.namespace, options.limits);
}

export function canonicalFilePath(uri: string): string | undefined {
  return uri.startsWith("file:") ? fileURLToPath(uri) : undefined;
}
