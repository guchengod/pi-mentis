/**
 * Maintenance Intent Detection — determines if user natural language
 * is explicitly requesting maintenance/diagnostic operations on the
 * Mentis internal store.
 */

import type { ResourceAccessIntent } from "./types.js";

export interface AccessIntentDecision {
  readonly intent: ResourceAccessIntent;
  readonly confidence: number;
  readonly reasons: readonly string[];
  readonly userExplicitlyRequestedMaintenance: boolean;
}

// ─── Maintenance-triggering phrases ────────────────────────────────

const MAINTENANCE_PHRASES: readonly string[] = [
  // Chinese
  "诊断",
  "检查存储",
  "检查仓库",
  "检查库",
  "备份记忆",
  "备份记忆库",
  "备份存储",
  "迁移记忆库",
  "迁移存储",
  "迁移记忆",
  "修复 artifact",
  "修复产物",
  "修复 Artifact",
  "修复损坏",
  "清理损坏",
  "清理过期",
  "导出记忆",
  "导出长期记忆",
  "导出存储",
  "检查 .pi-mentis",
  "检查内部存储",
  "检查 zvec",
  "检查索引",
  "检查 Manifest",
  "修复索引",
  "重建索引",
  "统计记忆",
  "统计记录数",
  "安全审计",
  "权限检查",
  // English
  "diagnose",
  "diagnostic",
  "check store",
  "check storage",
  "inspect store",
  "backup memory",
  "backup storage",
  "migrate memory",
  "migrate storage",
  "repair artifact",
  "fix artifact",
  "repair corruption",
  "clean expired",
  "export memory",
  "export storage",
  "inspect .pi-mentis",
  "check internal",
  "check zvec",
  "check index",
  "rebuild index",
  "memory statistics",
  "record count",
  "security audit",
  "permission check",
  "maintenance mode",
  "maintenance",
];

// ─── Phrases that indicate NOT maintenance ─────────────────────────

const NON_MAINTENANCE_PHRASES: readonly string[] = [
  "帮我看看",
  "查看",
  "查询",
  "找一下",
  "搜索",
  "这条记录",
  "那条记录",
  "看看记录",
  "有什么",
  "是什么",
  "怎么样",
  "告诉我",
  "解释",
  "说明",
  "read",
  "show",
  "find",
  "search",
  "look up",
  "what is",
  "tell me",
  "explain",
  "spark:",
  "spark:", // tool call prefixes
];

// ─── Detection ─────────────────────────────────────────────────────

export function detectAccessIntent(userText: string): AccessIntentDecision {
  const lower = userText.toLowerCase();
  const reasons: string[] = [];

  // Check for non-maintenance patterns first (negative signals)
  const hasNonMaintenance = NON_MAINTENANCE_PHRASES.some((phrase) => lower.includes(phrase));
  if (hasNonMaintenance) {
    reasons.push("text matches retrieval/diagnostic pattern");
  }

  // Check for maintenance-triggering phrases
  const matchedPhrases = MAINTENANCE_PHRASES.filter((phrase) => lower.includes(phrase));

  if (matchedPhrases.length === 0) {
    // No maintenance signal — check explicit_id pattern
    const hasId = /\b[a-f0-9]{16,64}\b/i.test(userText);
    if (hasId) {
      reasons.push("text contains a resource ID pattern");
      return {
        intent: "explicit_id",
        confidence: 0.6,
        reasons,
        userExplicitlyRequestedMaintenance: false,
      };
    }
    // Default: semantic search
    if (userText.trim().length > 0) {
      return {
        intent: "semantic_search",
        confidence: 0.5,
        reasons,
        userExplicitlyRequestedMaintenance: false,
      };
    }
    return {
      intent: "automatic_recall",
      confidence: 0.3,
      reasons,
      userExplicitlyRequestedMaintenance: false,
    };
  }

  // Strong maintenance signal: two or more maintenance phrases
  const confidence = matchedPhrases.length >= 2 ? 0.9 : 0.75;
  reasons.push(`maintenance phrases detected: ${matchedPhrases.join(", ")}`);

  // If the text also contains an ID alongside maintenance command, it's explicit maintenance
  const hasId = /\b[a-f0-9]{16,64}\b/i.test(userText);
  if (hasId) reasons.push("explicit maintenance resource id present");
  if (hasNonMaintenance && matchedPhrases.length < 2) {
    reasons.push(
      "mixed signal: contains both maintenance and non-maintenance keywords → default to search",
    );
    return {
      intent: "semantic_search",
      confidence: 0.5,
      reasons,
      userExplicitlyRequestedMaintenance: false,
    };
  }

  return {
    intent: "maintenance",
    confidence,
    reasons,
    userExplicitlyRequestedMaintenance: true,
  };
}

/**
 * Check if user is explicitly requesting secret restore/reveal.
 * Currently always returns false — secret reveal via chat is not implemented.
 */
export function userRequestsSecretReveal(_userText: string): boolean {
  void _userText;
  // Reserved for future controlled-secret-reveal flows.
  return false;
}
