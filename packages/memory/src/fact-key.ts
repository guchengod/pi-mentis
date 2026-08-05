import { normalizeText } from "@pi-mentis/pi-mentis-core";

import type { MemoryDomain, PiScopeContext } from "./types.js";

// ─── Predicate Registry ───────────────────────────────────────────

export type KnownPredicate =
  | "project_purpose"
  | "package_manager"
  | "build_command"
  | "test_command"
  | "runtime"
  | "runtime_version"
  | "language"
  | "storage_engine"
  | "deployment_target"
  | "architecture_decision"
  | "user_preference"
  | "task_status"
  | "capability_state"
  | "verified_procedure"
  | "known_failure"
  | "user_name"
  | "assistant_alias"
  | "response_style"
  | "general_package_manager_preference";

export interface FactKeyResult {
  readonly factKey: string;
  readonly subjectKey: string;
  readonly predicateKey: KnownPredicate | undefined;
  readonly confidence: number;
  readonly fallbackUsed: boolean;
  readonly reasons: string[];
}

// ─── Predicate Detection ──────────────────────────────────────────

interface PredicatePattern {
  readonly predicate: KnownPredicate;
  readonly pattern: RegExp;
}

const PREDICATE_PATTERNS: readonly PredicatePattern[] = [
  {
    predicate: "assistant_alias",
    pattern: /(?:记住你叫|你叫|叫你|你的名字是|call yourself|your name is|称呼|喊你)/i,
  },
  {
    predicate: "user_name",
    pattern: /(?:我叫|我的名字是|my name is|i am|我是|用户名|用户姓名)/i,
  },
  {
    predicate: "response_style",
    pattern:
      /(?:回答.*风格|回复.*方式|先(?:看|给).*结论|简洁|详细|啰嗦|简练|response style|回答方式|说.*方式|讲.*方式|回答.*先)/i,
  },
  {
    predicate: "general_package_manager_preference",
    pattern:
      /(?:一般.*包管理|默认.*包管理|general.*package.*manager|常用.*包管理|always.*(?:pnpm|npm|yarn))/i,
  },
  // build_command before package_manager: "pnpm build" should detect build_command
  {
    predicate: "build_command",
    pattern: /\b(?:build|compile|tsc|turbo build|npm run build|pnpm build)\b|(?:构建|编译)/i,
  },
  // test_command before package_manager: "pnpm test" should detect test_command
  {
    predicate: "test_command",
    pattern: /\b(?:test|vitest|jest|npm test|pnpm test)\b|(?:测试命令)/i,
  },
  {
    predicate: "package_manager",
    pattern: /\b(?:pnpm|npm|yarn|bun|package manager)\b|(?:包管理器|包管理)/i,
  },
  {
    predicate: "runtime",
    pattern: /\b(?:node|deno|bun|runtime)\b|(?:运行时)/i,
  },
  {
    predicate: "runtime_version",
    pattern:
      /(?:(?:node|deno|bun|runtime)\s+(?:v?\d+\.\d+|version))|(?:运行时.*版本|版本.*\d+\.\d+)/i,
  },
  {
    predicate: "language",
    pattern: /\b(?:typescript|javascript|python|rust|go|golang|java)\b|(?:语言|编程语言)/i,
  },
  {
    predicate: "storage_engine",
    pattern: /\b(?:storage|database|zvec|sqlite|postgres)\b|(?:存储|数据库)/i,
  },
  {
    predicate: "deployment_target",
    pattern: /\b(?:deploy|production|staging|release)\b|(?:发布|部署|上线|生产环境|预发布)/i,
  },
  {
    predicate: "project_purpose",
    pattern: /\b(?:purpose|goal|this project is)\b|(?:这个项目是|目标|用途|做什么|用于)/i,
  },
  {
    predicate: "architecture_decision",
    pattern: /\b(?:architecture|design decision|pattern)\b|(?:架构|设计决定|设计模式)/i,
  },
  {
    predicate: "user_preference",
    pattern: /\b(?:prefer|like|want|preference)\b|(?:喜欢|偏好|习惯|倾向)/i,
  },
  {
    predicate: "task_status",
    pattern: /\b(?:task status|progress)\b|(?:任务状态|进度|完成|进行中|待办)/i,
  },
  {
    predicate: "capability_state",
    pattern: /\b(?:capability|can |cannot |able to)\b|(?:能力|可以|不能|支持)/i,
  },
  {
    predicate: "verified_procedure",
    pattern: /\b(?:verified|procedure|steps|workflow)\b|(?:已验证|步骤|流程|经过验证)/i,
  },
  {
    predicate: "known_failure",
    pattern: /\b(?:failure|error|bug|issue|problem|known issue)\b|(?:失败|错误|已知问题|故障)/i,
  },
];

function detectPredicate(content: string): {
  predicate?: KnownPredicate;
  confidence: number;
} {
  const normalized = normalizeText(content).toLowerCase();
  for (const { predicate, pattern } of PREDICATE_PATTERNS) {
    if (pattern.test(normalized)) {
      return { predicate, confidence: 0.7 };
    }
  }
  return { confidence: 0 };
}

// ─── Subject Key Extraction ───────────────────────────────────────

function subjectKey(domain: MemoryDomain, scopeContext?: PiScopeContext): string {
  switch (domain) {
    case "project":
    case "environment":
      return scopeContext?.repositoryId ?? scopeContext?.projectId ?? "unknown-project";
    case "user":
      return scopeContext?.userId ?? "local";
    case "task":
      return scopeContext?.taskId ?? "unknown-task";
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

  if (predicate !== undefined && confidence >= 0.6) {
    reasons.push(`predicate "${predicate}" detected with confidence ${confidence}`);
    return {
      factKey: `${domain}:${subjKey}/${predicate}`,
      subjectKey: subjKey,
      predicateKey: predicate,
      confidence,
      fallbackUsed: false,
      reasons,
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

/**
 * Check if two potential facts would conflict on the same FactKey
 * despite having different predicates. Returns conflict=true if
 * the predicates are clearly different and should not supersede.
 */
export function checkFactKeyConflict(
  oldPredicate: KnownPredicate | undefined,
  newPredicate: KnownPredicate | undefined,
  oldDomain: MemoryDomain,
  newDomain: MemoryDomain,
  oldSubjectKey: string,
  newSubjectKey: string,
): FactKeyConflictCheck {
  // Different subject → no conflict (different FactKey)
  if (oldSubjectKey !== newSubjectKey) {
    return { wouldConflict: false };
  }
  // Different domain → different FactKey prefix, no conflict
  if (oldDomain !== newDomain) {
    return { wouldConflict: false };
  }
  // Same subject + same domain but different predicates → should not supersede
  if (oldPredicate !== undefined && newPredicate !== undefined && oldPredicate !== newPredicate) {
    return {
      wouldConflict: true,
      reason: `Different predicates on same subject: ${oldPredicate} vs ${newPredicate}`,
    };
  }
  return { wouldConflict: false };
}
