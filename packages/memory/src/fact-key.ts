import { normalizeText } from "@pi-mentis/pi-mentis-core";

import type { MemoryDomain, PiScopeContext } from "./types.js";
import { predicateDefinition, type KnownPredicate } from "./predicate-registry.js";

// ─── Predicate Registry ───────────────────────────────────────────

export interface FactKeyResult {
  readonly factKey: string;
  readonly subjectKey: string;
  readonly predicateKey: KnownPredicate | undefined;
  readonly confidence: number;
  readonly fallbackUsed: boolean;
  readonly reasons: string[];
  readonly normalizedValue?: string;
  readonly setMemberKey?: string;
}

// ─── Chinese-aware matching helpers ────────────────────────────────

function hasPhrase(text: string, ...phrases: string[]): boolean {
  return phrases.some((phrase) => text.includes(phrase));
}

function hasRegex(text: string, ...regexes: RegExp[]): boolean {
  return regexes.some((re) => re.test(text));
}

// ─── Predicate Detection (ordered from specific to general) ──────

interface PredicatePattern {
  readonly predicate: KnownPredicate;
  readonly match: (text: string) => boolean;
}

const PREDICATE_MATCHERS: readonly PredicatePattern[] = [
  // ── Profile predicates (highest priority) ──
  {
    predicate: "assistant_alias",
    match: (t) =>
      hasPhrase(t, "记住你叫", "你叫", "叫你", "你的名字是", "称呼你", "称呼助手", "喊你") ||
      hasRegex(t, /call yourself|your name is/i),
  },
  {
    predicate: "user_name",
    match: (t) =>
      hasPhrase(t, "我叫", "我的名字是") || hasRegex(t, /my name is|i am|我叫|我的名字/),
  },
  {
    predicate: "response_style",
    match: (t) =>
      hasPhrase(t, "回答风格", "回复方式", "回答方式") ||
      hasRegex(t, /先(?:看|给).*结论|简洁|详细|啰嗦|简练|response style|说.*方式|讲.*方式/),
  },
  {
    predicate: "language_preference",
    match: (t) =>
      hasPhrase(t, "说中文", "说英文", "用中文", "用英文") || hasRegex(t, /\b(?:language|语言)\b/),
  },
  {
    predicate: "code_style_preference",
    match: (t) =>
      hasPhrase(t, "代码风格", "编码风格", "实现风格", "设计习惯", "代码习惯", "编码习惯") ||
      hasRegex(t, /\b(?:code style|coding style|implementation style)\b/i) ||
      ((hasPhrase(t, "喜欢", "偏好") || hasRegex(t, /prefer|like/i)) &&
        (hasPhrase(t, "简单", "直接", "抽象", "接口层", "过度设计", "过度抽象", "过度工程") ||
          hasRegex(
            t,
            /(?:keep it simple|simple.*implementation|avoid.*abstract(?:ion)?|don't over[- ]?engineer|minimal.*interface|avoid.*layer)/i,
          ))),
  },
  {
    predicate: "programming_language_preference",
    match: (t) =>
      (hasPhrase(t, "喜欢", "偏好", "编程语言") || hasRegex(t, /prefer|like/i)) &&
      (hasPhrase(t, "编程语言") ||
        hasRegex(
          t,
          /\b(?:go\b|golang|rust|types?cript|python|java|javascript|kotlin|swift|zig|elixir|c\b|c#|c\+\+|ruby|php|scala|haskell|clojure|dart|lua|perl|r\b)\b/i,
        )),
  },
  {
    predicate: "general_package_manager_preference",
    match: (t) =>
      hasRegex(
        t,
        /一般.*包管理|默认.*包管理|general.*package.*manager|常用.*包管理|always.*(?:pnpm|npm|yarn)/i,
      ),
  },

  // ── Project command predicates (must be checked from specific to general) ──
  {
    predicate: "project_integration_test_command",
    match: (t) =>
      hasPhrase(t, "集成测试", "integration test") ||
      hasRegex(t, /pnpm\s+test:integration|npm\s+run\s+test:integration|pnpm\s+test:e2e/i),
  },
  {
    predicate: "project_typecheck_command",
    match: (t) =>
      hasPhrase(t, "类型检查", "typecheck", "type check") ||
      hasRegex(t, /pnpm\s+typecheck|npm\s+run\s+typecheck|tsc\s+--noEmit/i),
  },
  {
    predicate: "project_lint_command",
    match: (t) =>
      (hasPhrase(t, "检查") && hasPhrase(t, "lint")) ||
      hasRegex(t, /pnpm\s+lint|npm\s+run\s+lint|eslint\b/i),
  },
  {
    predicate: "project_format_command",
    match: (t) =>
      hasPhrase(t, "格式化") || hasRegex(t, /pnpm\s+format|npm\s+run\s+format|prettier\b/i),
  },
  // build_command BEFORE package_manager and test_command
  {
    predicate: "project_build_command",
    match: (t) =>
      hasPhrase(t, "构建", "编译") ||
      hasRegex(
        t,
        /pnpm\s+build|npm\s+run\s+build|tsc\b(?!.*--noEmit)|turbo\s+build|构建命令|编译命令/i,
      ),
  },
  // test_command BEFORE package_manager
  {
    predicate: "project_test_command",
    match: (t) =>
      hasPhrase(t, "测试") ||
      hasRegex(
        t,
        /pnpm\s+test(?!\s*:integration\b)|npm\s+test(?!\s*:integration\b)|vitest|jest|\btest\b/i,
      ),
  },
  {
    predicate: "project_package_manager",
    match: (t) =>
      hasPhrase(t, "pnpm", "npm", "yarn", "bun", "包管理", "包管理器") ||
      hasRegex(t, /\b(?:pnpm|npm|yarn|bun|package manager)\b/i),
  },
  {
    predicate: "project_database",
    match: (t) =>
      hasPhrase(t, "数据库", "database", "postgres", "mysql", "sqlite", "mongodb") ||
      hasRegex(t, /\b(?:database|postgres|mysql|sqlite|mongodb)\b/i),
  },
  {
    predicate: "project_deployment_target",
    match: (t) =>
      hasPhrase(t, "部署", "发布", "上线") || hasRegex(t, /\b(?:deploy|production|staging)\b/i),
  },
  {
    predicate: "project_purpose",
    match: (t) =>
      hasPhrase(t, "这个项目是") || hasRegex(t, /\b(?:purpose|goal|this project is)\b/i),
  },
  {
    predicate: "architecture_decision",
    match: (t) =>
      hasPhrase(t, "架构", "设计模式") ||
      hasRegex(t, /\b(?:architecture|design decision|pattern)\b/i),
  },

  // ── Infrastructure ──
  {
    predicate: "runtime",
    match: (t) => hasPhrase(t, "运行时") || hasRegex(t, /\b(?:node|deno|bun|runtime)\b/i),
  },
  {
    predicate: "runtime_version",
    match: (t) =>
      hasRegex(t, /(?:node|deno|bun|runtime)\s+(?:v?\d+\.\d+|version)/i) ||
      (hasPhrase(t, "版本") && hasRegex(t, /\d+\.\d+/)),
  },
  {
    predicate: "language",
    match: (t) =>
      hasPhrase(t, "语言", "编程语言") ||
      hasRegex(t, /\b(?:typescript|javascript|python|rust|go|golang|java)\b/i),
  },
  {
    predicate: "storage_engine",
    match: (t) =>
      hasPhrase(t, "存储", "数据库") ||
      hasRegex(t, /\b(?:storage|database|zvec|sqlite|postgres)\b/i),
  },

  // ── Task / Status ──
  {
    predicate: "task_goal",
    match: (t) => hasPhrase(t, "任务目标") || hasRegex(t, /task.*goal|goal.*task/i),
  },
  {
    predicate: "task_status",
    match: (t) => hasPhrase(t, "任务状态", "进度") || hasRegex(t, /task status|progress/i),
  },
  {
    predicate: "task_blocker",
    match: (t) => hasPhrase(t, "阻塞", "卡住") || hasRegex(t, /blocker|blocked by/i),
  },

  // ── Capability ──
  {
    predicate: "capability_state",
    match: (t) =>
      hasPhrase(t, "能力", "可以", "不能", "支持") ||
      hasRegex(t, /\b(?:capability|can |cannot |able to)\b/i),
  },
  {
    predicate: "verified_procedure",
    match: (t) =>
      hasPhrase(t, "已验证", "步骤", "流程") ||
      hasRegex(t, /\b(?:verified|procedure|steps|workflow)\b/i),
  },
  {
    predicate: "known_failure",
    match: (t) =>
      hasPhrase(t, "失败", "错误", "故障", "已知问题") ||
      hasRegex(t, /\b(?:failure|error|bug|issue|problem|known issue)\b/i),
  },
];

function detectPredicate(content: string): {
  predicate?: KnownPredicate;
  confidence: number;
} {
  const normalized = normalizeText(content).toLowerCase();
  for (const { predicate, match } of PREDICATE_MATCHERS) {
    if (match(normalized)) {
      return { predicate, confidence: 0.7 };
    }
  }
  return { confidence: 0 };
}

// ─── Subject Key Extraction (no more "unknown-project") ───────────

function subjectKey(domain: MemoryDomain, scopeContext?: PiScopeContext): string {
  switch (domain) {
    case "project":
    case "environment":
      // Require a real repository or project ID — never "unknown-project"
      return (
        scopeContext?.repositoryId ?? scopeContext?.projectId ?? scopeContext?.userId ?? "local"
      );
    case "user":
      return scopeContext?.userId ?? "local";
    case "task":
      return scopeContext?.taskId ?? scopeContext?.userId ?? "local";
    case "capability":
      return scopeContext?.capabilitySnapshotId ?? scopeContext?.userId ?? "local";
    case "topic":
      return scopeContext?.topicIds?.[0] ?? scopeContext?.userId ?? "local";
    case "procedure":
      return scopeContext?.repositoryId ?? scopeContext?.projectId ?? "local";
    case "episodic":
      return (
        scopeContext?.repositoryId ?? scopeContext?.projectId ?? scopeContext?.userId ?? "local"
      );
    default:
      return scopeContext?.userId ?? "local";
  }
}

// ─── FactKey Derivation ───────────────────────────────────────────

const EXTRACT_LANG = /\b(?:go\b|golang|rust|types?cript|python|java(?!script)|kotlin|swift|zig|elixir|c\b|c#|c\+\+|ruby|php|scala|haskell|clojure|dart|lua|perl|r\b)\b/gi;

function extractNormalizedValue(
  content: string,
  predicate: KnownPredicate | undefined,
): string | undefined {
  if (predicate === undefined) return undefined;
  const normalized = normalizeText(content).toLowerCase();
  if (predicate === "programming_language_preference") {
    const langs = [...new Set(normalized.match(EXTRACT_LANG) ?? [])].map((l) =>
      l === "golang" ? "go" : l,
    );
    return langs.length > 0 ? langs.join(", ") : undefined;
  }
  if (predicate === "language") {
    const langs = [...new Set(normalized.match(EXTRACT_LANG) ?? [])].map((l) =>
      l === "golang" ? "go" : l,
    );
    return langs.length > 0 ? langs.join(", ") : undefined;
  }
  return undefined;
}

/**
 * Derive a controlled FactKey from content, domain, and context.
 * FactKey format: `<domain>:<subjectKey>/<predicateKey>`
 *
 * If no predicate can be confidently detected, returns a fallback
 * with fallbackUsed=true — the caller should use cardinality=set.
 */
export function deriveFactKey(
  content: string,
  domain: MemoryDomain,
  scopeContext?: PiScopeContext,
): FactKeyResult {
  const { predicate, confidence } = detectPredicate(content);
  const subjKey = subjectKey(domain, scopeContext);
  const reasons: string[] = [];
  const normalizedValue = extractNormalizedValue(content, predicate);
  const cardinality = predicate !== undefined ? predicateDefinition(predicate)?.cardinality : undefined;
    const setMemberKey =
    cardinality === "set" ? (normalizedValue ?? normalizeText(content).toLowerCase().slice(0, 60)) : undefined;

  if (predicate !== undefined && confidence >= 0.6) {
    reasons.push(`predicate "${predicate}" detected with confidence ${confidence}`);
    return {
      factKey: `${domain}:${subjKey}/${predicate}`,
      subjectKey: subjKey,
      predicateKey: predicate,
      confidence,
      fallbackUsed: false,
      reasons,
      ...(normalizedValue !== undefined ? { normalizedValue } : {}),
      ...(setMemberKey !== undefined ? { setMemberKey } : {}),
    };
  }

  // Low confidence — use fallback
  const normalized = normalizeText(content).toLowerCase();
  const shortHash = normalized
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .replace(/[^a-z0-9\u4e00-\u9fff\s]/gi, "_");
  reasons.push(`no predicate matched confidently (best confidence: ${confidence}), using fallback`);
  return {
    factKey: `${domain}:${subjKey}/fallback:${shortHash.slice(0, 40)}`,
    subjectKey: subjKey,
    predicateKey: undefined,
    confidence: Math.max(0.3, confidence),
    fallbackUsed: true,
    reasons,
  };
}

// ─── FactKey Conflict Check ───────────────────────────────────────

export interface FactKeyConflictCheck {
  readonly wouldConflict: boolean;
  readonly reason?: string;
}

export function checkFactKeyConflict(
  oldPredicate: KnownPredicate | undefined,
  newPredicate: KnownPredicate | undefined,
  oldDomain: MemoryDomain,
  newDomain: MemoryDomain,
  oldSubjectKey: string,
  newSubjectKey: string,
): FactKeyConflictCheck {
  if (oldSubjectKey !== newSubjectKey) {
    return { wouldConflict: false };
  }
  if (oldDomain !== newDomain) {
    return { wouldConflict: false };
  }
  if (oldPredicate !== undefined && newPredicate !== undefined && oldPredicate !== newPredicate) {
    return {
      wouldConflict: true,
      reason: `Different predicates on same subject: ${oldPredicate} vs ${newPredicate}`,
    };
  }
  return { wouldConflict: false };
}
