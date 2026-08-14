import path from "node:path";

import type { OffloadedToolResult, ToolResultEnvelope } from "./types.js";

export const MAX_FULL_READ_MODEL_BYTES = 256 * 1024;

type ReadEnvelope = Pick<ToolResultEnvelope, "toolName" | "input" | "cwd" | "text"> & {
  readonly captureIntegrity?: ToolResultEnvelope["captureIntegrity"];
};

function artifactId(result: OffloadedToolResult): string | undefined {
  return result.artifact?.id ?? result.symbolic.artifactId;
}

function compactSymbolic(result: OffloadedToolResult): Record<string, unknown> {
  const symbolic = { ...result.symbolic };
  delete symbolic.preview;
  return symbolic;
}

export function readRequestKey(envelope: ReadEnvelope): string | undefined {
  if (envelope.toolName !== "read" || typeof envelope.input["path"] !== "string") return undefined;
  return JSON.stringify({
    path: path.resolve(envelope.cwd, envelope.input["path"]),
    ...(typeof envelope.input["offset"] === "number" ? { offset: envelope.input["offset"] } : {}),
    ...(typeof envelope.input["limit"] === "number" ? { limit: envelope.input["limit"] } : {}),
  });
}

export function canReturnFullRead(envelope: ReadEnvelope, result: OffloadedToolResult): boolean {
  return (
    readRequestKey(envelope) !== undefined &&
    artifactId(result) !== undefined &&
    envelope.captureIntegrity?.complete !== false &&
    Buffer.byteLength(envelope.text, "utf8") <= MAX_FULL_READ_MODEL_BYTES
  );
}

export function fullReadResult(envelope: ReadEnvelope, result: OffloadedToolResult): string {
  const id = artifactId(result);
  if (id === undefined) return envelope.text;
  return `${envelope.text}\n\n<pi-mentis-large-read>\n${JSON.stringify(
    {
      artifactId: id,
      path: envelope.input["path"],
      bytes: Buffer.byteLength(envelope.text, "utf8"),
      complete: envelope.captureIntegrity?.complete !== false,
    },
    null,
    2,
  )}\n</pi-mentis-large-read>\nThe complete selected file content is provided above once. When this context is compacted, preserve a concise summary and this artifactId. To recover a detail later, call search_memory({ id: "artifact-id", query: "focused keywords" }) with the actual artifactId and a focused query instead of re-reading the file in chunks.`;
}

export function compactReadReference(envelope: ReadEnvelope, result: OffloadedToolResult): string {
  const id = artifactId(result);
  if (id === undefined) return result.modelText;
  return `<pi-mentis-large-read-reference>\n${JSON.stringify(
    {
      artifactId: id,
      path: envelope.input["path"],
      summary: compactSymbolic(result),
    },
    null,
    2,
  )}\n</pi-mentis-large-read-reference>\nThe complete selected file content was already provided earlier in this session. Use search_memory({ id: "artifact-id", query: "focused keywords" }) with the actual artifactId and a focused query for any needed detail.`;
}
