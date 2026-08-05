/**
 * Memory Tools — Shared Tool Schemas and Facade Interface
 *
 * KEY PRINCIPLE: Tool interfaces express model intent only.
 * The internal system decides how to implement remember/recall.
 *
 * The model provides:
 *   - what to remember (content)
 *   - what to recall (query / id)
 *
 * The model does NOT control:
 *   - MemoryType, MemoryDomain, MemoryScope
 *   - FactKey, Cardinality, Confidence, Importance
 *   - Authority, TemporalState, BranchClaimState
 *   - Supersedes, Conflicts, Applicability, Premises
 *   - Namespace, TopK, Rerank, TemporalMode
 *   - Artifact byte ranges
 *
 * These remain internal domain types but are NOT visible in tool schemas.
 */

import { Type } from "typebox";
import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";

// ─── Public Tool Parameters (model-visible) ────────────────────────

/**
 * commit_memory — the ONLY public parameter is `content`.
 *
 * ```json
 * { "content": "我喜欢回答先给结论，再解释原因" }
 * ```
 */
export const CommitMemoryParameters = Type.Object(
  {
    content: Type.String({
      minLength: 1,
      description:
        "Natural-language information the user wants remembered, updated, corrected, reinforced, or retracted.",
    }),
  },
  {
    additionalProperties: false,
  },
);

/**
 * search_memory — the ONLY public parameters are `query` and `id`.
 *
 * Three modes:
 * - query only: semantic/fact search
 * - id only: exact memory read
 * - id + query: anchored history/evidence search
 */
export const SearchMemoryParameters = Type.Object(
  {
    query: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Natural-language information to recall.",
      }),
    ),
    id: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Optional exact memory ID or anchor memory ID.",
      }),
    ),
  },
  {
    additionalProperties: false,
  },
);

// ─── Public Result Types (model-visible) ───────────────────────────

/** Outcome of a commit_memory call. */
export interface PublicRememberResult {
  readonly outcome:
    | "remembered"
    | "updated"
    | "reinforced"
    | "retracted"
    | "pending_review"
    | "rejected_sensitive"
    | "unavailable"
    | "failed";

  readonly id?: string;
  readonly summary: string;
  readonly readable: boolean;
}

/** A single recall hit in search_memory results. */
export interface PublicRecallHit {
  readonly id: string;
  readonly content: string;

  readonly kind:
    | "user"
    | "agent"
    | "project"
    | "repository"
    | "task"
    | "topic"
    | "event"
    | "procedure"
    | "knowledge";

  readonly status: "current" | "historical" | "conflicted";

  readonly match: "exact" | "profile" | "view" | "lexical" | "semantic" | "anchored";
}

/** Result of a search_memory call. */
export interface PublicRecallResult {
  readonly found: boolean;
  readonly summary?: string;
  readonly hits: readonly PublicRecallHit[];
  readonly traceId?: string;
}

// ─── Tool Descriptions ────────────────────────────────────────────

export const COMMIT_MEMORY_DESCRIPTION =
  "Remember durable information for future sessions. Provide only the natural-language information to remember, update, correct, or forget.";

export const SEARCH_MEMORY_DESCRIPTION =
  "Recall durable user, project, task, topic, event, or procedural context. Provide a natural-language query, an exact memory ID, or both.";

// ─── Facade Interface ─────────────────────────────────────────────

/**
 * MentisToolFacade — stable contract between the shared tool adapter
 * and the extension-specific orchestration implementations.
 *
 * Two extensions (integrated & memory-only) each wire their own Facade.
 * The tool schema, description, and result format are shared.
 */
export interface MentisToolFacade {
  remember(content: string, signal?: AbortSignal): Promise<PublicRememberResult>;

  recall(
    request: { readonly query?: string; readonly id?: string },
    signal?: AbortSignal,
  ): Promise<PublicRecallResult>;
}

// ─── Shared Tool Registration ─────────────────────────────────────

/**
 * Register the commit_memory + search_memory tool pair using the shared
 * schemas, descriptions, and a pluggable Facade.
 *
 * Both integrated and memory-only extensions MUST use this single
 * registration function — no duplicate tool definitions.
 */
export function registerMemoryToolPair(extensionApi: ExtensionAPI, facade: MentisToolFacade): void {
  extensionApi.registerTool({
    name: "commit_memory",
    label: "Remember",
    description: COMMIT_MEMORY_DESCRIPTION,
    parameters: CommitMemoryParameters,
    promptGuidelines: [
      "Use commit_memory for explicit remember/update/forget requests and for durable, verified information that will likely matter in future sessions.",
      "Suitable memories include stable user preferences, project conventions, architectural decisions, and verified reusable solutions.",
      "Do not persist guesses, transient task details, routine outputs, temporary paths, or timestamps unless explicitly requested.",
      "Never submit raw passwords, tokens, API keys, cookies, private keys, or other secrets.",
    ],
    async execute(_toolCallId, toolParams, abortSignal) {
      if (typeof toolParams.content !== "string") {
        throw new Error("commit_memory requires string content");
      }
      const content = toolParams.content.trim();
      if (content.length === 0) {
        throw new Error("commit_memory requires non-empty content");
      }
      const result = await facade.remember(content, abortSignal);
      return toolResult(result);
    },
  });

  extensionApi.registerTool({
    name: "search_memory",
    label: "Recall",
    description: SEARCH_MEMORY_DESCRIPTION,
    parameters: SearchMemoryParameters,
    promptGuidelines: [
      "Use search_memory when the request depends on durable context from earlier sessions that is not already available.",
      "Use it for explicit memory questions, previous work, saved preferences, project history, past decisions, fixes, or task continuation.",
      "Use id for exact retrieval and id plus query for history, evidence, correction, or conflicts.",
      "Do not search automatically at every session start, for trivial queries, or merely to verify a successful commit.",
    ],
    async execute(_toolCallId, toolParams, abortSignal) {
      const query =
        typeof toolParams.query === "string" ? toolParams.query.trim() : undefined;
      const id =
        typeof toolParams.id === "string" ? toolParams.id.trim() : undefined;
      if (query === undefined && id === undefined) {
        throw new Error("search_memory requires query, id, or both");
      }
      const request: { readonly query?: string; readonly id?: string } = {
        ...(query ? { query } : {}),
        ...(id ? { id } : {}),
      };
      const result = await facade.recall(request, abortSignal);
      return toolResult(result);
    },
  });
}

function toolResult(value: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: undefined };
}
