import path from "node:path";

import { contentHash, normalizeText, throwIfAborted } from "@pi-mentis/pi-mentis-core";
import { XMLParser } from "fast-xml-parser";
import { unzipSync } from "fflate";

import type {
  DocumentNode,
  KnowledgeParser,
  ParsedDocumentEvent,
  ParserInput,
  ParserOptions,
  SourceProbe,
  StructuredDocument,
} from "./types.js";

const decoder = new TextDecoder("utf-8", { fatal: false });
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  processEntities: false,
  isArray: (name) => ["w:p", "w:r", "w:t", "c", "row", "si", "t"].includes(name),
});

function safeEntries(bytes: Uint8Array, options: ParserOptions): ReadonlyMap<string, Uint8Array> {
  if (bytes.byteLength > options.limits.maxArchiveBytes) {
    throw new Error(`Archive exceeds ${options.limits.maxArchiveBytes} bytes`);
  }
  const raw = unzipSync(bytes);
  const entries = Object.entries(raw);
  if (entries.length > options.limits.maxArchiveEntries) {
    throw new Error(`Archive exceeds ${options.limits.maxArchiveEntries} entries`);
  }
  const result = new Map<string, Uint8Array>();
  let expandedBytes = 0;
  for (const [name, value] of entries) {
    const normalized = path.posix.normalize(name.replaceAll("\\", "/"));
    if (
      normalized.startsWith("../") ||
      normalized.startsWith("/") ||
      normalized.includes("/../") ||
      normalized.includes("\0")
    ) {
      throw new Error(`Unsafe archive entry ${name}`);
    }
    expandedBytes += value.byteLength;
    if (expandedBytes > options.limits.maxExpandedBytes) {
      throw new Error(`Archive expands beyond ${options.limits.maxExpandedBytes} bytes`);
    }
    result.set(normalized, value);
  }
  return result;
}

function textValues(value: unknown, key: string, output: string[]): void {
  if (typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) textValues(item, key, output);
    return;
  }
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (name === key) {
      if (typeof item === "string") output.push(item);
      else if (Array.isArray(item)) {
        for (const entry of item) {
          if (typeof entry === "string") output.push(entry);
          else if (
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as Record<string, unknown>)["#text"] === "string"
          ) {
            output.push((entry as Record<string, unknown>)["#text"] as string);
          }
        }
      } else if (
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>)["#text"] === "string"
      ) {
        output.push((item as Record<string, unknown>)["#text"] as string);
      }
    }
    textValues(item, key, output);
  }
}

function parseXml(bytes: Uint8Array): unknown {
  const text = decoder.decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("Archive XML contains a forbidden DTD");
  return xmlParser.parse(text) as unknown;
}

function wordNodes(entries: ReadonlyMap<string, Uint8Array>): DocumentNode[] {
  const documentXml = entries.get("word/document.xml");
  if (documentXml === undefined) throw new Error("DOCX is missing word/document.xml");
  const parsed = parseXml(documentXml);
  const texts: string[] = [];
  textValues(parsed, "w:t", texts);
  return texts
    .map(normalizeText)
    .filter((text) => text !== "")
    .map((text) => ({ type: "paragraph" as const, text }));
}

function sharedStrings(entries: ReadonlyMap<string, Uint8Array>): readonly string[] {
  const bytes = entries.get("xl/sharedStrings.xml");
  if (bytes === undefined) return [];
  const parsed = parseXml(bytes);
  const values: string[] = [];
  textValues(parsed, "t", values);
  return values;
}

function xlsxNodes(entries: ReadonlyMap<string, Uint8Array>): DocumentNode[] {
  const strings = sharedStrings(entries);
  const sheets = [...entries.entries()]
    .filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }));
  const nodes: DocumentNode[] = [];
  for (const [name, bytes] of sheets) {
    const text = decoder.decode(bytes);
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("XLSX contains a forbidden DTD");
    const rows: string[][] = [];
    for (const rowMatch of text.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cellMatch of (rowMatch[1] ?? "").matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attributes = cellMatch[1] ?? "";
        const cellBody = cellMatch[2] ?? "";
        const value = /<v>([\s\S]*?)<\/v>/.exec(cellBody)?.[1] ?? "";
        cells.push(attributes.includes('t="s"') ? (strings[Number(value)] ?? value) : value);
      }
      rows.push(cells);
    }
    const sheet = path.posix.basename(name, ".xml");
    nodes.push({ type: "heading", level: 2, text: sheet });
    nodes.push({ type: "table", rows, sheet });
  }
  return nodes;
}

function pptxNodes(entries: ReadonlyMap<string, Uint8Array>): DocumentNode[] {
  const slides = [...entries.entries()]
    .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }));
  return slides.flatMap(([name, bytes], index) => {
    const values: string[] = [];
    textValues(parseXml(bytes), "a:t", values);
    return [
      { type: "heading" as const, level: 2, text: `Slide ${index + 1}` },
      {
        type: "paragraph" as const,
        text: normalizeText(values.join(" ")),
        location: { uri: name, page: index + 1 },
      },
    ];
  });
}

function epubNodes(entries: ReadonlyMap<string, Uint8Array>): DocumentNode[] {
  const candidates = [...entries.entries()]
    .filter(([name]) => /\.(?:xhtml|html|htm)$/i.test(name))
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }));
  return candidates.flatMap(([name, bytes]) => {
    const html = decoder
      .decode(bytes)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
    const text = normalizeText(
      html.replace(/<(br|p|div|li|h[1-6])\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, " "),
    );
    return text === ""
      ? []
      : [
          { type: "heading" as const, level: 2, text: name },
          { type: "paragraph" as const, text, location: { uri: name } },
        ];
  });
}

function genericZipNodes(entries: ReadonlyMap<string, Uint8Array>): DocumentNode[] {
  const allowed = /\.(?:txt|md|mdx|json|jsonl|ya?ml|toml|csv|html?|xml|ts|tsx|js|jsx|go|rs|py)$/i;
  return [...entries.entries()]
    .filter(([name, bytes]) => allowed.test(name) && !bytes.subarray(0, 4096).includes(0))
    .flatMap(([name, bytes]) => {
      const text = normalizeText(decoder.decode(bytes));
      return text === ""
        ? []
        : [
            { type: "heading" as const, level: 2, text: name },
            { type: "paragraph" as const, text, location: { uri: name } },
          ];
    });
}

export class ArchiveParser implements KnowledgeParser {
  readonly id = "structured-archive";
  readonly version = "1.0.0";
  readonly priority = 100;
  readonly cost = "cpu-heavy" as const;

  supports(probe: SourceProbe): boolean {
    return [
      "application/zip",
      "application/epub+zip",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ].includes(probe.mediaType ?? "");
  }

  async *parse(input: ParserInput, options: ParserOptions): AsyncIterable<ParsedDocumentEvent> {
    throwIfAborted(options.signal, "archive-parse");
    const entries = safeEntries(input.bytes, options);
    let nodes: DocumentNode[];
    if (
      input.mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      nodes = wordNodes(entries);
    } else if (
      input.mediaType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ) {
      nodes = xlsxNodes(entries);
    } else if (
      input.mediaType ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    ) {
      nodes = pptxNodes(entries);
    } else if (input.mediaType === "application/epub+zip") {
      nodes = epubNodes(entries);
    } else {
      nodes = genericZipNodes(entries);
    }
    const document: StructuredDocument = {
      id: contentHash(`${input.source.id}:${input.filename ?? input.source.canonicalUri}`),
      source: input.source,
      metadata: {
        title: input.filename ?? input.source.canonicalUri,
        mediaType: input.mediaType,
        attributes: { archiveEntries: entries.size },
      },
      nodes,
    };
    yield { type: "document", document };
  }
}
