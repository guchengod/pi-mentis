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

export function decideRecall(signals: RecallSignals): RecallDecision {
  const prompt = signals.prompt.trim();
  if (signals.isCommand || prompt.length < 8) {
    return {
      shouldRecall: false,
      sources: [],
      budgetTokens: 0,
      allowRemoteEmbedding: false,
      allowRerank: false,
      reason: signals.isCommand ? "command-input" : "insufficient-query-signal",
    };
  }
  const memorySignal =
    /\b(?:remember|previous|preference|decision|last time|before)\b|记得|之前|偏好|决定/i.test(
      prompt,
    );
  const knowledgeSignal =
    /\b(?:file|project|api|symbol|documentation|how|where|version|extension|skill|mcp)\b|文件|项目|接口|文档|版本|扩展|技能/i.test(
      prompt,
    );
  if (!memorySignal && !knowledgeSignal && !signals.queryCacheHit && !signals.embeddingCacheHit) {
    return {
      shouldRecall: false,
      sources: [],
      budgetTokens: 0,
      allowRemoteEmbedding: false,
      allowRerank: false,
      reason: "no-recall-intent",
    };
  }
  return {
    shouldRecall: true,
    sources: [
      ...(knowledgeSignal || !memorySignal ? (["knowledge"] as const) : []),
      ...(memorySignal ? (["memory"] as const) : []),
    ],
    budgetTokens: Math.max(0, Math.min(1_600, signals.remainingContextTokens)),
    allowRemoteEmbedding: true,
    allowRerank: signals.remainingContextTokens >= 2_000,
    reason: signals.queryCacheHit
      ? "query-cache"
      : signals.embeddingCacheHit
        ? "embedding-cache"
        : "rule-intent",
  };
}
