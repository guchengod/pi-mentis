import { normalizeText } from "@pi-mentis/pi-mentis-core";

import type { MemoryDomain, MemoryScope, MemoryType, PiScopeContext } from "./types.js";

// ─── Domain Classification ────────────────────────────────────────

export interface DomainClassification {
  readonly domain: MemoryDomain;
  readonly confidence: number;
  readonly reasons: string[];
}

/**
 * Classify memory content into a domain based on type + content + context.
 * The model does NOT directly set the domain — the system derives it.
 */
export function classifyDomain(
  content: string,
  type: MemoryType,
  scopeContext?: PiScopeContext,
): DomainClassification {
  const normalized = normalizeText(content).toLowerCase();
  const reasons: string[] = [];
  const inRepo = scopeContext?.repositoryId !== undefined || scopeContext?.projectId !== undefined;

  // preference: default to user
  if (type === "preference") {
    // Explicit global/user preference signals
    if (
      hasPhrase(normalized, "不管", "不论", "无论", "个人", "全局") ||
      /global(?:ly)?|always|personally|my (?:personal|own)|in general/i.test(normalized)
    ) {
      reasons.push("explicit global preference signal");
      return { domain: "user", confidence: 0.9, reasons };
    }
    // Project-specific preference signals
    if (
      hasPhrase(normalized, "项目里", "这个项目", "仓库里") ||
      /this project|this repo|code style|format|lint|testing|build|commit|branch|merge/i.test(
        normalized,
      )
    ) {
      reasons.push("project-scoped preference signal");
      return { domain: "project", confidence: 0.85, reasons };
    }
    reasons.push("preference type defaults to user domain");
    return { domain: "user", confidence: 0.75, reasons };
  }

  // procedural: always procedure domain
  if (type === "procedural") {
    reasons.push("procedural type maps to procedure domain");
    return { domain: "procedure", confidence: 0.9, reasons };
  }

  // episodic: always episodic domain
  if (type === "episodic") {
    reasons.push("episodic type maps to episodic domain");
    return { domain: "episodic", confidence: 0.9, reasons };
  }

  // task: always task domain
  if (type === "task") {
    reasons.push("task type maps to task domain");
    return { domain: "task", confidence: 0.9, reasons };
  }

  // fact: classify by content
  if (type === "fact") {
    // User identity / profile facts
    if (
      hasPhrase(normalized, "我叫", "我的名字", "你叫") ||
      /i am|my name|记住你叫|call (?:yourself|me)|your name|称呼|偏好|习惯|喜欢|prefer|style/i.test(
        normalized,
      )
    ) {
      reasons.push("user identity/profile fact");
      return { domain: "user", confidence: 0.85, reasons };
    }
    // Environment facts (runtime, platform, OS — NOT database/project config)
    if (
      hasPhrase(normalized, "运行时", "操作系统", "平台") ||
      /\b(?:runtime|node|deno|bun|operating system|platform|arch|architecture)\b/i.test(normalized)
    ) {
      reasons.push("content matches environment/runtime pattern");
      return { domain: "environment", confidence: 0.8, reasons };
    }
    // Capability facts
    if (
      hasPhrase(normalized, "能力", "可以", "不能", "支持") ||
      /can |cannot |able to|capable of|supports?/i.test(normalized)
    ) {
      reasons.push("capability-related fact");
      return { domain: "capability", confidence: 0.7, reasons };
    }
    // Default: if in repo, project; otherwise topic (NOT unknown-project)
    if (inRepo) {
      reasons.push("fact in repository context defaults to project");
      return { domain: "project", confidence: 0.6, reasons };
    }
    reasons.push("fact outside repo defaults to topic");
    return { domain: "topic", confidence: 0.5, reasons };
  }

  // decision / requirement: project if in repo, else topic
  if (inRepo) {
    reasons.push(`${type} in repository context -> project domain`);
    return { domain: "project", confidence: 0.7, reasons };
  }
  reasons.push(`${type} outside repo -> topic domain`);
  return { domain: "topic", confidence: 0.55, reasons };
}

// ─── Chinese-aware matching ────────────────────────────────────────

function hasPhrase(text: string, ...phrases: string[]): boolean {
  return phrases.some((phrase) => text.includes(phrase));
}

// ─── Scope Resolution ─────────────────────────────────────────────

export interface ScopeResolution {
  readonly scope: MemoryScope;
  readonly confidence: number;
  readonly reasons: string[];
}

/**
 * Resolve the storage scope from the classified domain, content, and context.
 * Scope cannot be directly set by the model.
 *
 * NEVER returns "unknown-project" as a scope ID.
 * No-repo context must fall back to user/task/topic/session, not project.
 */
export function resolveScope(
  domain: MemoryDomain,
  content: string,
  _type: MemoryType,
  scopeContext?: PiScopeContext,
): ScopeResolution {
  const normalized = normalizeText(content).toLowerCase();
  const reasons: string[] = [];
  const inRepo = scopeContext?.repositoryId !== undefined || scopeContext?.projectId !== undefined;

  // Detect explicit global/user preference override
  const explicitGlobal =
    hasPhrase(normalized, "不管", "不论", "无论", "个人", "全局", "这不只") ||
    /global(?:ly)?|always|personally|my (?:personal|own)|in general|not (?:just|only) (?:this|the) (?:project|repo)/i.test(
      normalized,
    );

  switch (domain) {
    case "user": {
      reasons.push("user domain -> user scope");
      return {
        scope: { kind: "user", id: scopeContext?.userId ?? "local" },
        confidence: 0.9,
        reasons,
      };
    }

    case "project":
    case "environment":
    case "procedure": {
      // Explicit global preference signals override project context
      if (explicitGlobal) {
        reasons.push("explicit global preference overrides project context -> user scope");
        return {
          scope: { kind: "user", id: scopeContext?.userId ?? "local" },
          confidence: 0.85,
          reasons,
        };
      }

      // Require real repository/project context for project scope
      if (scopeContext?.repositoryId !== undefined) {
        reasons.push(`using repository scope: ${scopeContext.repositoryId}`);
        return {
          scope: { kind: "repository", id: scopeContext.repositoryId },
          confidence: 0.85,
          reasons,
        };
      }
      if (scopeContext?.projectId !== undefined) {
        reasons.push(`using project scope: ${scopeContext.projectId}`);
        return {
          scope: { kind: "project", id: scopeContext.projectId },
          confidence: 0.8,
          reasons,
        };
      }
      // No repository/project context -> user scope (never "unknown-project")
      reasons.push("no project/repository context, fallback to user scope");
      return {
        scope: { kind: "user", id: scopeContext?.userId ?? "local" },
        confidence: 0.5,
        reasons,
      };
    }

    case "capability": {
      reasons.push("capability domain -> user scope");
      return {
        scope: { kind: "user", id: scopeContext?.userId ?? "local" },
        confidence: 0.8,
        reasons,
      };
    }

    case "task": {
      if (scopeContext?.taskId !== undefined) {
        reasons.push(`task domain -> task scope: ${scopeContext.taskId}`);
        return {
          scope: { kind: "task", id: scopeContext.taskId },
          confidence: 0.85,
          reasons,
        };
      }
      reasons.push("task domain without active task -> user scope");
      return {
        scope: { kind: "user", id: scopeContext?.userId ?? "local" },
        confidence: 0.5,
        reasons,
      };
    }

    case "topic": {
      if (scopeContext?.topicIds !== undefined && scopeContext.topicIds.length > 0) {
        const topicId = scopeContext.topicIds[0];
        if (topicId !== undefined) {
          reasons.push(`topic domain -> existing topic scope: ${topicId}`);
          return {
            scope: { kind: "topic", id: topicId },
            confidence: 0.7,
            reasons,
          };
        }
      }
      reasons.push("topic domain without active topic -> user scope fallback");
      return {
        scope: { kind: "user", id: scopeContext?.userId ?? "local" },
        confidence: 0.4,
        reasons,
      };
    }

    case "episodic": {
      if (scopeContext?.repositoryId !== undefined) {
        reasons.push("episodic in repo -> repository scope");
        return {
          scope: { kind: "repository", id: scopeContext.repositoryId },
          confidence: 0.8,
          reasons,
        };
      }
      if (scopeContext?.projectId !== undefined) {
        reasons.push("episodic in project -> project scope");
        return {
          scope: { kind: "project", id: scopeContext.projectId },
          confidence: 0.75,
          reasons,
        };
      }
      reasons.push("episodic without repo -> user scope");
      return {
        scope: { kind: "user", id: scopeContext?.userId ?? "local" },
        confidence: 0.6,
        reasons,
      };
    }

    default: {
      reasons.push("unknown domain -> user scope fallback");
      return {
        scope: { kind: "user", id: scopeContext?.userId ?? "local" },
        confidence: 0.3,
        reasons,
      };
    }
  }
}

// ─── Cardinality Defaults ─────────────────────────────────────────

// Single-cardinality predicates
const SINGLE_PREDICATE_SET: Set<string> = new Set([
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

function defaultCardinality(
  type: MemoryType,
  _predicateKey?: string,
): "single" | "set" | "ordered" | "event" {
  // Type-based fallback is only for event/episodic/task
  if (type === "episodic" || type === "task") return "event";
  return "single";
}

// ─── Commit Planner ───────────────────────────────────────────────

export interface CommitPlanClassificationTrace {
  readonly domainConfidence: number;
  readonly scopeConfidence: number;
  readonly reasons: string[];
}

export interface CommitPlan {
  readonly domain: MemoryDomain;
  readonly scope: MemoryScope;
  readonly cardinality: "single" | "set" | "ordered" | "event";
  readonly classificationTrace: CommitPlanClassificationTrace;
}

/**
 * Plan a memory commit: classify domain, resolve scope, determine cardinality.
 * The model does NOT directly control domain, scope, cardinality, or factKey.
 */
export function planCommit(
  content: string,
  type: MemoryType,
  scopeContext?: PiScopeContext,
  overrides?: {
    readonly domain?: MemoryDomain | undefined;
    readonly scope?: MemoryScope | undefined;
  },
): CommitPlan {
  const domainResult = overrides?.domain
    ? { domain: overrides.domain, confidence: 1.0, reasons: ["explicit domain override"] }
    : classifyDomain(content, type, scopeContext);

  const scopeResult = overrides?.scope
    ? { scope: overrides.scope, confidence: 1.0, reasons: ["explicit scope override"] }
    : resolveScope(domainResult.domain, content, type, scopeContext);

  // Ensure user domain forces user scope
  const finalScope =
    domainResult.domain === "user" && scopeResult.scope.kind !== "user"
      ? { kind: "user" as const, id: scopeContext?.userId ?? "local" }
      : scopeResult.scope;

  const finalScopeReasons =
    finalScope.kind !== scopeResult.scope.kind
      ? [...scopeResult.reasons, "overridden: user domain forces user scope"]
      : scopeResult.reasons;

  return {
    domain: domainResult.domain,
    scope: finalScope,
    cardinality: defaultCardinality(type),
    classificationTrace: {
      domainConfidence: domainResult.confidence,
      scopeConfidence: scopeResult.confidence,
      reasons: [...domainResult.reasons, ...finalScopeReasons],
    },
  };
}

// ─── Event Fingerprint ────────────────────────────────────────────

export interface EventFingerprint {
  readonly normalizedContent: string;
  readonly observedAt: number;
  readonly sourceEventId?: string | undefined;
}

export function eventFingerprint(candidate: {
  readonly normalizedContent: string;
  readonly observedAt: number;
  readonly sourceEventId?: string;
}): EventFingerprint {
  return {
    normalizedContent: candidate.normalizedContent,
    observedAt: candidate.observedAt,
    sourceEventId: candidate.sourceEventId,
  };
}

export function sameEventFingerprint(a: EventFingerprint, b: EventFingerprint): boolean {
  if (
    a.sourceEventId !== undefined &&
    b.sourceEventId !== undefined &&
    a.sourceEventId === b.sourceEventId
  ) {
    return true;
  }
  if (
    a.normalizedContent === b.normalizedContent &&
    Math.abs(a.observedAt - b.observedAt) <= 1_000
  ) {
    return true;
  }
  return false;
}
