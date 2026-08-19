import { describe, expect, it } from "vitest";

import { chunkStructuredDocument, type StructuredDocument } from "../src/index.js";

describe("structured document token counting", () => {
  it("uses model-token estimates for chunking instead of UTF-8 bytes", () => {
    const document: StructuredDocument = {
      id: "document-1",
      source: { id: "source-1", canonicalUri: "memory://document", namespace: "test" },
      metadata: { title: "Token estimate", mediaType: "text/plain" },
      nodes: [{ type: "paragraph", text: "a".repeat(1_000) }],
    };

    const chunks = chunkStructuredDocument(document);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.tokenCount).toBe(250);
  });
});
