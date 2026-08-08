/**
 * RememberCoordinator — orchestrates the full remember pipeline.
 *
 * Pipeline:
 *   Content Embedding (reused) → CommitSemanticPlanner
 *     (action intent, predicate, subject, type, cardinality, polarity)
 *   → Semantic Scope Ownership Planning → FactIdentityBuilder
 *   → Temporal Planner (inside MemoryService) → Commit → Read-Your-Writes
 *
 * The model only provides `content`. Everything else is system-derived.
 * NO natural-language phrase / regex / keyword rules exist on this path:
 * semantic decisions come from CommitSemanticPlanner (commit-semantics.ts)
 * and ScopeSemanticPlanner (scope-semantics.ts).
 */

import type { EvidenceAuthority } from "@pi-mentis/pi-mentis-core";
import type { EmbeddingVector } from "@pi-mentis/pi-mentis-inference";

import type {
  CommitMemoryCommand,
  MemoryRecord,
  MemoryService,
  PiScopeContext,
  MemoryType,
  TemporalCardinality,
} from "./types.js";
import type { MentisContextSnapshot, EvidenceRef } from "@pi-mentis/pi-mentis-core";

import { shouldReject } from "./secret-detector.js";
import {
  memoryScopeForDecision,
  embedFactContent,
  type ScopeSemanticPlanner,
  type ScopeOwnershipDecision,
} from "./scope-semantics.js";
import {
  type CommitSemanticPlanner,
  type CommitSemanticPlan,
} from "./commit-semantics.js";
import { deriveFactKey as deriveFactKeyNew } from "./fact-key.js";
import type { MemoryDomain } from "./types.js";

// ─── Public Result Type (mirrors pi-extension-support contract) ───

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
  readonly predicate?: string;
  readonly cardinality?: TemporalCardinality;
  readonly normalizedValue?: string;
  readonly setMemberKey?: string;
}

// ─── Request / Context ────────────────────────────────────────────

export interface RememberRequest {
  readonly content: string;
}

export interface RememberExecutionContext {
  readonly scopeContext: PiScopeContext;
  readonly contextSnapshot?: MentisContextSnapshot;
  readonly evidenceRef?: EvidenceRef;
  readonly activeUserPrompt?: string;
  readonly signal?: AbortSignal;
}

// ─── Coordinator Interface ────────────────────────────────────────

export interface RememberCoordinator {
  remember(
    request: RememberRequest,
    context: RememberExecutionContext,
  ): Promise<PublicRememberResult>;
}

// ─── Unified Memory Action ────────────────────────────────────────

export type MemoryAction =
  | "create"
  | "reinforce"
  | "update"
  | "correct"
  | "replace"
  | "retract"
  | "conflict";

/** Maps the semantic planner's action intent onto the coordinator action. */
function actionForIntent(intent: CommitSemanticPlan["actionIntent"]): MemoryAction {
  switch (intent) {
    case "reinforce":
      return "reinforce";
    case "correct":
      return "correct";
    case "replace":
      return "replace";
    case "retract":
      return "retract";
    case "create":
      return "create";
  }
}

// ─── Confidence Inference ────────────────────────────────────────

function inferConfidence(_content: string, decision: ScopeOwnershipDecision): number {
  switch (decision.ownerKind) {
    case "user":
      return clamp01(decision.confidence + 0.15);
    case "project":
    case "repository":
      return clamp01(decision.confidence);
    case "task":
      return clamp01(decision.confidence - 0.05);
    case "topic":
      return clamp01(decision.confidence - 0.1);
  }
}

// ─── Authority Inference ──────────────────────────────────────────

const AUTHORITY_VALUES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;

function clampAuthority(n: number): EvidenceAuthority {
  const clamped = Math.max(10, Math.min(100, Math.round(n / 10) * 10));
  return (
    AUTHORITY_VALUES.includes(clamped as (typeof AUTHORITY_VALUES)[number]) ? clamped : 10
  ) as EvidenceAuthority;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function domainForOwnerKind(ownerKind: ScopeOwnershipDecision["ownerKind"]): MemoryDomain {
  switch (ownerKind) {
    case "user":
      return "user";
    case "project":
    case "repository":
      return "project";
    case "task":
      return "task";
    case "topic":
      return "topic";
  }
}

function inferAuthority(decision: ScopeOwnershipDecision): EvidenceAuthority {
  switch (decision.ownerKind) {
    case "user":
      return clampAuthority(90);
    case "project":
    case "repository":
      return clampAuthority(80);
    case "task":
      return clampAuthority(70);
    case "topic":
      return clampAuthority(60);
  }
}

// ─── Read-Your-Writes Verification ────────────────────────────────

interface CommitConsistency {
  readonly persisted: boolean;
  readonly exactReadable: boolean;
}

async function verifyReadYourWrites(
  memory: MemoryService,
  recordId: string | undefined,
  scopeContext?: PiScopeContext,
): Promise<CommitConsistency> {
  if (recordId === undefined) return { persisted: false, exactReadable: false };
  try {
    const readBack = await memory.get(recordId, {
      ...(scopeContext === undefined ? {} : { scopeContext }),
    });
    return {
      persisted: true,
      exactReadable: readBack !== undefined && readBack.id === recordId,
    };
  } catch {
    return { persisted: false, exactReadable: false };
  }
}

// ─── Public Result Mapping ────────────────────────────────────────

function toPublicResult(
  record: Omit<MemoryRecord, "embedding"> | undefined,
  consistency: CommitConsistency,
  outcome: string,
  predicate?: string,
  cardinality?: TemporalCardinality,
  normalizedValue?: string,
  setMemberKey?: string,
): PublicRememberResult {
  if (!consistency.persisted) {
    return {
      outcome: "unavailable",
      summary: "Pi Mentis is temporarily unavailable.",
      readable: false,
    };
  }

  if (!consistency.exactReadable) {
    return {
      outcome: "pending_review",
      summary: record?.content?.slice(0, 120) ?? "Memory saved, verification pending.",
      readable: false,
    };
  }

  const outcomeMap: Record<string, PublicRememberResult["outcome"]> = {
    created: "remembered",
    reinforced: "reinforced",
    corrected: "updated",
    superseded: "updated",
    rejected_sensitive: "rejected_sensitive",
    rejected: "failed",
    conflict: "pending_review",
  };

  const finalOutcome = outcomeMap[outcome] ?? "remembered";

  return {
    outcome: finalOutcome,
    ...(record?.id !== undefined ? { id: record.id } : {}),
    summary: record?.content
      ? record.content.length > 120
        ? record.content.slice(0, 120) + "..."
        : record.content
      : "Memory committed.",
    readable: true,
    ...(predicate !== undefined ? { predicate } : {}),
    ...(cardinality !== undefined ? { cardinality } : {}),
    ...(normalizedValue !== undefined ? { normalizedValue } : {}),
    ...(setMemberKey !== undefined ? { setMemberKey } : {}),
  };
}

// ─── Implementation ───────────────────────────────────────────────

export class DefaultRememberCoordinator implements RememberCoordinator {
  readonly #memory: MemoryService;
  readonly #scopePlanner: ScopeSemanticPlanner | undefined;
  readonly #commitPlanner: CommitSemanticPlanner | undefined;

  constructor(
    memory: MemoryService,
    scopePlanner?: ScopeSemanticPlanner,
    commitPlanner?: CommitSemanticPlanner,
  ) {
    this.#memory = memory;
    this.#scopePlanner = scopePlanner;
    this.#commitPlanner = commitPlanner;
  }

  async remember(
    request: RememberRequest,
    context: RememberExecutionContext,
  ): Promise<PublicRememberResult> {
    const { content } = request;
    const { scopeContext, evidenceRef, signal } = context;

    // 1. Secret Detection (FIRST, before any processing)
    if (shouldReject(content)) {
      return {
        outcome: "rejected_sensitive",
        summary: "原始凭据不会保存到语义记忆，可以保存安全引用。",
        readable: false,
      };
    }

    // 2. Embed the content ONCE. Both planners reuse the same embedding —
    //    zero additional remote calls on the common path.
    let embedding: EmbeddingVector | undefined;
    const planner = this.#scopePlanner ?? this.#commitPlanner;
    if (planner !== undefined) {
      embedding = await embedFactContent(
        planner.embedding,
        content,
        planner.dimensions,
        signal !== undefined ? { signal } : undefined,
      );
    }

    // 3. Commit Semantic Planning: action intent, predicate, subject, type,
    //    cardinality, polarity. If the planner is unavailable, safe durable
    //    defaults are used (create / fact / single / positive / fallback key).
    let semanticPlan: CommitSemanticPlan;
    if (this.#commitPlanner !== undefined && embedding !== undefined) {
      const provisional = await this.#scopePlanner?.decideOwnership(
        { content, embedding: embedding.values },
        scopeContext,
        signal !== undefined ? { signal } : undefined,
      );
      const provisionalDomain = domainForOwnerKind(provisional?.ownerKind ?? "user");
      semanticPlan = await this.#commitPlanner.plan(
        content,
        embedding.values,
        provisionalDomain,
        signal !== undefined ? { signal } : undefined,
      );
    } else {
      semanticPlan = {
        predicate: undefined,
        predicateConfidence: 0,
        subject: undefined,
        type: "fact",
        cardinality: "single",
        actionIntent: "create",
        polarity: "positive",
        fallbackPredicate: true,
        confidence: 0.3,
        reasons: ["semantic commit planner unavailable; safe defaults"],
        evidence: { degraded: true },
      };
    }
    const action = actionForIntent(semanticPlan.actionIntent);
    const type: MemoryType = semanticPlan.type;

    // 4. Semantic Scope Ownership Planning (reuses the same embedding).
    let decision: ScopeOwnershipDecision;
    if (this.#scopePlanner !== undefined && embedding !== undefined) {
      decision = await this.#scopePlanner.decideOwnership(
        { content, embedding: embedding.values },
        scopeContext,
        signal !== undefined ? { signal } : undefined,
      );
    } else {
      decision = {
        ownerKind: "user",
        ownerId: scopeContext.userId,
        confidence: 0.5,
        reason: "semantic scope planner unavailable; durable default to user",
        evidence: { degraded: true },
      };
    }
    const scope = memoryScopeForDecision(decision, scopeContext);
    const domain = domainForOwnerKind(decision.ownerKind);

    // 5. FactIdentityBuilder — deterministic key from the semantic predicate.
    const factKeyResult = deriveFactKeyNew(content, domain, scopeContext, semanticPlan.predicate);

    // 6. Build commit command (embedding reused — no second remote call)
    const command: CommitMemoryCommand = {
      content,
      type,
      domain,
      scope,
      scopeContext,
      confidence: inferConfidence(content, decision),
      importance: type === "preference" ? 0.8 : 0.5,
      authority: inferAuthority(decision),
      evidenceRefs: evidenceRef !== undefined ? [evidenceRef] : [],
      factKey: factKeyResult.factKey,
      cardinality: semanticPlan.cardinality,
      observedAt: Date.now(),
      contentOrigin: "user",
      ...(embedding === undefined ? {} : { embedding }),
      ...(action === "retract" ? { retractsFact: true } : {}),
      polarity: semanticPlan.polarity,
      semanticIntent: semanticPlan.actionIntent,
      ...(factKeyResult.normalizedValue !== undefined
        ? { normalizedValue: factKeyResult.normalizedValue }
        : {}),
      ...(factKeyResult.setMemberKey !== undefined
        ? { setMemberKey: factKeyResult.setMemberKey }
        : {}),
    };

    try {
      // 7. Commit via MemoryService
      const result = await this.#memory.commit(
        command,
        signal !== undefined ? { signal } : undefined,
      );

      // 8. Read-Your-Writes
      const consistency = await verifyReadYourWrites(this.#memory, result.record?.id, scopeContext);

      // 9. Public result
      return toPublicResult(
        result.record,
        consistency,
        result.outcome,
        result.predicate,
        result.cardinality,
        result.normalizedValue,
        result.setMemberKey,
      );
    } catch (err) {
      if (signal?.aborted) {
        return {
          outcome: "unavailable",
          summary: "Operation cancelled.",
          readable: false,
        };
      }
      return {
        outcome: "failed",
        summary: err instanceof Error ? err.message : "Memory commit failed.",
        readable: false,
      };
    }
  }
}
