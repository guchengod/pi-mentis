import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";

const TRUNCATION_NOTICE_MAX_BYTES = 1_024;
const TRUNCATION_NOTICE_LINES = 2;

export const PI_TOOL_OUTPUT_LIMIT_DESCRIPTION =
  "Output is limited to 50KB or 2000 lines. Narrow the query or lower the limit if a truncation notice is returned.";

export function formatPiToolJson(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  const truncation = truncateHead(serialized, {
    maxBytes: DEFAULT_MAX_BYTES - TRUNCATION_NOTICE_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES - TRUNCATION_NOTICE_LINES,
  });
  if (!truncation.truncated) return truncation.content;

  const notice =
    `[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines ` +
    `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
    "Full data remains in Pi Mentis; rerun with a narrower query, an exact ID, or a lower limit.]";
  return truncation.content === "" ? notice : `${truncation.content}\n\n${notice}`;
}

export function normalizePiPathArgument(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

export interface PiNotificationContext {
  readonly hasUI: boolean;
  readonly ui: {
    notify(message: string, type: "info" | "warning" | "error"): void;
  };
}

export function notifyWhenUiAvailable(
  context: PiNotificationContext,
  message: string,
  type: "info" | "warning" | "error",
): boolean {
  if (!context.hasUI) return false;
  context.ui.notify(message, type);
  return true;
}
