/**
 * Recall Intent — classifies user queries into recall lanes.
 *
 * This replaces the old hard-gate keyword approach.
 * Instead of blocking short questions, we route them through the correct lane.
 *
 * Lanes (priority ordered by intent):
 *   - agent_profile → Agent Profile View → User Memory
 *   - user_profile → User Profile View → User Memory
 *   - current_project_fact → Repository/Project Exact → View → Memory
 *   - historical_event → Event Lane (temporal search)
 *   - task_continuation → Task Lane
 *   - procedure → Procedure Lane
 *   - explicit_memory_lookup → Exact ID → Memory
 *   - knowledge_lookup → Knowledge → Project Memory supplement
 *   - cross_project_compare → Knowledge + Memory
 *   - no_recall → skip all lanes
 *   - unknown → Fast Recall (L1) first, decide after
 */

export type RecallIntent =
  | "user_profile"
  | "agent_profile"
  | "current_project_fact"
  | "historical_event"
  | "task_continuation"
  | "procedure"
  | "explicit_memory_lookup"
  | "knowledge_lookup"
  | "cross_project_compare"
  | "no_recall"
  | "unknown";

export interface IntentClassification {
  readonly primary: RecallIntent;
  readonly secondary: RecallIntent[];
  readonly scores: Partial<Record<RecallIntent, number>>;
}

/**
 * Classify user input into a primary recall intent.
 *
 * KEY: Short questions like "你叫什么？" and "怎么构建？" must route
 * to the correct lane, not be blocked by length gates.
 */
export function classifyIntent(input: string): IntentClassification {
  const normalized = input.toLowerCase().trim();
  const addScore = (
    target: Partial<Record<RecallIntent, number>>,
    key: RecallIntent,
    value: number,
  ) => {
    target[key] = value;
  };

  // Empty input → no_recall
  if (normalized.length < 1) {
    return { primary: "no_recall", secondary: [], scores: { no_recall: 1 } };
  }

  // ─── Agent profile: what's your name? ───
  if (
    /你(?:叫|是)什?么名?字?|你的名?字|怎么称呼你|(?:what'?s? )?your name|call yourself|你是谁|who are you/i.test(
      normalized,
    )
  ) {
    const s: Partial<Record<RecallIntent, number>> = {};
    addScore(s, "agent_profile", 0.95);
    addScore(s, "explicit_memory_lookup", 0.3);
    return { primary: "agent_profile", secondary: ["explicit_memory_lookup"], scores: s };
  }

  // ─── User profile: what's my name? ───
  if (/我(?:叫|是)什?么名?字?|我的名?字|what'?s? my name|who am i|我是谁/i.test(normalized)) {
    const s: Partial<Record<RecallIntent, number>> = {};
    addScore(s, "user_profile", 0.95);
    addScore(s, "explicit_memory_lookup", 0.3);
    return { primary: "user_profile", secondary: ["explicit_memory_lookup"], scores: s };
  }

  // ─── User preference: how do I like...? ───
  if (
    /我(?:喜欢|习惯|偏好|一般|平时|经常|总是)|i (?:prefer|like|usually|always|tend to)|my (?:preference|style|habit)|我还用.*吗|还用.*吗/i.test(
      normalized,
    )
  ) {
    const s: Partial<Record<RecallIntent, number>> = {};
    addScore(s, "user_profile", 0.85);
    return { primary: "user_profile", secondary: [], scores: s };
  }

  // ─── Current project fact: how to build? what's the package manager? ───
  if (
    /怎么(?:构建|编译|测试|部署|打包|安装|运行)|how (?:to|do I) (?:build|compile|test|deploy|run|install)|(?:build|test|deploy) command|用什么.*(?:构建|包管理|测试|部署)|这个项目|this project/i.test(
      normalized,
    )
  ) {
    const s: Partial<Record<RecallIntent, number>> = {};
    addScore(s, "current_project_fact", 0.9);
    addScore(s, "procedure", 0.4);
    return { primary: "current_project_fact", secondary: ["procedure"], scores: s };
  }

  // ─── Historical event: why did build fail last time? ───
  if (
    /上次|上[个次回]|之前|为什么.*失败|上次.*构建|之前.*错误|上一次|what happened|last time|previous/i.test(
      normalized,
    )
  ) {
    const s: Partial<Record<RecallIntent, number>> = {};
    addScore(s, "historical_event", 0.85);
    return { primary: "historical_event", secondary: [], scores: s };
  }

  // ─── Task continuation ───
  if (/继续|接着|go on|continue|下一步|next step|进展|progress update/i.test(normalized)) {
    const s: Partial<Record<RecallIntent, number>> = {};
    addScore(s, "task_continuation", 0.85);
    return { primary: "task_continuation", secondary: [], scores: s };
  }

  // ─── Procedure reuse ───
  if (
    /步骤|流程|workflow|procedure|怎么(?:做|搞|弄)|how to|tutorial|guide|教程|指南/i.test(
      normalized,
    )
  ) {
    const s: Partial<Record<RecallIntent, number>> = {};
    addScore(s, "procedure", 0.8);
    addScore(s, "knowledge_lookup", 0.4);
    return { primary: "procedure", secondary: ["knowledge_lookup"], scores: s };
  }

  // ─── Explicit memory lookup ───
  if (
    /记忆(?:中的|里的?|过的?)|(?:remember|recall)(?:.{0,10})(?:from|in).{0,5}memory|记忆中|查(?:一下|查)记忆|search memory/i.test(
      normalized,
    )
  ) {
    const s: Partial<Record<RecallIntent, number>> = {};
    addScore(s, "explicit_memory_lookup", 0.9);
    return { primary: "explicit_memory_lookup", secondary: [], scores: s };
  }

  // ─── Knowledge lookup ───
  if (
    /(?:how does|what is|how to|documentation|文档|spec|规范|protocol|协议|oauth|实现|怎么.*实现|架构|architecture|api|sdk)/i.test(
      normalized,
    ) &&
    !/这个项目|this project|项目里|当前仓库/i.test(normalized)
  ) {
    const s: Partial<Record<RecallIntent, number>> = {};
    addScore(s, "knowledge_lookup", 0.8);
    return { primary: "knowledge_lookup", secondary: [], scores: s };
  }

  // ─── Cross-project comparison ───
  if (/比较|对比|compare|difference|between .* and|versus|vs\./i.test(normalized)) {
    const s: Partial<Record<RecallIntent, number>> = {};
    addScore(s, "cross_project_compare", 0.7);
    addScore(s, "knowledge_lookup", 0.5);
    return { primary: "cross_project_compare", secondary: ["knowledge_lookup"], scores: s };
  }

  // ─── Greetings / simple → no recall ───
  if (/^(?:你好|hi|hello|hey|thanks|thank you|ok|好的|bye|再见)[\s!！。，,.]*$/i.test(normalized)) {
    return { primary: "no_recall", secondary: [], scores: { no_recall: 0.9 } };
  }

  // ─── Math / translation → no recall ───
  if (/^(?:计算|translate|convert|翻译|what is \d+[\s+/*-]+)/i.test(normalized)) {
    return { primary: "no_recall", secondary: [], scores: { no_recall: 0.7 } };
  }

  // ─── Default: unknown → L1 Fast Recall ───
  return { primary: "unknown", secondary: [], scores: { unknown: 0.5 } };
}
