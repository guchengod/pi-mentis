/**
 * ScopePlanner — determines MemoryScope from natural-language content + context.
 *
 * The model does NOT provide scopeKind / scopeId. The system derives them.
 *
 * Rules cover:
 *   - User / Agent Profile (always user scope)
 *   - Repository / Project facts (repo scope preferred)
 *   - Task / Episodic (task/event scope)
 *   - Low-confidence fallback: narrower scope, never promote to user global
 */

import { normalizeText } from "@pi-mentis/pi-mentis-core";

import type { MemoryDomain, MemoryScope, PiScopeContext } from "./types.js";

// ─── Scope Plan ───────────────────────────────────────────────────

export interface MemoryScopePlan {
  readonly domain: MemoryDomain;
  readonly scope: MemoryScope;
  readonly confidence: number;
  readonly reasonCodes: readonly string[];
  readonly alternatives: readonly { scope: MemoryScope; score: number }[];
}

// ─── Known Predicates (shared with fact-key planner) ───────────────

type KnownPredicate =
  | "user_name"
  | "assistant_alias"
  | "response_style"
  | "language_preference"
  | "general_package_manager_preference"
  | "project_package_manager"
  | "project_build_command"
  | "project_test_command"
  | "project_database"
  | "project_deployment_target"
  | "task_goal"
  | "task_blocker";

// ─── Predicate to Domain Mapping ──────────────────────────────────

interface PredicateMeta {
  readonly predicate: KnownPredicate;
  readonly domain: MemoryDomain;
  readonly scopeKind: MemoryScope["kind"];
  readonly reasonCode: string;
  readonly cardinality: string;
}

const PREDICATE_META: Record<KnownPredicate, PredicateMeta> = {
  user_name: {
    predicate: "user_name",
    domain: "user",
    scopeKind: "user",
    reasonCode: "user_identity",
    cardinality: "single",
  },
  assistant_alias: {
    predicate: "assistant_alias",
    domain: "user",
    scopeKind: "user",
    reasonCode: "agent_profile",
    cardinality: "single",
  },
  response_style: {
    predicate: "response_style",
    domain: "user",
    scopeKind: "user",
    reasonCode: "user_preference",
    cardinality: "set",
  },
  language_preference: {
    predicate: "language_preference",
    domain: "user",
    scopeKind: "user",
    reasonCode: "user_preference",
    cardinality: "single",
  },
  general_package_manager_preference: {
    predicate: "general_package_manager_preference",
    domain: "user",
    scopeKind: "user",
    reasonCode: "user_preference",
    cardinality: "single",
  },
  project_package_manager: {
    predicate: "project_package_manager",
    domain: "project",
    scopeKind: "repository",
    reasonCode: "project_config",
    cardinality: "single",
  },
  project_build_command: {
    predicate: "project_build_command",
    domain: "project",
    scopeKind: "repository",
    reasonCode: "project_config",
    cardinality: "single",
  },
  project_test_command: {
    predicate: "project_test_command",
    domain: "project",
    scopeKind: "repository",
    reasonCode: "project_config",
    cardinality: "single",
  },
  project_database: {
    predicate: "project_database",
    domain: "project",
    scopeKind: "repository",
    reasonCode: "project_config",
    cardinality: "single",
  },
  project_deployment_target: {
    predicate: "project_deployment_target",
    domain: "project",
    scopeKind: "repository",
    reasonCode: "project_config",
    cardinality: "single",
  },
  task_goal: {
    predicate: "task_goal",
    domain: "task",
    scopeKind: "task",
    reasonCode: "task_state",
    cardinality: "single",
  },
  task_blocker: {
    predicate: "task_blocker",
    domain: "task",
    scopeKind: "task",
    reasonCode: "task_state",
    cardinality: "single",
  },
};

// ─── User / Agent Profile Detection ──────────────────────────────

interface ProfileSignal {
  readonly predicate: KnownPredicate | undefined;
  readonly confidence: number;
}

function detectProfileSignal(content: string): ProfileSignal {
  const normalized = normalizeText(content).toLowerCase();

  // Agent alias: 记住你叫 / call yourself / your name
  if (
    /记住你叫|你叫|叫你|你的名字|call\s+yourself|your\s+name\s+is|称呼(?:你|助手)|喊你/.test(
      normalized,
    )
  ) {
    return { predicate: "assistant_alias", confidence: 0.9 };
  }

  // User name: 我叫 / my name is
  if (/我叫|我的名?字|my\s+name\s+is|i\s+am\s+[A-Z]/.test(normalized)) {
    return { predicate: "user_name", confidence: 0.85 };
  }

  // Response style: 回答风格 / 喜欢先看结论 / 简洁
  if (
    /回答.*风格|回复.*方式|先(?:看|给).*结论|简洁|详细|啰嗦|简练|response\s+style|回答方式|说.*方式|讲.*方式|先.*结论/.test(
      normalized,
    )
  ) {
    return { predicate: "response_style", confidence: 0.8 };
  }

  // Language preference
  if (/说中文|说英文|用中文|用英文|language|语言/.test(normalized)) {
    return { predicate: "language_preference", confidence: 0.75 };
  }

  // General preference signals (not project-specific)
  if (
    /一般|通常|平时|习惯|偏好|prefer|usually|always\b.*(?!this project)/i.test(normalized) &&
    !/这个项目|this project|当前项目|仓库/.test(normalized)
  ) {
    return { predicate: undefined, confidence: 0.6 } satisfies ProfileSignal;
  }

  return { predicate: undefined, confidence: 0 } satisfies ProfileSignal;
}

// ─── Project/Fact Detection ───────────────────────────────────────

function detectProjectSignal(
  content: string,
  scopeContext?: PiScopeContext,
): { projectRelated: boolean; predicate: KnownPredicate | undefined; confidence: number } {
  const normalized = normalizeText(content).toLowerCase();

  // Check for specific project predicates first (even with explicit markers present)
  // Build command checked BEFORE package_manager: "pnpm build" should detect build_command
  if (/\b(?:build|构建|编译|pnpm build|npm run build|tsc|turbo build)\b/i.test(normalized)) {
    return { projectRelated: true, predicate: "project_build_command", confidence: 0.8 };
  }

  // Test command checked BEFORE package_manager: "pnpm test" should detect test_command
  if (/\b(?:test|测试|vitest|jest|pnpm test|npm test)\b/i.test(normalized)) {
    return { projectRelated: true, predicate: "project_test_command", confidence: 0.8 };
  }

  // Package manager
  if (/\b(?:pnpm|npm|yarn|bun|包管理|包管理器)\b/i.test(normalized)) {
    const isGeneral =
      /一般|通常|默认|一般.*项目|prefer|usually|default/i.test(normalized) &&
      !/这个项目|this project/i.test(normalized);
    if (isGeneral) {
      return {
        projectRelated: false,
        predicate: "general_package_manager_preference",
        confidence: 0.75,
      };
    }
    return { projectRelated: true, predicate: "project_package_manager", confidence: 0.8 };
  }

  // Database
  if (/\b(?:database|数据库|postgres|mysql|sqlite|mongodb)\b/i.test(normalized)) {
    return { projectRelated: true, predicate: "project_database", confidence: 0.75 };
  }

  // Deployment
  if (/\b(?:deploy|部署|发布|上线|production|staging)\b/i.test(normalized)) {
    return { projectRelated: true, predicate: "project_deployment_target", confidence: 0.75 };
  }

  // Explicit project scope markers (checked AFTER specific predicates)
  if (/这个项目|this project|当前项目|仓库|this repo|代码库|codebase/.test(normalized)) {
    return { projectRelated: true, predicate: undefined, confidence: 0.85 };
  }

  // General project language in repo context
  if (scopeContext?.repositoryId !== undefined || scopeContext?.projectId !== undefined) {
    if (
      /\b(?:architecture|架构|design|设计|structure|结构|module|模块|component|组件)\b/i.test(
        normalized,
      )
    ) {
      return { projectRelated: true, predicate: undefined, confidence: 0.6 };
    }
  }

  return { projectRelated: false, predicate: undefined, confidence: 0 };
}

// ─── Task Detection ───────────────────────────────────────────────

function detectTaskSignal(content: string): { taskRelated: boolean; confidence: number } {
  const normalized = normalizeText(content).toLowerCase();
  if (/任务|目标|进度|阻塞|blocker|todo|待办|进行中|task|goal|progress/.test(normalized)) {
    return { taskRelated: true, confidence: 0.7 };
  }
  return { taskRelated: false, confidence: 0 };
}

// ─── Episodic Detection ───────────────────────────────────────────

function detectEpisodicSignal(content: string): { episodic: boolean; confidence: number } {
  const normalized = normalizeText(content).toLowerCase();
  if (
    /构建|编译|测试|部署|失败|成功|错误|error|fail|success|pass|上次|第一[次回]|刚才|刚才说/.test(
      normalized,
    )
  ) {
    return { episodic: true, confidence: 0.65 };
  }
  return { episodic: false, confidence: 0 };
}

// ─── Correction / Retraction Detection ────────────────────────────

function detectCorrectionSignal(content: string): { isCorrection: boolean; confidence: number } {
  const normalized = normalizeText(content).toLowerCase();
  if (
    /刚才说|说错了|不是.*应该是|正确.*是|不对.*是|纠正|改正|更正|修正|之前.*错|不小心说|actually|sorry.*meant|更正.*之前|改成|现在使用|切换到/i.test(
      normalized,
    )
  ) {
    return { isCorrection: true, confidence: 0.85 };
  }
  if (/忘掉|删除.*记忆|清除|forget|remove.*memory|撤销/.test(normalized)) {
    return { isCorrection: true, confidence: 0.9 };
  }
  return { isCorrection: false, confidence: 0 };
}

// ─── Main Planner ─────────────────────────────────────────────────

/**
 * Plan the scope for a memory entry from natural-language content + context.
 *
 * Priority order:
 *   1. Profile signals → user scope (always)
 *   2. Correction signals → locate existing fact & update in same scope
 *   3. Project signals → repository/project scope
 *   4. Task signals → task scope
 *   5. Episodic signals → event scope
 *   6. Default → current context scope (narrowest)
 */
export function planScope(content: string, scopeContext: PiScopeContext): MemoryScopePlan {
  // 1. Check profile signals
  const profile = detectProfileSignal(content);
  if (profile.confidence >= 0.6) {
    const meta = profile.predicate !== undefined ? PREDICATE_META[profile.predicate] : undefined;
    const scope: MemoryScope = {
      kind: "user",
      id: scopeContext.userId || "local",
    };
    return {
      domain: meta?.domain ?? "user",
      scope,
      confidence: profile.confidence,
      reasonCodes: [meta?.reasonCode ?? "user_profile_signal"],
      alternatives: [],
    };
  }

  // 2. Check corrections (inherit scope from existing fact)
  const correction = detectCorrectionSignal(content);
  if (correction.isCorrection) {
    // Placeholder: the remember coordinator will locate the existing fact
    // and use its scope. For now, default narrow.
    const scope: MemoryScope = {
      kind: "project",
      id:
        scopeContext.projectId ??
        scopeContext.repositoryId ??
        scopeContext.workspacePath ??
        "local",
    };
    return {
      domain: "project",
      scope,
      confidence: 0.5,
      reasonCodes: ["correction_needs_existing_fact_lookup"],
      alternatives: [],
    };
  }

  // 3. Check project signals
  const project = detectProjectSignal(content, scopeContext);
  if (project.projectRelated) {
    const repoId = scopeContext.repositoryId;
    const scope: MemoryScope =
      repoId !== undefined
        ? { kind: "repository", id: repoId }
        : scopeContext.projectId !== undefined
          ? { kind: "project", id: scopeContext.projectId }
          : { kind: "workspace", id: scopeContext.workspacePath ?? "local" };
    const meta = project.predicate !== undefined ? PREDICATE_META[project.predicate] : undefined;
    return {
      domain: meta?.domain ?? "project",
      scope,
      confidence: project.confidence,
      reasonCodes: [meta?.reasonCode ?? "project_signal"],
      alternatives:
        repoId === undefined
          ? [{ scope: { kind: "user", id: scopeContext.userId }, score: 0.2 }]
          : [],
    };
  }

  // 4. Check task signals
  const task = detectTaskSignal(content);
  if (task.taskRelated && scopeContext.taskId !== undefined) {
    const scope: MemoryScope = { kind: "task", id: scopeContext.taskId };
    return {
      domain: "task",
      scope,
      confidence: task.confidence,
      reasonCodes: ["task_signal"],
      alternatives: [],
    };
  }

  // 5. Check episodic signals
  const episodic = detectEpisodicSignal(content);
  if (episodic.episodic) {
    const scope: MemoryScope = {
      kind:
        scopeContext.runId !== undefined
          ? "run"
          : scopeContext.sessionId !== undefined
            ? "session"
            : "project",
      id:
        scopeContext.runId ??
        scopeContext.sessionId ??
        scopeContext.projectId ??
        scopeContext.workspacePath ??
        "local",
    };
    return {
      domain: "episodic",
      scope,
      confidence: episodic.confidence,
      reasonCodes: ["episodic_signal"],
      alternatives: [],
    };
  }

  // 6. Default: narrowest scope from context
  const defaultScope = resolveDefaultScope(scopeContext);
  return {
    domain: "topic",
    scope: defaultScope,
    confidence: 0.4,
    reasonCodes: ["default_narrow_scope"],
    alternatives: [{ scope: { kind: "user", id: scopeContext.userId }, score: 0.15 }],
  };
}

function resolveDefaultScope(ctx: PiScopeContext): MemoryScope {
  // Prefer narrowest available
  if (ctx.taskId !== undefined) return { kind: "task", id: ctx.taskId };
  if (ctx.repositoryId !== undefined) return { kind: "repository", id: ctx.repositoryId };
  if (ctx.projectId !== undefined) return { kind: "project", id: ctx.projectId };
  if (ctx.topicIds !== undefined && ctx.topicIds.length > 0 && ctx.topicIds[0] !== undefined)
    return { kind: "topic", id: ctx.topicIds[0] };
  if (ctx.sessionId !== undefined) return { kind: "session", id: ctx.sessionId };
  return { kind: "user", id: ctx.userId };
}

// ─── Re-exports for convenience ───────────────────────────────────

export { detectProfileSignal, detectProjectSignal, detectCorrectionSignal };
