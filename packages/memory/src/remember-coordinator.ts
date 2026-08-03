/**
 * RememberCoordinator — orchestrates the full remember pipeline.
 *
 * Pipeline:
 *   Normalize → Secret Detection → Memory Action Planning
 *   → Type Inference → Domain Planning → Scope Planning
 *   → FactKey Planning → Commit → Read-Your-Writes → Public Result
 *
 * The model only provides `content`. Everything else is system-derived.
 */

import type { EvidenceAuthority } from "@pi-mentis/pi-mentis-core";

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
import { planScope, type MemoryScopePlan } from "./scope-planner.js";
import { classifyDomain } from "./commit-planner.js";
import { deriveFactKey as deriveFactKeyService } from "./service.js";

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

// ─── Action Planning ──────────────────────────────────────────────

type MemoryAction = "create" | "update" | "correct" | "reinforce" | "retract";

function planAction(content: string): MemoryAction {
  const lower = content.toLowerCase();

  if (
    /刚才说|说错了|不是.*应该是|正确.*是|不对.*是|纠正|改正|更正|修正|之前.*错|不小心说|actually|sorry.*meant|更正.*之前/.test(
      lower,
    )
  ) {
    return "correct";
  }

  if (/忘掉|删除.*记忆|清除|forget|remove.*memory|撤销|不记得/.test(lower)) {
    return "retract";
  }

  if (/对.*还是|确认|没错|还是.*对|still\b|confirm|没错|是的/.test(lower)) {
    return "reinforce";
  }

  return "create";
}

// ─── Type Inference ───────────────────────────────────────────────

function inferType(content: string): MemoryType {
  const lower = content.toLowerCase();

  if (
    /喜欢|偏好|prefer|like|preference|风格|回答.*方式|习惯|通常|一般.*喜欢|说.*方式/.test(lower)
  ) {
    return "preference";
  }

  if (/必须|一定|required|required|要求|must|require/.test(lower)) {
    return "requirement";
  }

  if (/构建|编译|测试|部署|失败|成功|错误|error|fail|success|build|deploy|test/.test(lower)) {
    return "episodic";
  }

  if (/任务|todo|task|待办|目标|进度|blocker|阻塞/.test(lower)) {
    return "task";
  }

  if (/步骤|流程|怎么|how to|procedure|workflow/.test(lower)) {
    return "procedural";
  }

  if (/决定|decision|选择|架构|architecture/.test(lower)) {
    return "decision";
  }

  return "fact";
}

// ─── Confidence Inference ────────────────────────────────────────

function inferConfidence(_content: string, scopePlan: MemoryScopePlan): number {
  if (scopePlan.reasonCodes.includes("user_identity")) return 0.9;
  if (scopePlan.reasonCodes.includes("agent_profile")) return 0.9;
  if (scopePlan.reasonCodes.includes("user_preference")) return 0.85;
  if (scopePlan.reasonCodes.includes("project_config")) return 0.8;
  if (scopePlan.reasonCodes.includes("correction_needs_existing_fact_lookup")) return 0.6;
  return Math.min(0.85, Math.max(0.4, scopePlan.confidence));
}

// ─── Authority Inference ──────────────────────────────────────────

const AUTHORITY_VALUES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;

function clampAuthority(n: number): EvidenceAuthority {
  const clamped = Math.max(10, Math.min(100, Math.round(n / 10) * 10));
  return (
    AUTHORITY_VALUES.includes(clamped as (typeof AUTHORITY_VALUES)[number]) ? clamped : 10
  ) as EvidenceAuthority;
}

function inferAuthority(scopePlan: MemoryScopePlan): EvidenceAuthority {
  if (scopePlan.reasonCodes.some((rc) => rc.startsWith("user_"))) return clampAuthority(90);
  if (scopePlan.reasonCodes.some((rc) => rc.startsWith("agent_"))) return clampAuthority(85);
  if (scopePlan.reasonCodes.includes("project_config")) return clampAuthority(80);
  if (scopePlan.reasonCodes.includes("task_state")) return clampAuthority(70);
  return clampAuthority(50);
}

// ─── Cardinality ─────────────────────────────────────────────────

function inferCardinality(type: MemoryType): TemporalCardinality {
  if (type === "episodic") return "event";
  if (type === "task") return "event";
  if (type === "preference") return "set";
  if (type === "procedural") return "set";
  return "single";
}

// ─── Read-Your-Writes Verification ────────────────────────────────

interface CommitConsistency {
  readonly persisted: boolean;
  readonly exactReadable: boolean;
}

async function verifyReadYourWrites(
  memory: MemoryService,
  recordId: string | undefined,
): Promise<CommitConsistency> {
  if (recordId === undefined) return { persisted: false, exactReadable: false };
  try {
    const readBack = await memory.get(recordId);
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
  _action: MemoryAction,
  outcome: string,
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
  };
}

// ─── Implementation ───────────────────────────────────────────────

export class DefaultRememberCoordinator implements RememberCoordinator {
  readonly #memory: MemoryService;

  constructor(memory: MemoryService) {
    this.#memory = memory;
  }

  async remember(
    request: RememberRequest,
    context: RememberExecutionContext,
  ): Promise<PublicRememberResult> {
    const { content } = request;
    const { scopeContext, evidenceRef, signal } = context;

    // 1. Secret Detection
    if (shouldReject(content)) {
      return {
        outcome: "rejected_sensitive",
        summary: "原始凭据不会保存到语义记忆，可以保存安全引用。",
        readable: false,
      };
    }

    // 2. Memory Action Planning
    const action = planAction(content);

    // 3. Type Inference
    const type = inferType(content);

    // 4. Scope Planning
    const scopePlan = planScope(content, scopeContext);

    // 5. Domain Classification
    const domainClassification = classifyDomain(content, type, scopeContext);

    // 6. FactKey Planning (via service bridge)
    const factKeyResult = deriveFactKeyService({
      content,
      type,
      domain: domainClassification.domain,
    });

    // 7. Build commit command
    const command: CommitMemoryCommand = {
      content,
      type,
      domain: domainClassification.domain,
      scope: scopePlan.scope,
      scopeContext,
      confidence: inferConfidence(content, scopePlan),
      importance: type === "preference" ? 0.8 : 0.5,
      authority: inferAuthority(scopePlan),
      evidenceRefs: evidenceRef !== undefined ? [evidenceRef] : [],
      factKey: factKeyResult,
      cardinality: inferCardinality(type),
      observedAt: Date.now(),
      contentOrigin: "user",
    };

    try {
      // 8. Commit via MemoryService
      const result = await this.#memory.commit(
        command,
        signal !== undefined ? { signal } : undefined,
      );

      // 9. Read-Your-Writes
      const consistency = await verifyReadYourWrites(this.#memory, result.record?.id);

      // 10. Public result
      return toPublicResult(result.record, consistency, action, result.outcome);
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
