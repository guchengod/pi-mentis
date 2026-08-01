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

  it("hard-splits long structure atoms without paragraph or line boundaries", () => {
    const longLine = "Pi Mentis 长文本 without-breaks ".repeat(2_000);
    const document = {
      metadata: { title: "Long", mediaType: "text/html", canonicalUri: "memory:long" },
      nodes: [{ type: "paragraph" as const, text: longLine }],
    };
    const chunks = chunkStructuredDocument(document, undefined, {
      targetTokens: 80,
      maxTokens: 160,
      overlapTokens: 0,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.tokenCount <= 160)).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(longLine.trim());
  });

  it("drops overlap rather than exceeding the maximum chunk size", () => {
    const document = {
      metadata: { title: "Overlap", mediaType: "text/plain", canonicalUri: "memory:overlap" },
      nodes: [
        { type: "paragraph" as const, text: "a".repeat(50) },
        { type: "paragraph" as const, text: "b".repeat(160) },
      ],
    };
    const chunks = chunkStructuredDocument(document, undefined, {
      targetTokens: 40,
      maxTokens: 160,
      overlapTokens: 60,
    });
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.tokenCount <= 160)).toBe(true);
    expect(chunks[1]?.text).toBe("b".repeat(160));
  });
});
