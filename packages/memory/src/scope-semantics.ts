import { normalizeText } from "@pi-mentis/pi-mentis-core";
import type {
  EmbeddingProvider,
  EmbeddingVector,
  InferenceOperationOptions,
} from "@pi-mentis/pi-mentis-inference";

import type { MemoryScope, PiScopeContext } from "./types.js";

export type ScopeOwnerKind = "user" | "project" | "repository" | "task" | "topic";

export interface ExtractedFact {
  readonly content: string;
  readonly embedding: Float32Array;
}

export interface ScopeOwnershipDecision {
  readonly ownerKind: ScopeOwnerKind;
  readonly ownerId: string;
  readonly confidence: number;
  readonly reason: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface ScopeSemanticPlannerOptions {
  readonly embedding: EmbeddingProvider;
  readonly dimensions: number;
}

/**
 * V2 scope ownership is conservative and structural. Public user assertions
 * default to durable user scope; internal workspace/tool producers already
 * supply their explicit scope to MemoryService and bypass this coordinator.
 * No startup semantic index or remote warmup work exists here.
 */
export class ScopeSemanticPlanner {
  readonly embedding: EmbeddingProvider;
  readonly dimensions: number;

  constructor(options: ScopeSemanticPlannerOptions) {
    this.embedding = options.embedding;
    this.dimensions = options.dimensions;
  }

  async decideOwnership(
    fact: ExtractedFact,
    context: PiScopeContext,
    options: InferenceOperationOptions = {},
  ): Promise<ScopeOwnershipDecision> {
    return {
      ownerKind: "user",
      ownerId: context.userId,
      confidence: 1,
      reason: "classless conservative ownership: explicit user assertion",
      evidence: {
        structural: true,
        coldStartIndex: false,
        contentLength: fact.content.length,
        requestCancelled: options.signal?.aborted ?? false,
      },
    };
  }
}

export function resolveOwnerId(kind: ScopeOwnerKind, context: PiScopeContext): string | undefined {
  switch (kind) {
    case "user":
      return context.userId;
    case "project":
      return context.projectId;
    case "repository":
      return context.repositoryId;
    case "task":
      return context.taskId;
    case "topic":
      return context.topicIds?.[0];
  }
}

export function memoryScopeForDecision(
  decision: ScopeOwnershipDecision,
  context: PiScopeContext,
): MemoryScope {
  return {
    kind: decision.ownerKind,
    id: decision.ownerId || resolveOwnerId(decision.ownerKind, context) || context.userId,
  };
}

export async function embedFactContent(
  embedding: EmbeddingProvider,
  content: string,
  dimensions: number,
  options: InferenceOperationOptions = {},
): Promise<EmbeddingVector> {
  const response = await embedding.embed(
    {
      inputs: [normalizeText(content)],
      inputKind: "memory",
      dimensions,
      truncate: "reject",
    },
    { ...options, priority: "interactive" },
  );
  const vector = response.vectors[0];
  if (vector === undefined) throw new Error("Scope planning embedding response is empty");
  return vector;
}
