import { createHash, randomUUID } from "node:crypto";

function encodePart(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

export function stableHash(domain: string, ...parts: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(encodePart(domain));
  for (const part of parts) hash.update(encodePart(part));
  return hash.digest("hex");
}

export function contentHash(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function sourceId(namespace: string, canonicalUri: string): string {
  return stableHash("source:v1", namespace, canonicalUri);
}

export function documentId(source: string, logicalDocumentPath: string): string {
  return stableHash("document:v1", source, logicalDocumentPath);
}

export function chunkId(document: string, semanticKey: string, normalizedHash: string): string {
  return stableHash("chunk:v1", document, semanticKey, normalizedHash);
}

export function operationId(prefix: "job" | "trace" | "operation" | "generation"): string {
  return `${prefix}_${randomUUID()}`;
}

export function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}
