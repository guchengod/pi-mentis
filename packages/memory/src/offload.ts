import type {
  ArtifactRecord,
  ArtifactCaptureIntegrity,
  OffloadedToolResult,
  PiEvidenceStore,
  ToolResultEnvelope,
  ToolResultOffloadPolicy,
  ToolSymbolicResult,
} from "./types.js";
import { ConservativeUtf8TokenEstimator } from "@pi-mentis/pi-mentis-inference";

const ERROR_LINE = /(?:\berror\b|\bfailed\b|\bfatal\b|exception|traceback|\bE[A-Z]{2,}\b)/i;
const PATH_TOKEN = /(?:^|[\s"'`(])((?:\.{0,2}\/|\/)?[\w@.-]+(?:\/[\w@.-]+)+(?::\d+(?::\d+)?)?)/g;
const tokenEstimator = new ConservativeUtf8TokenEstimator();

function tokenAccounting(original: string, retained: string) {
  const originalTokens = tokenEstimator.count(original);
  const retainedTokens = tokenEstimator.count(retained);
  return {
    estimator: "conservative-utf8-v1" as const,
    originalTokens,
    retainedTokens,
    offloadedTokens: Math.max(0, originalTokens - retainedTokens),
  };
}

function unique(values: readonly string[], limit: number): string[] {
  return [...new Set(values.filter((value) => value !== ""))].slice(0, limit);
}

function detailNumber(details: unknown, name: string): number | null | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const value = (details as Record<string, unknown>)[name];
  return typeof value === "number" || value === null ? value : undefined;
}

function pathsFrom(input: Readonly<Record<string, unknown>>, text: string): string[] {
  const explicit = [input["path"], input["file"], input["filename"]].filter(
    (value): value is string => typeof value === "string",
  );
  const matches = [...text.matchAll(PATH_TOKEN)].map((match) => match[1] ?? "");
  return unique([...explicit, ...matches], 16);
}

export function classifyToolResult(
  byteLength: number,
  policy: ToolResultOffloadPolicy,
): OffloadedToolResult["mode"] {
  if (byteLength <= policy.inlineMaxBytes) return "inline";
  if (byteLength <= policy.truncateMaxBytes) return "truncated";
  return "artifact";
}

export function summarizeToolResult(
  envelope: ToolResultEnvelope,
  policy: ToolResultOffloadPolicy,
  artifact?: ArtifactRecord,
): ToolSymbolicResult {
  const bytes = Buffer.byteLength(envelope.text, "utf8");
  const lines = envelope.text.split(/\r?\n/);
  const keyErrors = unique(
    lines.filter((line) => ERROR_LINE.test(line)).map((line) => line.trim().slice(0, 500)),
    8,
  );
  const command =
    typeof envelope.input["command"] === "string" ? envelope.input["command"] : undefined;
  const durationMs =
    envelope.startedAt === undefined
      ? undefined
      : Math.max(0, envelope.completedAt - envelope.startedAt);
  const exitCode = detailNumber(envelope.details, "exitCode");
  const mode = classifyToolResult(bytes, policy);
  const isInline = mode === "inline";
  const captureIntegrity: ArtifactCaptureIntegrity = isInline
    ? { complete: true, lossy: false, capturedBytes: bytes }
    : { complete: false, lossy: true, capturedBytes: bytes, truncationStage: "host" };
  return {
    tool: envelope.toolName,
    status: envelope.isError ? "failed" : "completed",
    ...(command === undefined ? {} : { command }),
    cwd: envelope.cwd,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(durationMs === undefined ? {} : { durationMs }),
    errorCount: lines.filter((line) => ERROR_LINE.test(line)).length,
    keyErrors,
    files: pathsFrom(envelope.input, envelope.text),
    ...(artifact === undefined ? {} : { artifactId: artifact.id }),
    truncated: bytes > policy.inlineMaxBytes,
    originalBytes: bytes,
    ...(bytes <= policy.inlineMaxBytes
      ? {}
      : { preview: Buffer.from(envelope.text).subarray(0, policy.previewBytes).toString("utf8") }),
    captureIntegrity,
  };
}

export async function offloadToolResult(
  evidence: PiEvidenceStore,
  episodeId: string,
  eventId: string,
  envelope: ToolResultEnvelope,
  policy: ToolResultOffloadPolicy,
): Promise<OffloadedToolResult> {
  const bytes = Buffer.byteLength(envelope.text, "utf8");
  const mode = classifyToolResult(bytes, policy);
  if (mode === "inline") {
    return {
      mode,
      symbolic: summarizeToolResult(envelope, policy),
      modelText: envelope.text,
      tokenAccounting: tokenAccounting(envelope.text, envelope.text),
    };
  }
  const artifact = await evidence.writeArtifact({
    episodeId,
    eventId,
    toolCallId: envelope.toolCallId,
    mediaType: "text/plain; charset=utf-8",
    content: envelope.text,
  });
  const symbolic = summarizeToolResult(envelope, policy, artifact);
  const header = `<pi-mentis-tool-result artifact_id="${artifact.id}" mode="${mode}">\n${JSON.stringify(symbolic, null, 2)}\n</pi-mentis-tool-result>`;
  const modelText =
    mode === "truncated" ? `${header}\n\nPreview:\n${symbolic.preview ?? ""}` : header;
  return {
    mode,
    symbolic,
    modelText,
    tokenAccounting: tokenAccounting(envelope.text, modelText),
    artifact,
  };
}
