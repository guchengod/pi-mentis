import type { CommitMemoryCommand, MemoryRecord, MemoryRelationship } from "./types.js";
import { acceptsRelationshipProposal } from "./relationship-evidence.js";

export interface RelationshipCandidate {
  readonly record: Omit<MemoryRecord, "embedding">;
  /** Candidate-discovery signal only. Never sufficient for a relationship. */
  readonly similarity: number;
}

export interface RelationshipResolution {
  readonly relation: MemoryRelationship;
  readonly targetIds: readonly string[];
  readonly confidence: number;
  readonly reasonCodes: readonly string[];
}

export interface MemoryRelationshipResolver {
  resolve(
    incoming: Pick<CommitMemoryCommand, "content" | "relationshipEvidence">,
    candidates: readonly RelationshipCandidate[],
  ): RelationshipResolution;
}

export class DefaultMemoryRelationshipResolver implements MemoryRelationshipResolver {
  resolve(
    incoming: Pick<CommitMemoryCommand, "content" | "relationshipEvidence">,
    candidates: readonly RelationshipCandidate[],
  ): RelationshipResolution {
    const explicit = incoming.relationshipEvidence;
    if (explicit !== undefined) {
      const targetIds = [...new Set(explicit.targetIds)].filter((id) => id.length > 0);
      if (targetIds.length !== explicit.targetIds.length || targetIds.length === 0) {
        return {
          relation: candidates.length === 0 ? "unrelated" : "uncertain",
          targetIds: [],
          confidence: 0,
          reasonCodes: ["insufficient_identity_evidence"],
        };
      }
      if (explicit.source !== undefined && explicit.source !== "explicit_internal") {
        if (!acceptsRelationshipProposal(explicit)) {
          return {
            relation: "coexist",
            targetIds,
            confidence: Math.max(0, Math.min(1, explicit.confidence)),
            reasonCodes: ["pairwise_evidence_below_transition_threshold"],
          };
        }
      }
      return {
        relation: explicit.relation,
        targetIds,
        confidence: Math.max(0, Math.min(1, explicit.confidence)),
        reasonCodes: [...new Set(explicit.reasonCodes)],
      };
    }

    const ranked = [...candidates].sort((left, right) => right.similarity - left.similarity);
    const strongest = ranked[0];
    if (strongest === undefined) {
      return {
        relation: "unrelated",
        targetIds: [],
        confidence: 1,
        reasonCodes: ["no_relationship_candidate"],
      };
    }

    if (strongest.similarity >= 0.55) {
      return {
        relation: "coexist",
        targetIds: [strongest.record.id],
        confidence: 0.7,
        reasonCodes: ["semantic_similarity_candidate_only", "insufficient_identity_evidence"],
      };
    }
    return {
      relation: "unrelated",
      targetIds: [],
      confidence: 0.9,
      reasonCodes: ["insufficient_identity_evidence"],
    };
  }
}
