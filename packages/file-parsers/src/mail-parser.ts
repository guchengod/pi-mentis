import { contentHash, normalizeText } from "@pi-mentis/pi-mentis-core";

import type {
  DocumentNode,
  KnowledgeParser,
  ParsedDocumentEvent,
  ParserInput,
  SourceProbe,
} from "./types.js";

const decoder = new TextDecoder("utf-8", { fatal: false });

function unfoldHeaders(value: string): readonly [string, string][] {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const unfolded: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] = `${unfolded.at(-1) ?? ""} ${line.trim()}`;
    } else {
      unfolded.push(line);
    }
  }
  return unfolded.flatMap((line) => {
    const colon = line.indexOf(":");
    return colon <= 0 ? [] : [[line.slice(0, colon).trim(), line.slice(colon + 1).trim()]];
  });
}

function decodeBody(body: string, transferEncoding: string | undefined): string {
  if (transferEncoding?.toLowerCase() === "base64") {
    return Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8");
  }
  if (transferEncoding?.toLowerCase() === "quoted-printable") {
    return body
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-F]{2})/gi, (_match, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
  }
  return body;
}

function parseMessage(raw: string, uri: string): DocumentNode[] {
  const separator = /\r?\n\r?\n/.exec(raw);
  const headerText = separator === null ? raw : raw.slice(0, separator.index);
  const body = separator === null ? "" : raw.slice(separator.index + separator[0].length);
  const headers = unfoldHeaders(headerText);
  const lookup = new Map(headers.map(([name, value]) => [name.toLowerCase(), value]));
  const nodes: DocumentNode[] = headers
    .filter(([name]) =>
      ["from", "to", "cc", "date", "subject", "message-id"].includes(name.toLowerCase()),
    )
    .map(([key, value]) => ({ type: "metadata" as const, key, value }));
  const contentType = lookup.get("content-type") ?? "text/plain";
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  if (boundary !== undefined) {
    for (const part of body.split(`--${boundary}`)) {
      const partSeparator = /\r?\n\r?\n/.exec(part);
      if (partSeparator === null) continue;
      const partHeaders = new Map(
        unfoldHeaders(part.slice(0, partSeparator.index)).map(([name, value]) => [
          name.toLowerCase(),
          value,
        ]),
      );
      const disposition = partHeaders.get("content-disposition") ?? "";
      const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
      if (filename !== undefined) {
        nodes.push({ type: "metadata", key: "attachment", value: filename });
        continue;
      }
      const decoded = decodeBody(
        part.slice(partSeparator.index + partSeparator[0].length),
        partHeaders.get("content-transfer-encoding"),
      );
      const text = normalizeText(decoded.replace(/<[^>]+>/g, " "));
      if (text !== "") nodes.push({ type: "paragraph", text, location: { uri } });
    }
  } else {
    const text = normalizeText(
      decodeBody(body, lookup.get("content-transfer-encoding")).replace(/<[^>]+>/g, " "),
    );
    if (text !== "") nodes.push({ type: "paragraph", text, location: { uri } });
  }
  return nodes;
}

export class MailParser implements KnowledgeParser {
  readonly id = "internet-message";
  readonly version = "1.0.0";
  readonly priority = 90;
  readonly cost = "light" as const;

  supports(probe: SourceProbe): boolean {
    return ["message/rfc822", "application/mbox"].includes(probe.mediaType ?? "");
  }

  async *parse(input: ParserInput): AsyncIterable<ParsedDocumentEvent> {
    const raw = decoder.decode(input.bytes);
    const messages =
      input.mediaType === "application/mbox"
        ? raw.split(/\n(?=From [^\n]+(?:\n|$))/).filter((message) => message.trim() !== "")
        : [raw];
    const nodes = messages.flatMap((message, index) => [
      ...(messages.length > 1
        ? [{ type: "heading" as const, level: 2, text: `Message ${index + 1}` }]
        : []),
      ...parseMessage(message, `${input.source.canonicalUri}#message-${index + 1}`),
    ]);
    yield {
      type: "document",
      document: {
        id: contentHash(`${input.source.id}:${input.filename ?? input.source.canonicalUri}`),
        source: input.source,
        metadata: {
          title: input.filename ?? input.source.canonicalUri,
          mediaType: input.mediaType,
          attributes: { messages: messages.length },
        },
        nodes,
      },
    };
  }
}
