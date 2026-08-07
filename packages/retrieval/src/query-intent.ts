/**
 * Query Intent — lightweight domain/predicate/specificity analysis for memory recall.
 *
 * Runs BEFORE embedding / search to guide:
 *   - Domain/Predicate boosting (boost relevant, penalize unrelated)
 *   - Relevance threshold computation (specific → higher floor, broad → lower)
 *   - Summary generation alignment
 *
 * Never replaces semantic search — only adjusts scores and filters.
 */

export interface MemoryQueryIntent {
  readonly domain?: string;
  readonly predicates?: string[];
  readonly scope?: string;
  readonly specificity: "broad" | "specific";
}

interface DomainDefinition {
  readonly domain: string;
  readonly triggers: readonly RegExp[];
  readonly predicates: readonly string[];
  readonly antiPredicates: readonly string[];
  readonly positiveKeywords: readonly string[];
  readonly negativeKeywords: readonly string[];
}

const DOMAINS: readonly DomainDefinition[] = [
  {
    domain: "code_design",
    triggers: [
      /代码.{0,2}(?:设计|风格|结构|架构|写法|习惯|组织|模式|品味)/,
      /编程(?:风格|习惯|偏好|模式)/,
      /code (?:design|style|structure|architecture|pattern)/,
      /(?:避免|不要|尽量|倾向).*(?:抽象|继承|接口|类|函数|模块|耦合)/,
      /简洁.*(?:代码|设计|实现)/,
      /(?:简单|干净|清晰|易读)(?:代码|设计|编程)/,
      /代码.*(?:简单|简洁|干净|清晰|直接|喜欢|风格|习惯)/,
    ],
    predicates: [
      "code_style_preference",
      "architecture_preference",
      "abstraction_preference",
      "simplicity_preference",
      "code_organization_preference",
      "readability_preference",
    ],
    antiPredicates: [
      "response_style",
      "package_manager_preference",
      "editor_preference",
      "language_preference",
      "tool_preference",
    ],
    positiveKeywords: [
      "代码",
      "设计",
      "编程",
      "抽象",
      "接口",
      "类",
      "函数",
      "简洁",
      "简单直接",
      "模块",
      "耦合",
      "架构",
      "风格",
      "组织",
      "可读",
    ],
    negativeKeywords: [
      "回答",
      "回复",
      "结论先行",
      "pnpm",
      "npm",
      "yarn",
      "编辑器",
      "vscode",
      "语言",
    ],
  },
  {
    domain: "response_style",
    triggers: [
      /(?:回答|回复).*?(?:方式|风格|习惯|样子|怎么|如何)/,
      /(?:喜欢|习惯).*?(?:回答|回复|说|写)/,
      /(?:response|answer|reply).*?(?:style|habit|way|how)/,
      /(?:结论先行|先.*结论|先.*回答)/,
      /怎么(?:回复|回答|说)/,
    ],
    predicates: [
      "response_style",
      "answer_format_preference",
      "communication_style",
    ],
    antiPredicates: [
      "package_manager_preference",
      "editor_preference",
      "code_style_preference",
      "architecture_preference",
    ],
    positiveKeywords: [
      "回答",
      "回复",
      "方式",
      "结论先行",
      "风格",
      "说话",
      "沟通",
    ],
    negativeKeywords: [
      "代码",
      "pnpm",
      "npm",
      "包管理",
      "编辑器",
    ],
  },
  {
    domain: "package_manager",
    triggers: [
      /(?:包管理|用什么.*包|哪个.*包|什么.*安装|npm|pnpm|yarn|bun)/,
      /package manager/,
      /(?:安装|下载|加).*依赖/,
    ],
    predicates: [
      "package_manager_preference",
      "dependency_management",
    ],
    antiPredicates: [
      "code_style_preference",
      "response_style",
      "editor_preference",
      "architecture_preference",
    ],
    positiveKeywords: [
      "pnpm",
      "npm",
      "yarn",
      "bun",
      "包管理",
      "依赖",
      "安装",
      "package",
    ],
    negativeKeywords: [
      "代码",
      "设计",
      "回答",
      "回复",
      "编辑器",
    ],
  },
  {
    domain: "editor",
    triggers: [
      /(?:编辑器|IDE|用什么.*写|vscode|neovim|vim|emacs|sublime)/,
      /(?:editor|ide).*prefer/,
    ],
    predicates: [
      "editor_preference",
      "ide_preference",
    ],
    antiPredicates: [
      "code_style_preference",
      "response_style",
      "package_manager_preference",
    ],
    positiveKeywords: [
      "编辑器",
      "IDE",
      "vscode",
      "vim",
      "neovim",
      "写代码",
    ],
    negativeKeywords: [
      "pnpm",
      "回答",
      "代码设计",
    ],
  },
  {
    domain: "language_preference",
    triggers: [
      /(?:什么.*语言|编程.*语言|用.*什么.*写|typescript|javascript|python|go|rust|java)/,
      /programming language.*prefer/,
      /(?:喜欢|习惯).*?(?:typescript|javascript|python|go|rust|java)/,
    ],
    predicates: [
      "language_preference",
      "tech_stack_preference",
    ],
    antiPredicates: [
      "response_style",
      "code_style_preference",
    ],
    positiveKeywords: [
      "typescript",
      "javascript",
      "python",
      "go",
      "rust",
      "java",
      "语言",
      "编程",
    ],
    negativeKeywords: [
      "回答",
      "回复",
      "pnpm",
    ],
  },
  {
    domain: "database",
    triggers: [
      /(?:数据库|database|postgres|mysql|mongodb|sqlite|redis)/,
      /(?:什么.*存储|哪个.*db|数据.*存)/,
    ],
    predicates: [
      "database_preference",
      "storage_preference",
    ],
    antiPredicates: [
      "response_style",
      "code_style_preference",
    ],
    positiveKeywords: [
      "数据库",
      "postgres",
      "mysql",
      "mongodb",
      "sqlite",
      "存储",
    ],
    negativeKeywords: [
      "回答",
      "代码设计",
    ],
  },
  {
    domain: "tool_preference",
    triggers: [
      /(?:工具|tool|用什么.*做|哪个.*好)/,
      /prefer.*tool/,
    ],
    predicates: [
      "tool_preference",
    ],
    antiPredicates: [],
    positiveKeywords: [
      "工具",
      "tool",
      "使用",
      "用",
    ],
    negativeKeywords: [],
  },
];

const BROAD_PATTERNS: readonly RegExp[] = [
  /^总结.*(?:偏好|习惯|特点|风格)/,
  /(?:summarize|summary).*(?:preference|habit)/,
  /(?:有什么|有哪些).*(?:偏好|习惯|特点|风格).*(?:总|概括|汇总|整体)/,
  /(?:知道|了解).*(?:所有|全部|总)/,
  /(?:总的?|整体).*(?:偏好|习惯|特点|风格)/,
  /tell me (?:about |all )?(?:my |your )?(?:preference|habit)s?(?:\?|$)/i,
  /(?:what|show|list).*(?:all |the )?.{0,5}(?:preference|habit)s?(?:\?|$)/i,
  /(?:都有|所有|全部).*(?:偏好|习惯|特点|风格)/,
];

function isSpecificPattern(normalized: string): boolean {
  // Specific patterns indicate the user is asking about a particular domain
  return (
    /对.*有?什么.*(?:偏好|习惯|看法|风格)/.test(normalized) ||
    /喜欢.*什么.*(?:代码|编程|设计|架构|编辑|包|依赖)/.test(normalized) ||
    /(?:代码|编程|设计|架构|编辑|包|依赖).*偏好/.test(normalized) ||
    /喜欢.*哪/.test(normalized) ||
    /习惯.*(?:怎么|如何|怎样|什么)/.test(normalized) ||
    /prefer.*what/i.test(normalized)
  );
}

function isBroadPattern(normalized: string): boolean {
  return BROAD_PATTERNS.some((p) => p.test(normalized));
}

export function analyzeQueryIntent(query: string): MemoryQueryIntent {
  const normalized = query.toLowerCase().trim();

  const isBroad = isBroadPattern(normalized);

  for (const domain of DOMAINS) {
    for (const trigger of domain.triggers) {
      if (trigger.test(normalized)) {
        const specificity = isBroad ? "broad" : "specific";
        return {
          domain: domain.domain,
          predicates: [...domain.predicates],
          specificity,
        };
      }
    }
  }

  const specificity = isBroad
    ? "broad"
    : isSpecificPattern(normalized)
      ? "specific"
      : "broad";

  return { specificity };
}

export function predicateBoostScore(
  content: string,
  intent: MemoryQueryIntent,
  domains: readonly DomainDefinition[] = DOMAINS,
): number {
  if (intent.predicates === undefined || intent.predicates.length === 0) return 0;

  const normalized = content.toLowerCase();
  const domain = domains.find((d) => d.domain === intent.domain);

  if (domain === undefined) return 0;

  let boost = 0;

  for (const kw of domain.positiveKeywords) {
    if (normalized.includes(kw)) {
      boost += 0.06;
    }
  }

  if (intent.specificity === "specific") {
    for (const kw of domain.negativeKeywords) {
      if (normalized.includes(kw)) {
        boost -= 0.15;
      }
    }
  }

  return Math.max(-0.3, Math.min(0.2, boost));
}

export interface PredicateMatchResult {
  readonly predicates: readonly string[];
  readonly domain?: string;
  readonly score: number;
  readonly compatible: boolean;
}

export function predicateCompatibility(
  content: string,
  intent: MemoryQueryIntent,
  domains: readonly DomainDefinition[] = DOMAINS,
): PredicateMatchResult {
  if (intent.predicates === undefined || intent.predicates.length === 0) {
    return { predicates: [], score: 0, compatible: true };
  }

  const normalized = content.toLowerCase();
  const domain = domains.find((d) => d.domain === intent.domain);

  if (domain === undefined) {
    return { predicates: [], score: 0, compatible: true };
  }

  let positiveCount = 0;
  let negativeCount = 0;

  for (const kw of domain.positiveKeywords) {
    if (normalized.includes(kw)) {
      positiveCount++;
    }
  }

  for (const kw of domain.negativeKeywords) {
    if (normalized.includes(kw)) {
      negativeCount++;
    }
  }

  const score =
    (positiveCount / Math.max(1, domain.positiveKeywords.length)) -
    (negativeCount * 0.5);

  const compatible =
    intent.specificity !== "specific" ||
    (positiveCount >= 1 && negativeCount <= 1);

  return Object.assign(
    {
      predicates: [...intent.predicates],
      score: Math.max(-1, Math.min(1, score)),
      compatible,
    },
    intent.domain !== undefined ? { domain: intent.domain } : {},
  ) as PredicateMatchResult;
}

export function computeRelevanceThreshold(intent: MemoryQueryIntent): number {
  if (intent.specificity === "specific") {
    return 0.12; // higher floor for specific queries
  }
  return 0.06; // lower floor for broad queries
}

export function isRelativeScoreDrop(
  scores: readonly number[],
  index: number,
  minDrop: number = 0.22,
): boolean {
  if (index === 0) return false;
  const prev = scores[index - 1];
  const current = scores[index];
  if (prev === undefined || current === undefined) return false;
  return prev - current >= minDrop;
}

export function formatIntentSummary(
  hits: readonly { content: string }[],
  intent: MemoryQueryIntent,
): string | undefined {
  if (hits.length === 0) return undefined;

  if (hits.length === 1) {
    const first = hits[0]!;
    const content = first.content;
    return content.length > 150 ? content.slice(0, 150) + "..." : content;
  }

  const contents = hits.map((h) => h.content);

  if (intent.specificity === "specific" && intent.domain !== undefined) {
    // For specific queries, synthesize around the domain
    const domainLabel = domainLabelForKey(intent.domain);
    const joined = contents.map((c) => c.length > 80 ? c.slice(0, 80) + "..." : c).join("; ");
    return `${domainLabel}: ${joined}`;
  }

  // For broad queries, join with separators
  const joined = contents.map((c) => c.length > 80 ? c.slice(0, 80) + "..." : c).join("; ");
  return joined;
}

function domainLabelForKey(domain: string): string {
  const labels: Record<string, string> = {
    code_design: "代码设计偏好",
    response_style: "回答风格",
    package_manager: "包管理器偏好",
    editor: "编辑器偏好",
    language_preference: "语言偏好",
    database: "数据库偏好",
    tool_preference: "工具偏好",
  };
  return labels[domain] ?? domain;
}
