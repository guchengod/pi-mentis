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

// ─── Content Type Detection ──────────────────────────────────────

export type ToolOutputContentType =
  "json" | "jsonl" | "text" | "build_log" | "test_log" | "diff" | "unknown";

export function detectContentType(text: string): ToolOutputContentType {
  try {
    JSON.parse(text);
    return "json";
  } catch {
    // not valid JSON, continue
  }

  const lines = text.trim().split("\n");
  if (
    lines.length >= 2 &&
    lines.every((line) => {
      try {
        JSON.parse(line);
        return true;
      } catch {
        return false;
      }
    })
  ) {
    return "jsonl";
  }

  const head = text.slice(0, 500).toLowerCase();
  if (/error|warning|build|compile|tsc|eslint/i.test(head)) return "build_log";
  if (/test|suite|spec|pass|fail|assert/i.test(head)) return "test_log";
  if (/^[+-]{3}|^@@\s|^diff\s/i.test(head)) return "diff";

  return "text";
}

// ─── Tool Business Error ─────────────────────────────────────────

export interface ToolBusinessError {
  readonly code: string;
  readonly message: string;
}

export interface SymbolicToolResult {
  readonly mode: "inline" | "truncated" | "offloaded";
  readonly contentType: ToolOutputContentType;
  readonly originalBytes: number;
  readonly shownBytes: number;
  readonly summary?: string;
  readonly preview?: string;
  readonly artifactId?: string;
  readonly artifactReadable: boolean;
  readonly keyErrors: readonly ToolBusinessError[];
  readonly parserWarnings: readonly string[];
}

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
  uiContext: PiNotificationContext,
  uiMessage: string,
  uiType: "info" | "warning" | "error",
): boolean {
  if (!uiContext.hasUI) return false;
  uiContext.ui.notify(uiMessage, uiType);
  return true;
}

// ─── Memory Tool Schemas (shared between extensions) ──────────────

export {
  CommitMemoryParameters,
  SearchMemoryParameters,
  COMMIT_MEMORY_DESCRIPTION,
  SEARCH_MEMORY_DESCRIPTION,
  registerMemoryToolPair,
  type PublicRememberResult,
  type PublicRecallHit,
  type PublicRecallResult,
  type MentisToolFacade,
} from "./memory-tools.js";
export {
  createPiPairwiseRelationshipReasoner,
  type PiPairwiseRelationshipJudgment,
  type PiPairwiseRelationshipReasoner,
  type PiRecalledMemoryEvidence,
} from "./pairwise-memory-reasoner.js";
export {
  RecentAssertionOverlay,
  type RecentAssertion,
  type RecentAssertionOverlayOptions,
} from "./recent-assertion-overlay.js";
