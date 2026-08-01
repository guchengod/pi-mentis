import { appendFile } from "node:fs/promises";

export interface InferenceDiagnosticRecord {
  readonly timestamp: string;
  readonly operation: "embedding" | "rerank";
  readonly providerId: "siliconflow";
  readonly modelId: string;
  readonly dimensions?: number;
  readonly inputCount?: number;
  readonly documentCount?: number;
  readonly estimatedTokens: number;
  readonly durationMs: number;
  readonly status: "success" | "retry" | "failed";
  readonly httpStatus?: number;
  readonly traceId?: string;
  readonly cacheHit: false;
  readonly retryCount: number;
}

export async function recordInferenceDiagnostic(
  record: InferenceDiagnosticRecord,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const filename = environment["PI_MENTIS_INFERENCE_DIAGNOSTICS_FILE"]?.trim();
  if (filename === undefined || filename === "") return;
  try {
    await appendFile(filename, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (error: unknown) {
    if (environment["PI_MENTIS_LIVE_E2E"] === "1") throw error;
  }
}
