/**
 * RememberCoordinator — orchestrates the full remember pipeline.
 *
 * Pipeline:
 *   Normalize Content → Detect Memory Intent → Detect Action
 *   → Detect Predicate → Resolve Scope → Infer Cardinality
 *   → Lookup Existing Exact Facts → Generate Mutation Plan
 *   → Commit → Read-Your-Writes → Public Result
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
import { planScope, detectCorrectionSignal, type MemoryScopePlan } from "./scope-planner.js";
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

// ─── Unified Memory Action ────────────────────────────────────────

export type MemoryAction =
  "create" | "reinforce" | "update" | "correct" | "replace" | "retract" | "conflict";

// ─── Action Planning ──────────────────────────────────────────────

function planAction(content: string): MemoryAction {
  const correction = detectCorrectionSignal(content);

  if (correction.action === "retract") {
    return "retract";
  }

  if (correction.action === "correct") {
    return "correct";
  }

  if (correction.action === "replace") {
    return "replace";
  }

  const lower = content.toLowerCase();

  // Reinforce signals: confirmation / agreement
  if (
    hasPhrase(lower, "对", "没错", "是的", "确认", "还是", "仍然") ||
    /still\b|confirm|yes|indeed/i.test(lower)
  ) {
    return "reinforce";
  }

  return "create";
}

// ─── Chinese-aware phrase matching ────────────────────────────────

function hasPhrase(text: string, ...phrases: string[]): boolean {
  return phrases.some((phrase) => text.includes(phrase));
}

// ─── Type Inference ───────────────────────────────────────────────

function inferType(content: string, action: MemoryAction): MemoryType {
  const lower = content.toLowerCase();

  // Correction/retraction are always facts
  if (action === "correct" || action === "replace" || action === "retract") {
    return "fact";
  }

  // Preferences
  if (
    hasPhrase(lower, "喜欢", "偏好") ||
    /prefer|like|preference|风格|回答.*方式|习惯|通常|一般.*喜欢|说.*方式/i.test(lower)
  ) {
    return "preference";
  }

  // Requirements
  if (hasPhrase(lower, "必须", "一定") || /required|必须|一定|must|require/i.test(lower)) {
    return "requirement";
  }

  // Tasks
  if (
    hasPhrase(lower, "任务", "待办", "目标", "进度", "阻塞") ||
    /todo|task|待办|目标|进度|blocker/i.test(lower)
  ) {
    return "task";
  }

  // Procedural
  if (hasPhrase(lower, "步骤", "流程") || /怎么|how to|procedure|workflow/i.test(lower)) {
    return "procedural";
  }

  // Decisions
  if (hasPhrase(lower, "决定", "架构", "选择") || /decision|架构|architecture/i.test(lower)) {
    return "decision";
  }

  // Build/test/deploy events
  if (
    hasPhrase(lower, "构建", "编译", "测试", "部署", "失败", "成功") ||
    /build|deploy|test|error|fail|success/i.test(lower)
  ) {
    return "episodic";
  }

  return "fact";
}

// ─── Cardinality (predicate-aware + semantic) ─────────────────────

// Single-cardinality predicates (only one current value):
const SINGLE_CARDINALITY_PREDICATES: Set<string> = new Set([
  "assistant_alias",
  "user_name",
  "response_style",
  "language_preference",
  "package_manager_preference",
  "general_package_manager_preference",
  "project_package_manager",
  "project_build_command",
  "project_test_command",
  "project_integration_test_command",
  "project_lint_command",
  "project_typecheck_command",
  "project_format_command",
  "project_database",
  "project_deployment_target",
  "task_goal",
  "task_blocker",
]);

// Set-cardinality predicates (multiple members coexist):
const SET_CARDINALITY_PREDICATES: Set<string> = new Set(["programming_language_preference"]);

function inferCardinality(
  type: MemoryType,
  predicateKey: string | undefined,
  content: string,
): TemporalCardinality {
  // Predicate-based (most specific and reliable)
  if (predicateKey !== undefined) {
    if (SINGLE_CARDINALITY_PREDICATES.has(predicateKey)) return "single";
    if (SET_CARDINALITY_PREDICATES.has(predicateKey)) return "set";
  }

  // Type fallback (only when predicate is unknown)
  if (type === "episodic") return "event";
  if (type === "task") return "event";

  // Semantic detection for set-like content
  const lower = content.toLowerCase();
  if (
    hasPhrase(lower, "也", "还", "另外", "同时") ||
    /也.*喜欢|also|additionally|another/i.test(lower)
  ) {
    return "set";
  }

  return "single";
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

    // 1. Secret Detection (FIRST, before any processing)
    if (shouldReject(content)) {
      return {
        outcome: "rejected_sensitive",
        summary: "原始凭据不会保存到语义记忆，可以保存安全引用。",
        readable: false,
      };
    }

    // 2. Detect Memory Intent → Action
    const action = planAction(content);

    // 3. Detect Predicate (from underlying detection)
    const scopePlan = planScope(content, scopeContext);

    // 4. Resolve Scope
    // Already done in planScope

    // 5. Infer Cardinality (predicate-aware)
    let predicateKey: string | undefined;
    if (scopePlan.reasonCodes.includes("project_config")) {
      predicateKey =
        scopePlan.reasonCodes[0] !== "project_signal" ? scopePlan.reasonCodes[0] : undefined;
    }
    const type = inferType(content, action);

    // 6. Domain Classification
    const domainClassification = classifyDomain(content, type, scopeContext);

    // 7. FactKey Planning
    const factKeyResult = deriveFactKeyService({
      content,
      type,
      domain: domainClassification.domain,
    });

    // 8. Build commit command
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
      cardinality: inferCardinality(type, predicateKey, content),
      observedAt: Date.now(),
      contentOrigin: "user",
      ...(action === "retract" ? { retractsFact: true } : {}),
    };

    try {
      // 9. Commit via MemoryService
      const result = await this.#memory.commit(
        command,
        signal !== undefined ? { signal } : undefined,
      );

      // 10. Read-Your-Writes
      const consistency = await verifyReadYourWrites(this.#memory, result.record?.id);

      // 11. Public result
      return toPublicResult(result.record, consistency, result.outcome);
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
