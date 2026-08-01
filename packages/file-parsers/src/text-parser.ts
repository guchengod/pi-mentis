import { contentHash, normalizeText, throwIfAborted } from "@pi-mentis/pi-mentis-core";
import { parse as parseCsv } from "csv-parse/sync";
import { XMLParser } from "fast-xml-parser";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

import type {
  DocumentNode,
  KnowledgeParser,
  ParsedDocumentEvent,
  ParserInput,
  ParserOptions,
  SourceProbe,
  StructuredDocument,
} from "./types.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

function flattenObject(value: unknown, prefix = ""): DocumentNode[] {
  if (typeof value !== "object" || value === null) {
    return [{ type: "metadata", key: prefix || "value", value: String(value) }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flattenObject(item, `${prefix}[${index}]`));
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
    flattenObject(item, prefix === "" ? key : `${prefix}.${key}`),
  );
}

function stripHtml(html: string): DocumentNode[] {
  const content =
    /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ??
    /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1] ??
    /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ??
    html;
  const sanitized = content
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  const nodes: DocumentNode[] = [];
  const headingPattern = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  for (const match of sanitized.matchAll(headingPattern)) {
    nodes.push({
      type: "heading",
      level: Number(match[1]),
      text: normalizeText((match[2] ?? "").replace(/<[^>]+>/g, " ")),
    });
  }
  const text = normalizeText(
    sanitized
      .replace(/<(br|p|div|li|tr|h[1-6])\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"'),
  );
  if (text !== "") nodes.push({ type: "paragraph", text });
  return nodes;
}

function markdownNodes(text: string): DocumentNode[] {
  const nodes: DocumentNode[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let code: string[] | undefined;
  let codeLanguage: string | undefined;
  let paragraph: string[] = [];
  const flushParagraph = (): void => {
    const value = normalizeText(paragraph.join("\n"));
    if (value !== "") nodes.push({ type: "paragraph", text: value });
    paragraph = [];
  };
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("```")) {
      if (code === undefined) {
        flushParagraph();
        code = [];
        codeLanguage = line.slice(3).trim() || undefined;
      } else {
        nodes.push({
          type: "code",
          ...(codeLanguage === undefined ? {} : { language: codeLanguage }),
          text: code.join("\n"),
          location: { uri: "", lineStart: index - code.length, lineEnd: index + 1 },
        });
        code = undefined;
        codeLanguage = undefined;
      }
      continue;
    }
    if (code !== undefined) {
      code.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading !== null) {
      flushParagraph();
      nodes.push({
        type: "heading",
        level: heading[1]?.length ?? 1,
        text: normalizeText(heading[2] ?? ""),
      });
      continue;
    }
    if (line.trim() === "") flushParagraph();
    else paragraph.push(line);
  }
  flushParagraph();
  if (code !== undefined && code.length > 0) {
    nodes.push({
      type: "code",
      ...(codeLanguage === undefined ? {} : { language: codeLanguage }),
      text: code.join("\n"),
    });
  }
  return nodes;
}

function codeNodes(
  text: string,
  extension: string | undefined,
  canonicalUri: string,
): DocumentNode[] {
  const patterns = [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
    /^\s*(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/gm,
    /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm,
    /^\s*(?:pub\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)/gm,
  ];
  const symbols: Array<{ name: string; index: number }> = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1] !== undefined && match.index !== undefined) {
        symbols.push({ name: match[1], index: match.index });
      }
    }
  }
  symbols.sort((left, right) => left.index - right.index);
  if (symbols.length === 0) {
    const language = extension?.slice(1);
    return [
      {
        type: "code",
        ...(language === undefined ? {} : { language }),
        text,
      },
    ];
  }
  return symbols.map((symbol, index) => {
    const symbolText = text.slice(symbol.index, symbols[index + 1]?.index ?? text.length).trim();
    const lineStart = text.slice(0, symbol.index).split("\n").length;
    return {
      type: "symbol",
      name: symbol.name,
      kind: "code-symbol",
      text: symbolText,
      location: {
        uri: canonicalUri,
        lineStart,
        lineEnd: lineStart + symbolText.split("\n").length - 1,
        symbol: symbol.name,
      },
    };
  });
}

export class TextParser implements KnowledgeParser {
  readonly id = "structured-text";
  readonly version = "1.0.0";
  readonly priority = 10;
  readonly cost = "light" as const;

  supports(probe: SourceProbe): boolean {
    return (
      probe.mediaType?.startsWith("text/") === true ||
      [
        "application/json",
        "application/x-ndjson",
        "application/yaml",
        "application/toml",
        "application/xml",
      ].includes(probe.mediaType ?? "")
    );
  }

  async *parse(input: ParserInput, options: ParserOptions): AsyncIterable<ParsedDocumentEvent> {
    throwIfAborted(options.signal, "text-parse");
    const text = decoder.decode(input.bytes);
    let nodes: DocumentNode[];
    if (input.mediaType === "application/json") {
      nodes = flattenObject(JSON.parse(text) as unknown);
    } else if (input.mediaType === "application/x-ndjson") {
      nodes = text
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "")
        .flatMap((line, index) => [
          { type: "heading" as const, level: 2, text: `Record ${index + 1}` },
          ...flattenObject(JSON.parse(line) as unknown),
        ]);
    } else if (input.mediaType === "application/yaml") {
      nodes = flattenObject(parseYaml(text) as unknown);
    } else if (input.mediaType === "application/toml") {
      nodes = flattenObject(parseToml(text) as unknown);
    } else if (input.mediaType === "text/csv") {
      const rows = parseCsv(text, {
        relax_column_count: true,
        skip_empty_lines: true,
      }) as string[][];
      nodes = [{ type: "table", rows }];
    } else if (input.mediaType === "text/html") {
      nodes = stripHtml(text);
    } else if (input.mediaType === "application/xml") {
      if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
        throw new Error("XML document types and entities are not allowed");
      }
      const xml = new XMLParser({
        ignoreAttributes: false,
        processEntities: false,
        numberParseOptions: { leadingZeros: false, hex: false },
      }).parse(text) as unknown;
      nodes = flattenObject(xml);
    } else if (input.mediaType === "text/markdown") {
      nodes = markdownNodes(text);
    } else {
      const extension = input.filename?.match(/\.[^.]+$/)?.[0]?.toLowerCase();
      const codeExtensions = new Set([
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
        ".go",
        ".rs",
        ".py",
        ".java",
        ".kt",
        ".swift",
        ".c",
        ".h",
        ".cpp",
        ".hpp",
        ".css",
        ".scss",
        ".sql",
        ".sh",
      ]);
      nodes =
        extension !== undefined && codeExtensions.has(extension)
          ? codeNodes(text, extension, input.source.canonicalUri)
          : [{ type: "paragraph", text: normalizeText(text) }];
    }
    const document: StructuredDocument = {
      id: contentHash(`${input.source.id}:${input.filename ?? input.source.canonicalUri}`),
      source: input.source,
      metadata: {
        title: input.title ?? input.filename ?? input.source.canonicalUri,
        mediaType: input.mediaType,
        ...(input.attributes === undefined ? {} : { attributes: input.attributes }),
      },
      nodes,
    };
    yield { type: "document", document };
  }
}
