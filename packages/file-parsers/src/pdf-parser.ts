import { contentHash, normalizeText, throwIfAborted } from "@pi-mentis/pi-mentis-core";

import type {
  DocumentNode,
  KnowledgeParser,
  ParsedDocumentEvent,
  ParserInput,
  ParserOptions,
  SourceProbe,
} from "./types.js";

export class PdfParser implements KnowledgeParser {
  readonly id = "pdfjs";
  readonly version = "1.0.0";
  readonly priority = 110;
  readonly cost = "cpu-heavy" as const;

  supports(probe: SourceProbe): boolean {
    return probe.mediaType === "application/pdf";
  }

  async *parse(input: ParserInput, options: ParserOptions): AsyncIterable<ParsedDocumentEvent> {
    throwIfAborted(options.signal, "pdf-parse");
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({
      // fs.readFile returns a Buffer, whose slice() remains a Buffer. PDF.js
      // deliberately rejects Buffer even though it subclasses Uint8Array.
      data: Uint8Array.from(input.bytes),
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
      disableFontFace: true,
      verbosity: 0,
    });
    const document = await task.promise;
    const nodes: DocumentNode[] = [];
    let extractedCharacters = 0;
    try {
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
        throwIfAborted(options.signal, "pdf-parse");
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = normalizeText(
          content.items
            .map((item) => ("str" in item && typeof item.str === "string" ? item.str : ""))
            .join(" "),
        );
        extractedCharacters += text.length;
        if (text !== "") {
          nodes.push({
            type: "paragraph",
            text,
            location: { uri: input.source.canonicalUri, page: pageNumber },
          });
        }
        yield {
          type: "progress",
          completed: pageNumber,
          total: document.numPages,
          phase: "pdf-text",
        };
      }
    } finally {
      await document.destroy();
    }
    if (extractedCharacters === 0) {
      yield {
        type: "diagnostic",
        code: "OCR_REQUIRED",
        message: "PDF contains no extractable text and requires an OCR provider",
      };
      return;
    }
    yield {
      type: "document",
      document: {
        id: contentHash(`${input.source.id}:${input.filename ?? input.source.canonicalUri}`),
        source: input.source,
        metadata: {
          title: input.filename ?? input.source.canonicalUri,
          mediaType: input.mediaType,
          attributes: { pages: document.numPages },
        },
        nodes,
      },
    };
  }
}
