/**
 * Recall Planner — Retrieval-First Architecture
 *
 * KEY PRINCIPLE: Don't decide whether to search based on how the user phrased
 * the question. Always run a cheap Fast Recall, then decide based on what the
 * system actually found.
 *
 * Semantic intent is planned from the shared query embedding in
 * SemanticQueryPlanner. This module only retains structural fast-lane scoring.
 */

// ─── Intent Signals (weak, ≤0.15 weight) ──────────────────────────

export type RecallIntent =
  | "user_preference"
  | "project_state"
  | "task_continuation"
  | "historical_reason"
  | "topic_recall"
  | "procedure_reuse"
  | "capability_recall"
  | "user_profile"
  | "agent_profile"
  | "current_project_fact"
  | "knowledge_lookup"
  | "credential_reference"
  | "explicit_memory_lookup"
  | "no_recall"
  | "current_input_only";

export type IntentScores = Record<RecallIntent, number>;

/**
 * Backward-compatible structural signal surface. Semantic classifications are
 * intentionally zero here; callers must use SemanticQueryPlanner.
 */
export function classifyIntentScores(prompt: string): IntentScores {
  const normalized = prompt.toLowerCase().trim();
  const scores: Record<string, number> = {
    user_preference: 0,
    project_state: 0,
    task_continuation: 0,
    historical_reason: 0,
    topic_recall: 0,
    procedure_reuse: 0,
    capability_recall: 0,
    no_recall: 0,
    current_input_only: 0,
  };

  // No recall if empty or command
  if (normalized.length < 2) {
    scores["no_recall"] = 1;
    scores["current_input_only"] = 1;
    return scores as IntentScores;
  }

  return scores as IntentScores;
}

// ─── Source-Specific Calibration ──────────────────────────────────

/**
 * Different sources have fundamentally different authority scales.
 * Knowledge authority (80) should NOT beat user Memory authority (10).
 * Each source is calibrated to a common 0-1 scale.
 */
export type RecallSource =
  "exact_fact" | "user_view" | "project_view" | "agent_view" | "memory" | "knowledge";

export interface RankedCandidate {
  readonly id: string;
  readonly kind: "memory" | "knowledge" | "capability";
  readonly source: RecallSource;
  readonly text: string;
  readonly scope?: { readonly kind: string; readonly id: string };
  readonly factKey?: string;
  readonly status?: string;
  readonly temporalState?: string;

  readonly sourceScore: number;
  readonly calibratedScore: number;
  readonly intentAffinity: number;
  readonly scopeAffinity: number;
  readonly finalScore: number;

  readonly matchReason?: string;
  readonly evidenceSummary?: string;
}

/**
 * Calibrate authority across sources so Knowledge doesn't drown Memory.
 */
export function calibrateSourceScore(source: RecallSource, rawAuthority: number): number {
  switch (source) {
    case "exact_fact":
      return 1.0;
    case "user_view":
    case "agent_view":
      return 0.95;
    case "project_view":
      return 0.8;
    case "memory":
      return 0.6 + (rawAuthority / 100) * 0.3;
    case "knowledge":
      return 0.1;
    default:
      return 0.5;
  }
}

/**
 * Determine lane priority from intent. Memory vs Knowledge lanes.
 */
export function lanePriority(intentScores: IntentScores): {
  memoryWeight: number;
  knowledgeWeight: number;
  credentialOnly: boolean;
} {
  const profile =
    (intentScores.user_profile ?? 0) +
    (intentScores.agent_profile ?? 0) +
    (intentScores.user_preference ?? 0) +
    (intentScores.explicit_memory_lookup ?? 0);

  const knowledge = intentScores.knowledge_lookup ?? 0;
  const credential = intentScores.credential_reference ?? 0;

  // Credential queries: ONLY secret references, no general knowledge
  if (credential >= 0.7) {
    return { memoryWeight: 1.0, knowledgeWeight: 0.0, credentialOnly: true };
  }

  // Profile/preference queries: Memory lane dominates, Knowledge suppressed
  if (profile >= 0.5) {
    return { memoryWeight: 1.0, knowledgeWeight: 0.05, credentialOnly: false };
  }

  // Knowledge queries: Knowledge lane primary, Memory supplemental
  if (knowledge >= 0.5) {
    return { memoryWeight: 0.3, knowledgeWeight: 1.0, credentialOnly: false };
  }

  // Default: both lanes, Memory preferred
  return { memoryWeight: 1.0, knowledgeWeight: 0.3, credentialOnly: false };
}

// ─── Existing code continues ─────────────────────────────────────

export interface RecallQueryContext {
  readonly currentMessage: string;
  readonly recentUserMessages: readonly string[];
  readonly activeGoal?: string;
  readonly taskId?: string;
  readonly repositoryId?: string;
  readonly projectId?: string;
  readonly topicIds?: readonly string[];
  readonly branchId?: string;
  readonly recentToolErrors?: readonly string[];
  readonly recentFiles?: readonly string[];
}

/**
 * Build a rich query string from context, not just the current message.
 * This makes recall work for pronouns and implicit references like
 * "那这个呢？" or "为什么当时换掉了？"
 */
export function buildRecallQuery(context: RecallQueryContext): string {
  const parts: string[] = [context.currentMessage];

  // Last user message for continuation context
  const prevUser = context.recentUserMessages[context.recentUserMessages.length - 1];
  if (prevUser !== undefined && prevUser !== context.currentMessage) {
    parts.push(prevUser);
  }

  // Active goal
  if (context.activeGoal !== undefined && context.activeGoal.length > 0) {
    parts.push(context.activeGoal);
  }

  // Task context
  if (context.taskId !== undefined) {
    parts.push(`task:${context.taskId}`);
  }

  // Project/repo context
  if (context.repositoryId !== undefined) {
    parts.push(`repo:${context.repositoryId}`);
  } else if (context.projectId !== undefined) {
    parts.push(`project:${context.projectId}`);
  }

  // Recent failures — high signal for debugging recall
  if (context.recentToolErrors !== undefined && context.recentToolErrors.length > 0) {
    parts.push(...context.recentToolErrors.slice(0, 3));
  }

  return parts.filter((p) => p.length > 0).join(" ");
}

// ─── Fast Recall Candidate ────────────────────────────────────────

export interface FastRecallCandidate {
  readonly id: string;
  readonly text: string;
  readonly kind: "memory" | "knowledge" | "capability";
  readonly source: "view" | "temporal_head" | "fts" | "cache" | "cached_vector";

  readonly semanticScore: number;
  readonly lexicalScore: number;
  readonly scopeAffinity: number;
  readonly taskContinuity: number;
  readonly temporalRelevance: number;
  readonly trustScore: number;
  readonly applicabilityScore: number;

  readonly finalScore: number;
}

// ─── Scoring ──────────────────────────────────────────────────────

export interface CandidateScoringInput {
  readonly candidate: {
    readonly id: string;
    readonly text: string;
    readonly kind: "memory" | "knowledge" | "capability";
    readonly scope?: { readonly kind: string; readonly id: string };
    readonly taskId?: string;
    readonly branchId?: string;
    readonly authority: number;
    readonly observedAt: number;
    readonly updatedAt: number;
    readonly confidence?: number;
    readonly semanticSimilarity?: number;
    readonly lexicalMatchCount?: number;
  };
  readonly context: RecallQueryContext;
  readonly now: number;
}

/**
 * Task continuity: how well the candidate aligns with the current task.
 * This is MORE reliable than keyword matching.
 */
export function taskContinuityScore(
  candidate: CandidateScoringInput["candidate"],
  context: RecallQueryContext,
): number {
  let score = 0;

  if (candidate.taskId !== undefined && candidate.taskId === context.taskId) {
    score += 0.35;
  }

  if (
    candidate.scope !== undefined &&
    context.repositoryId !== undefined &&
    (candidate.scope.kind === "repository" || candidate.scope.kind === "project") &&
    candidate.scope.id === context.repositoryId
  ) {
    score += 0.25;
  }

  if (
    candidate.branchId !== undefined &&
    context.branchId !== undefined &&
    candidate.branchId === context.branchId
  ) {
    score += 0.1;
  }

  return Math.min(score, 1);
}

/**
 * Scope affinity: how relevant the candidate's scope is to the current context.
 */
export function scopeAffinityScore(
  candidate: CandidateScoringInput["candidate"],
  context: RecallQueryContext,
): number {
  if (candidate.scope === undefined) return 0.3; // unknown scope, low affinity

  // Exact match
  if (context.repositoryId !== undefined && candidate.scope.id === context.repositoryId) {
    return 1.0;
  }
  if (context.projectId !== undefined && candidate.scope.id === context.projectId) {
    return 0.9;
  }
  if (context.taskId !== undefined && candidate.scope.id === context.taskId) {
    return 0.85;
  }

  // User scope always relevant for current user
  if (candidate.scope.kind === "user") return 0.6;

  // Topic scope: relevant if active topic matches
  if (
    candidate.scope.kind === "topic" &&
    context.topicIds !== undefined &&
    context.topicIds.includes(candidate.scope.id)
  ) {
    return 0.7;
  }

  return 0.2; // unrelated scope
}

/**
 * Temporal relevance: how fresh/relevant the candidate is.
 */
export function temporalRelevanceScore(
  candidate: CandidateScoringInput["candidate"],
  now: number,
): number {
  const ageMs = now - Math.max(candidate.observedAt, candidate.updatedAt);
  const ageHours = ageMs / (1000 * 60 * 60);

  if (ageHours < 1) return 1.0;
  if (ageHours < 24) return 0.9;
  if (ageHours < 168) return 0.7; // 1 week
  if (ageHours < 720) return 0.5; // 1 month
  return 0.3; // older
}

/**
 * Compute final recall score from multiple dimensions.
 */
export function computeCandidateScore(input: CandidateScoringInput): FastRecallCandidate {
  const semantic = input.candidate.semanticSimilarity ?? 0;
  const lexical = Math.min(1, (input.candidate.lexicalMatchCount ?? 0) / 10);
  const scopeAff = scopeAffinityScore(input.candidate, input.context);
  const taskCont = taskContinuityScore(input.candidate, input.context);
  const temporal = temporalRelevanceScore(input.candidate, input.now);
  const trust = (input.candidate.confidence ?? 0.7) * (input.candidate.authority / 100);
  const applicability = 0.5; // default

  const finalScore =
    0.25 * semantic +
    0.15 * lexical +
    0.2 * scopeAff +
    0.15 * taskCont +
    0.1 * temporal +
    0.1 * trust +
    0.05 * applicability;

  return {
    id: input.candidate.id,
    text: input.candidate.text,
    kind: input.candidate.kind,
    source: "cache",
    semanticScore: semantic,
    lexicalScore: lexical,
    scopeAffinity: scopeAff,
    taskContinuity: taskCont,
    temporalRelevance: temporal,
    trustScore: trust,
    applicabilityScore: applicability,
    finalScore,
  };
}

// ─── Recall Decision ──────────────────────────────────────────────

export type RecallDecisionKind =
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "inject_fast"; readonly candidateIds: readonly string[] }
  | { readonly kind: "quality_search"; readonly reason: string };

/**
 * Decide what to do based on fast recall candidates and intent signals.
 *
 * Decision logic:
 * - Top1 >= 0.78 AND Top1-Top2 >= 0.08 → inject directly
 * - Top1 >= 0.55 AND < 0.78 → quality search
 * - Top1 < 0.55 → skip
 *
 * Intent signals only boost by up to 0.05.
 */
export function evaluateRecallDecision(
  candidates: readonly FastRecallCandidate[],
  intentScores: IntentScores,
): RecallDecisionKind {
  if (candidates.length === 0) {
    return { kind: "skip", reason: "no-candidates" };
  }

  const top1 = candidates[0];
  if (top1 === undefined) return { kind: "skip", reason: "no-candidates" };

  const top2 = candidates[1];

  // Apply weak intent boost (max 0.05)
  const maxIntentBoost = Math.max(
    0,
    ...(Object.values(intentScores).filter((s) => typeof s === "number") as number[]),
  );
  const intentBoost = Math.min(0.05, maxIntentBoost * 0.05);

  const boostedTop1 = Math.min(1, top1.finalScore + intentBoost);

  // High confidence + clear margin → inject directly
  if (boostedTop1 >= 0.78 && (top2 === undefined || boostedTop1 - top2.finalScore >= 0.08)) {
    return {
      kind: "inject_fast",
      candidateIds: candidates.slice(0, 5).map((c) => c.id),
    };
  }

  // Medium confidence → quality search
  if (boostedTop1 >= 0.55) {
    return { kind: "quality_search", reason: "medium-confidence" };
  }

  // Low confidence → skip
  return { kind: "skip", reason: "low-confidence" };
}

// ─── High-level recall planner (backward compatible) ──────────────

export interface RecallDecision {
  readonly shouldRecall: boolean;
  readonly sources: readonly ("knowledge" | "memory")[];
  readonly budgetTokens: number;
  readonly allowRemoteEmbedding: boolean;
  readonly allowRerank: boolean;
  readonly reason: string;
}

export interface RecallSignals {
  readonly prompt: string;
  readonly queryCacheHit: boolean;
  readonly embeddingCacheHit: boolean;
  readonly remainingContextTokens: number;
  readonly isCommand: boolean;
}

/**
 * ALWAYS-ON Fast Recall: every non-command, non-trivial input triggers recall.
 *
 * Semantic memory need is decided after embedding by SemanticQueryPlanner.
 */
export function decideRecall(signals: RecallSignals): RecallDecision {
  const prompt = signals.prompt.trim();

  // Only skip for commands and trivially short input
  if (signals.isCommand) {
    return {
      shouldRecall: false,
      sources: [],
      budgetTokens: 0,
      allowRemoteEmbedding: false,
      allowRerank: false,
      reason: "command-input",
    };
  }

  if (prompt.length < 2) {
    return {
      shouldRecall: false,
      sources: [],
      budgetTokens: 0,
      allowRemoteEmbedding: false,
      allowRerank: false,
      reason: "insufficient-query-signal",
    };
  }

  // Always recall for everything else. Fast lane: no rerank, cheap embedding.
  return {
    shouldRecall: true,
    sources: ["memory"],
    budgetTokens: Math.max(0, Math.min(1_600, signals.remainingContextTokens)),
    allowRemoteEmbedding: signals.remainingContextTokens >= 500,
    allowRerank: false,
    reason: "always-on-fast-recall",
  };
}
