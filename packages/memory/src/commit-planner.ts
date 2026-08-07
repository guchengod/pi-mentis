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
 *
 * Ownership-first: the domain is driven by the semantic scope ownership
 * decision; this classifier only maps MEMORY TYPE to a domain and never
 * reads natural-language content via phrases. Generic durable facts
 * default to USER domain, never the active topic.
 */
export function classifyDomain(
  content: string,
  type: MemoryType,
  scopeContext?: PiScopeContext,
): DomainClassification {
  void content;
  void scopeContext;
  const reasons: string[] = [];

  // preference: default to user
  if (type === "preference") {
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

  // fact / decision / requirement: generic durable facts belong to the
  // user. Narrower domains come from the semantic scope ownership decision.
  reasons.push("generic durable fact defaults to user domain");
  return { domain: "user", confidence: 0.65, reasons };
}

// ─── Scope Resolution ─────────────────────────────────────────────

export interface ScopeResolution {
  readonly scope: MemoryScope;
  readonly confidence: number;
  readonly reasons: string[];
}

/**
 * Resolve the storage scope from the classified domain and active context.
 * The active context only supplies candidate owner ids — it never decides
 * the owner kind. No natural-language content is read.
 *
 * NEVER returns "unknown-project" as a scope ID.
 * No-repo context must fall back to user/task/topic/session, not project.
 */
export function resolveScope(
  domain: MemoryDomain,
  _content: string,
  _type: MemoryType,
  scopeContext?: PiScopeContext,
): ScopeResolution {
  const reasons: string[] = [];

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

function defaultCardinality(type: MemoryType): "single" | "set" | "ordered" | "event" {
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
