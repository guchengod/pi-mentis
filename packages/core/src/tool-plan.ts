export interface ToolPlan {
  readonly tools: readonly (
    "commit_knowledge" | "search_knowledge" | "commit_memory" | "search_memory"
  )[];
  readonly knowledgeFirst: boolean;
}

export function computeToolPlan(knowledge: boolean, memory: boolean): ToolPlan {
  if (memory) {
    return {
      tools: ["commit_memory", "search_memory"],
      knowledgeFirst: knowledge,
    };
  }
  if (knowledge) {
    return {
      tools: ["commit_knowledge", "search_knowledge"],
      knowledgeFirst: false,
    };
  }
  return { tools: [], knowledgeFirst: false };
}
