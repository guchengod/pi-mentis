import { contentHash, normalizeText } from "@pi-mentis/pi-mentis-core";

import type { DocumentNode, KnowledgeChunkDraft, StructuredDocument } from "./types.js";

export interface TokenCounter {
  count(text: string): number;
}

export interface ChunkPolicy {
  readonly targetTokens: number;
  readonly maxTokens: number;
  readonly overlapTokens: number;
}

export const DEFAULT_DOCUMENT_CHUNK_POLICY: ChunkPolicy = {
  targetTokens: 420,
  maxTokens: 650,
  overlapTokens: 60,
};

export const DEFAULT_CODE_CHUNK_POLICY: ChunkPolicy = {
  targetTokens: 300,
  maxTokens: 550,
  overlapTokens: 60,
};

export class ConservativeByteTokenCounter implements TokenCounter {
  count(text: string): number {
    return Math.max(1, Buffer.byteLength(text.normalize("NFKC"), "utf8"));
  }
}

interface Atom {
  readonly text: string;
  readonly tokenCount: number;
  readonly headingPath: readonly string[];
  readonly location?: DocumentNode["location"];
  readonly symbol?: { readonly name: string; readonly kind: string };
}

function nodeText(node: DocumentNode): string {
  if (node.type === "table") return node.rows.map((row) => row.join("\t")).join("\n");
  if (node.type === "list") return node.items.map((item) => `- ${item}`).join("\n");
  if (node.type === "metadata") return `${node.key}: ${node.value}`;
  if (node.type === "image") return node.alt;
  if (node.type === "link") return `${node.text} (${node.href})`;
  return node.text;
}

function atoms(document: StructuredDocument, counter: TokenCounter): readonly Atom[] {
  const headings: string[] = [];
  const result: Atom[] = [];
  for (const node of document.nodes) {
    if (node.type === "heading") {
      headings.splice(Math.max(0, node.level - 1));
      headings[node.level - 1] = node.text;
      continue;
    }
    const text = normalizeText(nodeText(node));
    if (text === "") continue;
    result.push({
      text,
      tokenCount: counter.count(text),
      headingPath: headings.filter((heading) => heading !== undefined),
      ...(node.location === undefined ? {} : { location: node.location }),
      ...(node.type === "symbol" ? { symbol: { name: node.name, kind: node.kind } } : {}),
    });
  }
  return result;
}

function safelySplit(text: string, maxTokens: number, counter: TokenCounter): readonly string[] {
  if (counter.count(text) <= maxTokens) return [text];
  const paragraphs = text.split(/\n{2,}/);
  if (paragraphs.length > 1) {
    const pieces: string[] = [];
    let current = "";
    for (const paragraph of paragraphs) {
      const candidate = current === "" ? paragraph : `${current}\n\n${paragraph}`;
      if (counter.count(candidate) > maxTokens && current !== "") {
        pieces.push(current);
        current = paragraph;
      } else {
        current = candidate;
      }
    }
    if (current !== "") pieces.push(current);
    if (pieces.every((piece) => counter.count(piece) <= maxTokens)) return pieces;
  }
  const lines = text.split("\n");
  const pieces: string[] = [];
  let current = "";
  for (const line of lines) {
    const candidate = current === "" ? line : `${current}\n${line}`;
    if (counter.count(candidate) > maxTokens && current !== "") {
      pieces.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current !== "") pieces.push(current);
  if (pieces.some((piece) => counter.count(piece) > maxTokens)) {
    throw new Error("A structure atom exceeds the Embedding model token limit");
  }
  return pieces;
}

export function chunkStructuredDocument(
  document: StructuredDocument,
  counter: TokenCounter = new ConservativeByteTokenCounter(),
  policy: ChunkPolicy = DEFAULT_DOCUMENT_CHUNK_POLICY,
  embeddingMaxInputTokens = Number.POSITIVE_INFINITY,
): readonly KnowledgeChunkDraft[] {
  const maximum = Math.min(policy.maxTokens, embeddingMaxInputTokens);
  const expanded = atoms(document, counter).flatMap((atom) =>
    safelySplit(atom.text, maximum, counter).map((text) => ({
      ...atom,
      text,
      tokenCount: counter.count(text),
    })),
  );
  const chunks: KnowledgeChunkDraft[] = [];
  let current: Atom[] = [];
  let currentTokens = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    const text = current.map((atom) => atom.text).join("\n\n");
    const first = current[0];
    if (first === undefined) return;
    const ordinal = chunks.length;
    const semanticBase = first.symbol?.name ?? first.headingPath.join("/") ?? `chunk-${ordinal}`;
    chunks.push({
      semanticKey: `${semanticBase}:${contentHash(text).slice(0, 12)}`,
      text,
      searchableText: text,
      ordinal,
      headingPath: first.headingPath,
      tokenCount: counter.count(text),
      ...(first.location === undefined ? {} : { location: first.location }),
      ...(first.symbol === undefined ? {} : { symbol: first.symbol }),
    });
    const overlap: Atom[] = [];
    let overlapTokens = 0;
    for (let index = current.length - 1; index >= 0; index--) {
      const atom = current[index];
      if (atom === undefined || overlapTokens + atom.tokenCount > policy.overlapTokens) break;
      overlap.unshift(atom);
      overlapTokens += atom.tokenCount;
    }
    current = overlap;
    currentTokens = overlapTokens;
  };
  for (const atom of expanded) {
    if (
      current.length > 0 &&
      (currentTokens >= policy.targetTokens || currentTokens + atom.tokenCount > maximum)
    ) {
      flush();
    }
    current.push(atom);
    currentTokens += atom.tokenCount;
  }
  flush();
  return chunks;
}
