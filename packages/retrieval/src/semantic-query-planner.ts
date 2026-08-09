import { normalizeText } from "@pi-mentis/pi-mentis-core";
import type {
  EmbeddingProvider,
  EmbeddingVector,
  InferenceOperationOptions,
} from "@pi-mentis/pi-mentis-inference";

export type QueryRetrievalMode = "focused" | "broad";
export type TemporalQueryIntent = "current" | "historical" | "evolution" | "any";

export interface MemoryQueryPlan {
  readonly temporalIntent: TemporalQueryIntent;
  readonly retrievalMode: QueryRetrievalMode;
  readonly confidence: number;
  readonly memoryNeed: {
    readonly required: boolean;
    readonly confidence: number;
  };
  readonly diagnostics?: {
    readonly plannerDegraded?: boolean;
    readonly sourceDependencySignal?: string;
  };
}

export interface PreparedSemanticQuery {
  readonly queryEmbedding?: EmbeddingVector;
  readonly plan: MemoryQueryPlan;
}

export interface SemanticQueryPlannerOptions {
  readonly embedding: EmbeddingProvider;
  readonly modelId: string;
  readonly dimensions: number;
}

/**
 * V2 prepares one reusable query vector and deliberately makes no semantic
 * class prediction. Relevance is decided by retrieval, rerank, gates, MMR and
 * the token budget; callers may still provide an explicit temporal mode.
 */
export class SemanticQueryPlanner {
  readonly #embedding: EmbeddingProvider;
  readonly #dimensions: number;

  constructor(options: SemanticQueryPlannerOptions) {
    this.#embedding = options.embedding;
    this.#dimensions = options.dimensions;
  }

  warmup(): void {
    // V2 startup has no remote warmup work.
  }

  async prepare(
    query: string,
    options: InferenceOperationOptions = {},
  ): Promise<PreparedSemanticQuery> {
    try {
      const response = await this.#embedding.embed(
        {
          inputs: [normalizeText(query)],
          inputKind: "query",
          dimensions: this.#dimensions,
          truncate: "reject",
        },
        { ...options, priority: "interactive" },
      );
      return {
        ...(response.vectors[0] === undefined ? {} : { queryEmbedding: response.vectors[0] }),
        plan: {
          temporalIntent: "any",
          retrievalMode: "broad",
          confidence: 1,
          memoryNeed: { required: true, confidence: 1 },
          diagnostics: { sourceDependencySignal: "classless_retrieval" },
        },
      };
    } catch {
      return {
        plan: {
          temporalIntent: "any",
          retrievalMode: "broad",
          confidence: 0,
          memoryNeed: { required: true, confidence: 0 },
          diagnostics: { plannerDegraded: true },
        },
      };
    }
  }
}
