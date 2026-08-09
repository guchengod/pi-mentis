import type {
  EvidenceAuthority,
  EvidenceRef,
  MentisContextSnapshot,
} from "@pi-mentis/pi-mentis-core";
import type { EmbeddingVector } from "@pi-mentis/pi-mentis-inference";

import { shouldReject } from "./secret-detector.js";
import {
  embedFactContent,
  memoryScopeForDecision,
  type ScopeOwnershipDecision,
  type ScopeSemanticPlanner,
} from "./scope-semantics.js";
import type {
  CommitMemoryResult,
  MemoryRelationship,
  MemoryService,
  PiScopeContext,
} from "./types.js";

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
  readonly recallable: boolean;
  readonly relationDecision?: MemoryRelationship;
  readonly traceId?: string;
  readonly reason?: string;
}

export interface RememberRequest {
  readonly content: string;
}

export interface RememberExecutionContext {
  readonly scopeContext: PiScopeContext;
  readonly contextSnapshot?: MentisContextSnapshot;
  readonly evidenceRef?: EvidenceRef;
  readonly activeUserPrompt?: string;
  /** Internal observer used to schedule slow relationship consolidation. */
  readonly onCommitted?: (result: CommitMemoryResult) => void;
  readonly signal?: AbortSignal;
}

export interface RememberCoordinator {
  remember(
    request: RememberRequest,
    context: RememberExecutionContext,
  ): Promise<PublicRememberResult>;
}

const AUTHORITY_VALUES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;

function clampAuthority(value: number): EvidenceAuthority {
  const clamped = Math.max(10, Math.min(100, Math.round(value / 10) * 10));
  return (
    AUTHORITY_VALUES.includes(clamped as (typeof AUTHORITY_VALUES)[number]) ? clamped : 10
  ) as EvidenceAuthority;
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

function confidence(decision: ScopeOwnershipDecision): number {
  return Math.max(
    0,
    Math.min(1, decision.ownerKind === "user" ? decision.confidence + 0.15 : decision.confidence),
  );
}

async function verifyReadYourWrites(
  memory: MemoryService,
  id: string | undefined,
  scopeContext: PiScopeContext,
): Promise<boolean> {
  if (id === undefined) return false;
  try {
    return (await memory.get(id, { scopeContext, accessIntent: "explicit_id" }))?.id === id;
  } catch {
    return false;
  }
}

function publicResult(result: CommitMemoryResult, readable: boolean): PublicRememberResult {
  if (!readable || result.record === undefined) {
    return {
      outcome: "pending_review",
      summary: "记忆已保存，但读回校验未通过，请稍后按 ID 重试。",
      readable: false,
      recallable: false,
      ...(result.record?.id === undefined ? {} : { id: result.record.id }),
      relationDecision: result.relationDecision,
      ...(result.traceId === undefined ? {} : { traceId: result.traceId }),
      reason: "read_back_unverified",
    };
  }
  const mapped: PublicRememberResult["outcome"] =
    result.outcome === "reinforced"
      ? "reinforced"
      : result.outcome === "superseded" || result.outcome === "corrected"
        ? "updated"
        : result.outcome === "retracted"
          ? "retracted"
          : result.outcome === "conflict"
            ? "pending_review"
            : "remembered";
  return {
    outcome: mapped,
    id: result.record.id,
    summary:
      result.record.content.length > 120
        ? `${result.record.content.slice(0, 120)}...`
        : result.record.content,
    readable: true,
    recallable: result.record.status === "active",
    relationDecision: result.relationDecision,
    ...(result.traceId === undefined ? {} : { traceId: result.traceId }),
    ...(mapped === "pending_review" ? { reason: "relationship_conflict" } : {}),
  };
}

export class DefaultRememberCoordinator implements RememberCoordinator {
  readonly #memory: MemoryService;
  readonly #scopePlanner: ScopeSemanticPlanner | undefined;

  constructor(memory: MemoryService, scopePlanner?: ScopeSemanticPlanner) {
    this.#memory = memory;
    this.#scopePlanner = scopePlanner;
  }

  async remember(
    request: RememberRequest,
    context: RememberExecutionContext,
  ): Promise<PublicRememberResult> {
    const { content } = request;
    const { scopeContext, evidenceRef, signal } = context;
    if (shouldReject(content)) {
      return {
        outcome: "rejected_sensitive",
        summary: "原始凭据不会保存到语义记忆，可以保存安全引用。",
        readable: false,
        recallable: false,
        reason: "rejected_sensitive",
      };
    }

    let embedding: EmbeddingVector | undefined;
    let decision: ScopeOwnershipDecision;
    if (this.#scopePlanner !== undefined) {
      embedding = await embedFactContent(
        this.#scopePlanner.embedding,
        content,
        this.#scopePlanner.dimensions,
        signal === undefined ? undefined : { signal },
      );
      decision = await this.#scopePlanner.decideOwnership(
        { content, embedding: embedding.values },
        scopeContext,
        signal === undefined ? undefined : { signal },
      );
    } else {
      decision = {
        ownerKind: "user",
        ownerId: scopeContext.userId,
        confidence: 0.5,
        reason: "scope planner unavailable; durable user scope fallback",
        evidence: { degraded: true },
      };
    }
    const scope = memoryScopeForDecision(decision, scopeContext);
    try {
      const result = await this.#memory.commit(
        {
          content,
          scope,
          scopeContext,
          confidence: confidence(decision),
          importance: 0.5,
          authority: inferAuthority(decision),
          evidenceRefs: evidenceRef === undefined ? [] : [evidenceRef],
          observedAt: Date.now(),
          provenance: {
            origin: "user",
            epistemicState: "asserted",
            ...(scopeContext.branchId === undefined ? {} : { branchId: scopeContext.branchId }),
          },
          ...(embedding === undefined ? {} : { embedding }),
        },
        signal === undefined ? undefined : { signal },
      );
      context.onCommitted?.(result);
      const readable = await verifyReadYourWrites(this.#memory, result.record?.id, scopeContext);
      return publicResult(result, readable);
    } catch (error: unknown) {
      return {
        outcome: signal?.aborted === true ? "unavailable" : "failed",
        summary: error instanceof Error ? error.message : "Memory commit failed.",
        readable: false,
        recallable: false,
        reason: signal?.aborted === true ? "cancelled" : "commit_failed",
      };
    }
  }
}
