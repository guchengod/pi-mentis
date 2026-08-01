import { describe, expect, it } from "vitest";

import {
  ParserRegistry,
  TextParser,
  chunkStructuredDocument,
  detectMediaType,
} from "../src/index.js";

describe("parser selection and chunk packing", () => {
  it("uses magic bytes ahead of a misleading extension", () => {
    expect(
      detectMediaType(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]), "fake.txt", "text/plain"),
    ).toBe("application/zip");
  });

  it("rejects equal-priority ambiguity", async () => {
    const registry = new ParserRegistry();
    registry.register(new TextParser());
    registry.register({
      id: "other-text",
      version: "1",
      priority: new TextParser().priority,
      supports: async () => true,
      parse: async function* () {
        yield {
          type: "diagnostic" as const,
          code: "unused",
          message: "unused",
        };
      },
    });
    await expect(
      registry.select({ canonicalUri: "memory:test", mediaType: "text/plain" }),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_PARSER" });
  });

  it("packs AST nodes deterministically under the maximum", () => {
    const document = {
      metadata: { title: "Test", mediaType: "text/plain", canonicalUri: "memory:test" },
      nodes: [
        { type: "heading" as const, level: 1 as const, text: "Heading" },
        { type: "paragraph" as const, text: "alpha ".repeat(20) },
        { type: "paragraph" as const, text: "beta ".repeat(20) },
      ],
    };
    const first = chunkStructuredDocument(document, undefined, {
      targetTokens: 80,
      maxTokens: 160,
      overlapTokens: 0,
    });
    const second = chunkStructuredDocument(document, undefined, {
      targetTokens: 80,
      maxTokens: 160,
      overlapTokens: 0,
    });
    expect(first).toEqual(second);
    expect(first.every((chunk) => chunk.tokenCount <= 160)).toBe(true);
  });
});
