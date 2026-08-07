/**
 * ScopePlanner — determines MemoryScope from natural-language content + context.
 *
 * The model does NOT provide scopeKind / scopeId. The system derives them.
 *
 * Rules cover:
 *   - User / Agent Profile (always user scope)
 *   - Repository / Project facts (repo scope preferred)
 *   - Task / Episodic (task/event scope)
 *   - No-repo safety: never generate project scope without a repository
 */

import { normalizeText, stableHash } from "@pi-mentis/pi-mentis-core";
import { createHash } from "node:crypto";

import type { MemoryDomain, MemoryScope, PiScopeContext } from "./types.js";

// ─── Scope Plan ───────────────────────────────────────────────────

export interface MemoryScopePlan {
  readonly domain: MemoryDomain;
  readonly scope: MemoryScope;
  readonly confidence: number;
  readonly reasonCodes: readonly string[];
  readonly alternatives: readonly { scope: MemoryScope; score: number }[];
}

// ─── Known Predicates (expanded) ───────────────────────────────────

type KnownPredicate =
  | "user_name"
  | "assistant_alias"
  | "response_style"
  | "language_preference"
  | "programming_language_preference"
  | "package_manager_preference"
  | "general_package_manager_preference"
  | "project_package_manager"
  | "project_build_command"
  | "project_test_command"
  | "project_integration_test_command"
  | "project_lint_command"
  | "project_typecheck_command"
  | "project_format_command"
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
  readonly cardinality: "single" | "set" | "event";
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
    cardinality: "single",
  },
  language_preference: {
    predicate: "language_preference",
    domain: "user",
    scopeKind: "user",
    reasonCode: "user_preference",
    cardinality: "single",
  },
  programming_language_preference: {
    predicate: "programming_language_preference",
    domain: "user",
    scopeKind: "user",
    reasonCode: "user_preference",
    cardinality: "set",
  },
  package_manager_preference: {
    predicate: "package_manager_preference",
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
  project_integration_test_command: {
    predicate: "project_integration_test_command",
    domain: "project",
    scopeKind: "repository",
    reasonCode: "project_config",
    cardinality: "single",
  },
  project_lint_command: {
    predicate: "project_lint_command",
    domain: "project",
    scopeKind: "repository",
    reasonCode: "project_config",
    cardinality: "single",
  },
  project_typecheck_command: {
    predicate: "project_typecheck_command",
    domain: "project",
    scopeKind: "repository",
    reasonCode: "project_config",
    cardinality: "single",
  },
  project_format_command: {
    predicate: "project_format_command",
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

// ─── Chinese boundary helpers ──────────────────────────────────────

/**
 * Unicode-aware phrase matcher for Chinese text.
 * Does NOT use \b which is undefined for CJK characters.
 */
function hasPhrase(text: string, ...phrases: string[]): boolean {
  return phrases.some((phrase) => text.includes(phrase));
}

function hasRegex(text: string, ...regexes: RegExp[]): boolean {
  return regexes.some((re) => re.test(text));
}

// ─── User / Agent Profile Detection ──────────────────────────────

interface ProfileSignal {
  readonly predicate: KnownPredicate | undefined;
  readonly confidence: number;
}

function detectProfileSignal(content: string): ProfileSignal {
  const normalized = normalizeText(content).toLowerCase();

  // Agent alias (Chinese + English)
  if (
    hasPhrase(normalized, "记住你叫", "你叫", "叫你", "你的名字", "称呼你", "称呼助手", "喊你") ||
    hasRegex(normalized, /call\s+yourself/i, /your\s+name\s+is/i)
  ) {
    return { predicate: "assistant_alias", confidence: 0.9 };
  }

  // User name
  if (
    hasPhrase(normalized, "我叫", "我的名字") ||
    hasRegex(normalized, /my\s+name\s+is/i, /i\s+am\s+[A-Z]/)
  ) {
    return { predicate: "user_name", confidence: 0.85 };
  }

  // Response style
  if (
    hasPhrase(normalized, "回答风格", "回复方式", "回答方式", "说方式", "讲方式") ||
    hasRegex(normalized, /先(?:看|给).*结论|简洁|详细|啰嗦|简练|response\s+style/i)
  ) {
    return { predicate: "response_style", confidence: 0.8 };
  }

  // Language preference
  if (
    hasPhrase(normalized, "说中文", "说英文", "用中文", "用英文") ||
    hasRegex(normalized, /language|语言/)
  ) {
    return { predicate: "language_preference", confidence: 0.75 };
  }

  // Programming language preference
  if (
    hasPhrase(normalized, "喜欢", "偏好") &&
    hasRegex(normalized, /\b(?:go|rust|typescript|python|java)\b/i)
  ) {
    return { predicate: "programming_language_preference", confidence: 0.75 };
  }

  // General preference signals (not project-specific)
  if (
    hasRegex(normalized, /(?:一般|通常|平时|习惯|喜欢|偏好|prefer|usually)/i) &&
    !hasPhrase(normalized, "这个项目", "仓库", "代码库") &&
    !hasRegex(normalized, /this project|this repo|codebase/i)
  ) {
    return { predicate: undefined, confidence: 0.6 } satisfies ProfileSignal;
  }

  return { predicate: undefined, confidence: 0 } satisfies ProfileSignal;
}

// ─── Project Predicate Detection ──────────────────────────────────

function detectProjectPredicate(content: string): {
  predicate: KnownPredicate | undefined;
  confidence: number;
} {
  const normalized = normalizeText(content).toLowerCase();

  // Match from most specific to least specific

  // integration_test_command
  if (
    hasPhrase(normalized, "集成测试", "integration test") ||
    hasRegex(normalized, /pnpm\s+test:integration|npm\s+run\s+test:integration|pnpm\s+test:e2e/i)
  ) {
    return { predicate: "project_integration_test_command", confidence: 0.85 };
  }

  // typecheck_command — must be checked BEFORE test_command / lint_command
  if (
    hasPhrase(normalized, "类型检查", "typecheck", "type check") ||
    hasRegex(normalized, /pnpm\s+typecheck|npm\s+run\s+typecheck|tsc\s+--noEmit/i)
  ) {
    return { predicate: "project_typecheck_command", confidence: 0.85 };
  }

  // lint_command
  if (
    hasPhrase(normalized, "检查", "lint", "eslint") ||
    hasRegex(normalized, /pnpm\s+lint|npm\s+run\s+lint|eslint\b/i)
  ) {
    return { predicate: "project_lint_command", confidence: 0.8 };
  }

  // format_command
  if (
    hasPhrase(normalized, "格式化", "format") ||
    hasRegex(normalized, /pnpm\s+format|npm\s+run\s+format|prettier\b/i)
  ) {
    return { predicate: "project_format_command", confidence: 0.8 };
  }

  // build_command — must be checked BEFORE package_manager and test_command
  if (
    hasPhrase(normalized, "构建", "编译", "build", "compile") ||
    hasRegex(normalized, /pnpm\s+build|npm\s+run\s+build|tsc\b|turbo\s+build/i)
  ) {
    return { predicate: "project_build_command", confidence: 0.85 };
  }

  // test_command — must be checked BEFORE package_manager
  if (
    hasPhrase(normalized, "测试", "test") ||
    hasRegex(normalized, /pnpm\s+test|npm\s+test|vitest|jest/i)
  ) {
    return { predicate: "project_test_command", confidence: 0.85 };
  }

  // Package manager
  if (
    hasPhrase(normalized, "pnpm", "npm", "yarn", "bun", "包管理", "包管理器") ||
    hasRegex(normalized, /\b(?:pnpm|npm|yarn|bun)\b/i)
  ) {
    const isGeneral =
      hasRegex(normalized, /一般|通常|默认|一般.*项目|prefer|usually|default/i) &&
      !hasPhrase(normalized, "这个项目") &&
      !hasRegex(normalized, /this project/i);
    if (isGeneral) {
      return { predicate: "general_package_manager_preference", confidence: 0.75 };
    }
    return { predicate: "project_package_manager", confidence: 0.8 };
  }

  // Database
  if (
    hasPhrase(normalized, "数据库", "database", "postgres", "mysql", "sqlite", "mongodb") ||
    hasRegex(normalized, /\b(?:database|postgres|mysql|sqlite|mongodb)\b/i)
  ) {
    return { predicate: "project_database", confidence: 0.75 };
  }

  // Deployment
  if (
    hasPhrase(normalized, "部署", "发布", "上线", "deploy", "production", "staging") ||
    hasRegex(normalized, /\b(?:deploy|部署|发布|上线|production|staging)\b/i)
  ) {
    return { predicate: "project_deployment_target", confidence: 0.75 };
  }

  return { predicate: undefined, confidence: 0 };
}

function detectProjectSignal(
  content: string,
  scopeContext?: PiScopeContext,
): { projectRelated: boolean; predicate: KnownPredicate | undefined; confidence: number } {
  const normalized = normalizeText(content).toLowerCase();
  const pred = detectProjectPredicate(content);

  if (pred.predicate !== undefined) {
    // General preferences are NOT project-related
    const isGeneral = pred.predicate === "general_package_manager_preference";
    return { projectRelated: !isGeneral, predicate: pred.predicate, confidence: pred.confidence };
  }

  // Explicit project scope language markers
  if (
    hasPhrase(normalized, "这个项目", "当前项目", "本仓库") ||
    hasRegex(normalized, /this project|this repo|codebase/i)
  ) {
    return { projectRelated: true, predicate: undefined, confidence: 0.85 };
  }

  // General project architecture language in repo context
  if (scopeContext?.repositoryId !== undefined || scopeContext?.projectId !== undefined) {
    if (
      hasRegex(normalized, /\b(?:architecture|design|module|component|structure)\b/i) ||
      hasPhrase(normalized, "架构", "模块", "组件", "结构")
    ) {
      return { projectRelated: true, predicate: undefined, confidence: 0.6 };
    }
  }

  return { projectRelated: false, predicate: undefined, confidence: 0 };
}

// ─── Task Detection ───────────────────────────────────────────────

function detectTaskSignal(content: string): { taskRelated: boolean; confidence: number } {
  const normalized = normalizeText(content).toLowerCase();
  if (
    hasPhrase(normalized, "任务", "目标", "进度", "阻塞", "待办", "进行中") ||
    hasRegex(normalized, /blocker|todo|task|goal|progress/i)
  ) {
    return { taskRelated: true, confidence: 0.7 };
  }
  return { taskRelated: false, confidence: 0 };
}

// ─── Correction / Retraction Detection ────────────────────────────

export function detectCorrectionSignal(content: string): {
  isCorrection: boolean;
  isRetract: boolean;
  action: "correct" | "replace" | "retract" | undefined;
  oldValue: string | undefined;
  newValue: string | undefined;
  confidence: number;
} {
  const normalized = normalizeText(content).toLowerCase();
  const original = content;

  // Retract expressions
  if (
    hasPhrase(normalized, "忘掉", "忘记这个", "撤销之前的决定", "不要再使用这个配置") ||
    hasPhrase(normalized, "撤销") ||
    hasRegex(normalized, /删除.*记忆|清除.*记忆|forget|remove.*memory|不再使用.*改用/i)
  ) {
    // Extract old value from "不再使用 X, 改用 Y" — that's replace not retract
    const replaceMatch = original.match(
      /不再使用\s*(\S+).*改用\s*(\S+)|改用\s*(\S+).*不再使用\s*(\S+)/,
    );
    if (replaceMatch) {
      const oldVal = replaceMatch[1] ?? replaceMatch[4] ?? undefined;
      const newVal = replaceMatch[2] ?? replaceMatch[3] ?? undefined;
      return {
        isCorrection: true,
        isRetract: false,
        action: "replace",
        oldValue: oldVal,
        newValue: newVal,
        confidence: 0.9,
      };
    }
    return {
      isCorrection: true,
      isRetract: true,
      action: "retract",
      oldValue: undefined,
      newValue: undefined,
      confidence: 0.9,
    };
  }

  // Explicit correction patterns
  if (
    hasPhrase(
      normalized,
      "刚才说错了",
      "之前说错了",
      "不小心说",
      "更正",
      "纠正",
      "改正",
      "修正",
      "更正之前",
    ) ||
    hasRegex(normalized, /actually|sorry.*meant/i)
  ) {
    return {
      isCorrection: true,
      isRetract: false,
      action: "correct",
      oldValue: undefined,
      newValue: undefined,
      confidence: 0.85,
    };
  }

  // Replace patterns: "改成/改为/改用/替换为/切换到/以后使用/现在使用/不再是 Y 现在是 Y/从 X 迁移到 Y"
  if (
    hasPhrase(normalized, "改成", "改为", "改用", "替换为", "切换到", "以后使用", "现在使用") ||
    hasRegex(normalized, /不再是\s+\S+\s+现在是/i) ||
    hasPhrase(normalized, "已经废弃", "迁移到") ||
    hasRegex(normalized, /从\s+\S+\s+迁移到\s+\S+/i)
  ) {
    // Try to extract old and new values
    const patterns = [
      /改用\s*(.+)/,
      /改成\s*(.+)/,
      /改为\s*(.+)/,
      /替换为\s*(.+)/,
      /切换到\s*(.+)/,
      /以后使用\s*(.+)/,
      /现在使用\s*(.+)/,
      /不再是\s+(\S+)\s+现在是\s+(\S+)/,
      /从\s+(\S+)\s+迁移到\s+(\S+)/,
    ];
    let oldValue: string | undefined;
    let newValue: string | undefined;
    for (const pat of patterns) {
      const match = original.match(pat);
      if (match) {
        if (match[2] !== undefined) {
          oldValue = match[1];
          newValue = match[2];
        } else {
          newValue = match[1];
        }
        break;
      }
    }
    return {
      isCorrection: true,
      isRetract: false,
      action: "replace",
      oldValue,
      newValue,
      confidence: 0.85,
    };
  }

  return {
    isCorrection: false,
    isRetract: false,
    action: undefined,
    oldValue: undefined,
    newValue: undefined,
    confidence: 0,
  };
}

// ─── Repository ID generation ─────────────────────────────────────

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function stableRepositoryId(canonicalGitRoot: string, normalizedRemoteUrl?: string): string {
  return sha256(canonicalGitRoot + "\n" + (normalizedRemoteUrl ?? ""));
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
 *   5. Default → narrowest context scope
 *
 * NEVER generates "unknown-project" scope.
 * No-repo context must NOT create project scope.
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

  // 2. Check corrections
  const correction = detectCorrectionSignal(content);
  if (correction.isCorrection) {
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

  // 3. Check project signals — only if repository/project context exists
  const inRepo = scopeContext.repositoryId !== undefined || scopeContext.projectId !== undefined;
  const project = detectProjectSignal(content, scopeContext);
  if (project.projectRelated && inRepo) {
    const repoId = scopeContext.repositoryId;
    const scope: MemoryScope =
      repoId !== undefined
        ? { kind: "repository", id: repoId }
        : scopeContext.projectId !== undefined
          ? { kind: "project", id: scopeContext.projectId }
          : { kind: "user", id: scopeContext.userId };
    const meta = project.predicate !== undefined ? PREDICATE_META[project.predicate] : undefined;
    return {
      domain: meta?.domain ?? "project",
      scope,
      confidence: project.confidence,
      reasonCodes: [meta?.reasonCode ?? "project_signal"],
      alternatives: [],
    };
  }

  // If there's a project signal but no repo context, fall back to user scope
  if (project.projectRelated) {
    const scope: MemoryScope = { kind: "user", id: scopeContext.userId };
    return {
      domain: "user",
      scope,
      confidence: 0.5,
      reasonCodes: ["project_signal_no_repo_fallback_user"],
      alternatives: [],
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

  // 5. Default: narrowest scope from context
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
  if (ctx.taskId !== undefined) return { kind: "task", id: ctx.taskId };
  if (ctx.repositoryId !== undefined) return { kind: "repository", id: ctx.repositoryId };
  if (ctx.projectId !== undefined) return { kind: "project", id: ctx.projectId };
  if (ctx.topicIds !== undefined && ctx.topicIds.length > 0 && ctx.topicIds[0] !== undefined)
    return { kind: "topic", id: ctx.topicIds[0] };
  if (ctx.sessionId !== undefined) return { kind: "session", id: ctx.sessionId };
  return { kind: "user", id: ctx.userId };
}

export { detectProfileSignal, detectProjectSignal };
