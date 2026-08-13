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
 *   - ownership scope, confidence, importance, or authority
 *   - temporal transitions, relationships, provenance, or runtime constraints
 *   - Namespace, TopK, Rerank, TemporalMode
 *   - Artifact byte ranges
 *
 * These remain internal domain types but are NOT visible in tool schemas.
 */

import { Type } from "typebox";
import type {
  ExtensionAPI,
  AgentToolResult,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const MENTIS_MEMORY_SYSTEM_PROMPT = `<pi-mentis-tools>
For unknown, uncertain, historical, indexed, or context-missing information, call search_memory before guessing; use commit_memory only for explicit requests or durable verified facts.
</pi-mentis-tools>`;

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
        description: "Optional exact Mentis memory, artifact, or evidence ID.",
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
  /**
   * True only when the memory is immediately available to normal recall.
   * `pending_review` records are persisted but NOT recallable until the
   * conflict lifecycle resolves them.
   */
  readonly recallable?: boolean;
  /** Machine-readable reason for non-recallable outcomes. */
  readonly reason?: string;
  readonly relationDecision?:
    "reinforce" | "supersede" | "retract" | "conflict" | "coexist" | "unrelated" | "uncertain";
  readonly traceId?: string;
  /** Distinguishes the write-fast safe relation from worker-consolidated evidence. */
  readonly relationshipState?: "provisional" | "consolidated";
  /** The raw memory is readable; pairwise relationship learning continues off the write path. */
  readonly relationshipLearning?: "scheduled";
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
    | "knowledge"
    | "artifact";

  readonly status: "current" | "historical" | "conflicted";

  readonly match: "exact" | "profile" | "view" | "lexical" | "semantic" | "anchored";

  readonly resourceType: "memory" | "artifact" | "evidence" | "search" | "unknown";
  readonly sanitized: boolean;
  /** Session-only projection metadata. Persistent status remains authoritative. */
  readonly provisional?: boolean;
  readonly projection?: "provisional_latest" | "shadowed_by_pending";
  readonly shadowedByPendingId?: string;
  readonly artifactChunkIndex?: number;
  readonly byteStart?: number;
  readonly byteEnd?: number;
}

/** Result of a search_memory call. */
export interface PublicRecallResult {
  readonly found: boolean;
  /** Exact/anchored entity resolution, independent from content matching. */
  readonly entityFound?: boolean;
  /** Whether this lookup returned content that directly matched the request. */
  readonly contentFound?: boolean;
  readonly lookupMode?: "exact_id" | "anchored_query" | "global_query";
  readonly artifactId?: string;
  readonly resourceType: "memory" | "artifact" | "evidence" | "search" | "unknown";
  readonly anchored: boolean;
  readonly reason?:
    | "not_found"
    | "scope_denied"
    | "not_ready"
    | "expired"
    | "failed"
    | "ambiguous"
    | "unavailable"
    | "invalid_memory_id"
    | "no_direct_memory_support";
  readonly summary?: string;
  readonly hits: readonly PublicRecallHit[];
  readonly traceId?: string;
  /** Present only while pairwise consolidation for a relevant recent assertion is pending. */
  readonly consistency?: "pending_relationship";
  readonly provisionalLatestId?: string;
  readonly pendingRelationshipIds?: readonly string[];
  readonly supportLevel?: "direct" | "related" | "weak" | "none";
  readonly noDirectSupport?: boolean;
  readonly alreadySearchedThisTurn?: boolean;
  readonly searchLimitReachedThisTurn?: boolean;
  readonly diagnostics?: Readonly<{
    readonly durationMs?: number;
    readonly stages?: Readonly<Record<string, number>>;
    readonly candidateCount?: number;
    readonly selectedHitCount?: number;
    readonly returnedBytes?: number;
    readonly estimatedReturnedTokens?: number;
    readonly artifact?: Readonly<{
      readonly artifactBytes: number;
      readonly chunksScanned: number;
      readonly bytesRead: number;
      readonly returnedBytes: number;
      readonly estimatedReturnedTokens: number;
    }>;
  }>;
}

/** Public memory IDs are the exact lowercase SHA-256-shaped IDs returned by Mentis. */
export function isValidPublicMemoryId(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
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
  remember(
    content: string,
    signal?: AbortSignal,
    context?: ExtensionContext,
  ): Promise<PublicRememberResult>;

  recall(
    request: { readonly query?: string; readonly id?: string },
    signal?: AbortSignal,
    context?: ExtensionContext,
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
    executionMode: "parallel",
    promptGuidelines: [
      "Use commit_memory for explicit remember/update/forget requests and for durable, verified information that will likely matter in future sessions.",
      "For an update, correction, or retraction, first use search_memory in the same turn to retrieve the concrete prior record, then call commit_memory with only the new natural-language assertion.",
      "Suitable memories include stable user preferences (nicknames, aliases, response styles), project conventions (package manager, build commands, test commands, database), architectural decisions, and verified reusable solutions.",
      "Do not persist guesses, transient task details, routine outputs, temporary paths, or timestamps unless explicitly requested.",
      "Never submit raw passwords, tokens, API keys, cookies, private keys, or other secrets.",
      "The system first preserves correction and retraction statements as raw memories. Background pairwise reasoning prioritizes concrete records recalled in this turn and may review one strong semantic candidate; similarity alone never changes state, and uncertain relationships safely coexist.",
      'An outcome of "remembered" / "reinforced" / "updated" means the information is a normal, recallable memory. An outcome of "pending_review" means the information was SAVED as a review candidate (conflicted) but is NOT yet available to normal recall — do not tell the user it has been remembered as usable memory; report it as pending review.',
      'An outcome of "retracted" means the information was successfully removed from current preferences. The summary field will accurately describe what happened — your response to the user MUST be consistent with the outcome and summary fields. Do not claim a fact was removed if the outcome is "reinforced", and do not claim it was kept if the outcome is "retracted".',
      'If relationshipLearning is "scheduled", the new assertion is already saved and readable, while its relationship to a concrete prior candidate is being consolidated asynchronously. Do not claim the prior record has already changed state.',
      "If the user asks to replace, correct, or retract a fact but the outcome is 'reinforced' (meaning the system did not apply the change), do NOT retry the commit with different wording, do NOT call forget, and do NOT attempt to modify the database yourself. Report to the user that the memory system did not apply the requested change and the previous fact remains as-is.",
      "A semantic search returning no hits does NOT prove the information was never stored. It only means the current query did not retrieve it. Never tell the user 'this is not in long-term memory' solely because search_memory returned no results. Instead say 'the current search did not retrieve it'. Use an exact ID lookup if you need to verify storage existence.",
    ],
    async execute(_toolCallId, toolParams, abortSignal, _onUpdate, context) {
      if (typeof toolParams.content !== "string") {
        throw new Error("commit_memory requires string content");
      }
      const content = toolParams.content.trim();
      if (content.length === 0) {
        throw new Error("commit_memory requires non-empty content");
      }
      const result = await facade.remember(content, abortSignal, context);
      return toolResult(result);
    },
  });

  extensionApi.registerTool({
    name: "search_memory",
    label: "Recall",
    description: SEARCH_MEMORY_DESCRIPTION,
    parameters: SearchMemoryParameters,
    executionMode: "parallel",
    promptGuidelines: [
      "Use search_memory when the request depends on durable context from earlier sessions that is not already available.",
      "Use it for explicit memory questions, previous work, saved preferences, project history, past decisions, fixes, or task continuation.",
      "When the user pastes a Mentis-returned record ID and asks about its content, history, corrections, or evidence, use search_memory with the id parameter for anchored retrieval.",
      "A Mentis memory ID is exactly 64 lowercase hexadecimal characters and must have been returned by Mentis. Short opaque labels and arbitrary alphanumeric tokens are ordinary content, not memory IDs.",
      "Use id for exact retrieval and id plus query for history, evidence, correction, or conflicts.",
      "Do not search automatically at every session start, for trivial queries, or merely to verify a successful commit.",
      'A semantic query search miss does not prove a memory was never stored. If storage existence matters and an exact ID is available, use ID lookup. Otherwise state only that the current search did not retrieve it — never claim "it was not written" solely because a query search returned no results.',
      'When consistency is "pending_relationship", prefer the hit marked projection="provisional_latest" for the user\'s immediate current-session answer, but keep the other returned hits as persistent evidence until relationship consolidation resolves. Do not claim any persistent status has already changed.',
      "When noDirectSupport is true, the retrieved memories do not directly answer the requested fact. If alreadySearchedThisTurn is also true, stop reformulating the same query and answer that current memory has insufficient information.",
      "For exact ID lookups, entityFound reports whether the entity exists and contentFound reports whether matching content was returned. Do not treat entityFound=true as an ID lookup failure merely because contentFound=false.",
      "An ID-only lookup resolves the entity and its metadata. To recover a specific artifact detail, keep the same id and add a focused query so Mentis searches that artifact's chunks.",
      "Once an ID is used in a user turn, Mentis keeps subsequent recall calls in that turn anchored to the same entity. If anchored content is not found, report that scope-local miss instead of attempting a global fallback.",
    ],
    async execute(_toolCallId, toolParams, abortSignal, _onUpdate, context) {
      const query = typeof toolParams.query === "string" ? toolParams.query.trim() : undefined;
      const id = typeof toolParams.id === "string" ? toolParams.id.trim() : undefined;
      if (query === undefined && id === undefined) {
        throw new Error("search_memory requires query, id, or both");
      }
      if (id !== undefined && !isValidPublicMemoryId(id)) {
        if (query === undefined) {
          return toolResult({
            found: false,
            entityFound: false,
            contentFound: false,
            lookupMode: "exact_id",
            resourceType: "unknown",
            anchored: true,
            reason: "invalid_memory_id",
            summary:
              "The supplied token is not a Mentis resource ID. Treat it as ordinary user content rather than an ID.",
            hits: [],
            supportLevel: "none",
            noDirectSupport: true,
          } satisfies PublicRecallResult);
        }
      }
      const request: { readonly query?: string; readonly id?: string } = {
        ...(query ? { query } : {}),
        ...(id && isValidPublicMemoryId(id) ? { id } : {}),
      };
      const result = await facade.recall(request, abortSignal, context);
      return toolResult(result);
    },
  });
}

function toolResult(value: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: undefined };
}
