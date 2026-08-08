/**
 * ValueRelation — Same-Fact / Same-Value semantic equivalence router.
 *
 * Decides the relation between an INCOMING fact and an EXISTING current
 * claim of the SAME fact identity (same factKey, same scope/namespace):
 *
 *   equivalent     → same value (paraphrase)          → reinforce, ID stable
 *   different      → changed value                    → supersede (single)
 *   contradictory  → opposing polarity on same value  → conflict / correct
 *   additive       → new member of a set / keyed set  → coexist
 *   unknown        → cannot determine                 → NO destructive supersede
 *
 * Signals, in priority order (no NL keyword/regex intent rules):
 *   1. structured value: normalizedValue / setMemberKey / predicate-gated
 *      keyed-value lexicon extraction (deterministic, exact equality)
 *   2. embedding cosine similarity between the incoming embedding and the
 *      existing stored vector (zero additional remote calls)
 *   3. polarity agreement (positive vs negative)
 *   4. semantic intent (CommitSemanticPlanner action intent) as a tiebreak
 *      inside the ambiguous similarity band — never decisive alone
 *
 * Structured values always win over similarity. Similarity thresholds are
 * validated against bge-m3-class embeddings, consistent with the
 * semantic-duplicate (0.78) and conflict (0.82) bands already used in the
 * memory write path.
 */

import { normalizeText } from "@pi-mentis/pi-mentis-core";

import type { CommitActionIntent } from "./commit-semantics.js";
import type { TemporalCardinality } from "./types.js";

export type ValueRelation = "equivalent" | "different" | "contradictory" | "additive" | "unknown";

export interface ValueRelationSide {
  readonly content: string;
  readonly embedding: Float32Array | undefined;
  readonly polarity: "positive" | "negative" | undefined;
  readonly normalizedValue: string | undefined;
  readonly setMemberKey: string | undefined;
  readonly cardinality: TemporalCardinality | undefined;
}

export interface ValueRelationInput {
  readonly incoming: ValueRelationSide & {
    readonly semanticIntent: CommitActionIntent | undefined;
  };
  readonly existing: ValueRelationSide;
  /** Predicate extracted from the shared factKey (lexicon gating). */
  readonly predicate: string | undefined;
}

export interface ValueRelationDecision {
  readonly relation: ValueRelation;
  readonly confidence: number;
  readonly embeddingSimilarity: number | undefined;
  readonly normalizedIncomingValue: string | undefined;
  readonly normalizedExistingValue: string | undefined;
  readonly semanticIntent: CommitActionIntent | undefined;
  readonly signal: string;
  readonly factors: readonly string[];
}

// ─── Thresholds (bge-m3-validated) ────────────────────────────────

/** Strong paraphrase evidence — same fact, same value. */
const EQUIV_SIMILARITY = 0.85;
/** Equivalent only when the semantic intent supports reinforcement. */
const EQUIV_INTENT_FLOOR = 0.8;
/** Clearly a different value. */
const DIFF_SIMILARITY = 0.55;
/** Different only when the semantic intent supports replacement. */
const DIFF_INTENT_CEILING = 0.78;
/** Flipped polarity on a similar statement → contradiction. */
const CONTRA_SIMILARITY = 0.6;

// ─── Cosine ───────────────────────────────────────────────────────

function cosine(left: Float32Array, right: Float32Array): number | undefined {
  if (left.length !== right.length || left.length === 0) return undefined;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return undefined;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

// ─── Keyed-value lexicons (deterministic, predicate-gated) ────────

const PACKAGE_MANAGERS = [
  "pnpm",
  "npm",
  "yarn",
  "bun",
  "cargo",
  "gradle",
  "maven",
  "pip",
  "pipenv",
  "poetry",
  "conda",
  "composer",
  "gem",
  "nuget",
  "brew",
] as const;

const RUN_TIMES = [
  "nodejs",
  "node",
  "deno",
  "bun",
  "python",
  "ruby",
  "php",
  "java",
  "golang",
  "go",
  "rust",
  "dotnet",
  "perl",
  "lua",
  "zsh",
  "bash",
  "fish",
  "sh",
  "powershell",
  "pwsh",
] as const;

const DATABASES = [
  "postgresql",
  "postgres",
  "mysql",
  "mariadb",
  "sqlite",
  "mongodb",
  "mongo",
  "redis",
  "cassandra",
  "dynamodb",
  "cockroachdb",
  "clickhouse",
  "elasticsearch",
  "meilisearch",
  "minio",
  "kafka",
  "couchdb",
  "neo4j",
  "oracle",
  "mssql",
] as const;

const LANGUAGES = [
  "golang",
  "typescript",
  "python",
  "java",
  "kotlin",
  "swift",
  "zig",
  "elixir",
  "c++",
  "c#",
  "rust",
  "ruby",
  "php",
  "scala",
  "haskell",
  "clojure",
  "dart",
  "lua",
  "perl",
  "go",
] as const;

const DEPLOYMENT_TARGETS = [
  "vercel",
  "netlify",
  "aws",
  "gcp",
  "azure",
  "docker",
  "kubernetes",
  "k8s",
  "heroku",
  "cloudflare",
  "firebase",
  "digitalocean",
  "render",
  "railway",
] as const;

const PREDICATE_LEXICONS: Readonly<Record<string, readonly string[]>> = {
  package_manager_preference: PACKAGE_MANAGERS,
  general_package_manager_preference: PACKAGE_MANAGERS,
  project_package_manager: PACKAGE_MANAGERS,
  runtime: RUN_TIMES,
  database_preference: DATABASES,
  project_database: DATABASES,
  storage_engine: DATABASES,
  language: LANGUAGES,
  programming_language_preference: LANGUAGES,
  project_deployment_target: DEPLOYMENT_TARGETS,
  // Legacy factKey shorthand used by pre-registry commits (e.g. "package_manager").
  package_manager: PACKAGE_MANAGERS,
  shell: RUN_TIMES,
};

export function keyedValue(content: string, predicate: string | undefined): string | undefined {
  const lexicon = predicate === undefined ? undefined : PREDICATE_LEXICONS[predicate];
  if (lexicon === undefined) return undefined;
  const normalized = normalizeText(content).toLowerCase().replace(/\s+/g, " ");
  const ordered = [...lexicon].sort((a, b) => b.length - a.length);
  for (const token of ordered) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches =
      /^[a-z0-9]+$/i.test(token)
        ? new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i").test(normalized)
        : normalized.includes(token);
    if (matches) return token;
  }
  return undefined;
}

// ─── Router ───────────────────────────────────────────────────────

export function decideValueRelation(input: ValueRelationInput): ValueRelationDecision {
  const { incoming, existing, predicate } = input;
  const factors: string[] = [];

  const structuredIncoming =
    incoming.normalizedValue ?? keyedValue(incoming.content, predicate);
  const structuredExisting =
    existing.normalizedValue ?? keyedValue(existing.content, predicate);

  const similarity =
    incoming.embedding === undefined || existing.embedding === undefined
      ? undefined
      : cosine(incoming.embedding, existing.embedding);

  const polarityDiffers =
    incoming.polarity !== undefined &&
    existing.polarity !== undefined &&
    incoming.polarity !== existing.polarity;

  // 1. Structured value comparison (deterministic, wins over similarity).
  if (structuredIncoming !== undefined && structuredExisting !== undefined) {
    factors.push(`structured:${structuredIncoming}`);
    factors.push(`structured-existing:${structuredExisting}`);
    if (structuredIncoming === structuredExisting) {
      if (polarityDiffers) {
        return {
          relation: "contradictory",
          confidence: 0.9,
          embeddingSimilarity: similarity,
          normalizedIncomingValue: structuredIncoming,
          normalizedExistingValue: structuredExisting,
          semanticIntent: incoming.semanticIntent,
          signal: "same structured value with flipped polarity",
          factors,
        };
      }
      return {
        relation: "equivalent",
        confidence: 0.95,
        embeddingSimilarity: similarity,
        normalizedIncomingValue: structuredIncoming,
        normalizedExistingValue: structuredExisting,
        semanticIntent: incoming.semanticIntent,
        signal: "structured values equal",
        factors,
      };
    }
    if (incoming.cardinality === "set" || incoming.cardinality === "ordered") {
      return {
        relation: "additive",
        confidence: 0.9,
        embeddingSimilarity: similarity,
        normalizedIncomingValue: structuredIncoming,
        normalizedExistingValue: structuredExisting,
        semanticIntent: incoming.semanticIntent,
        signal: "different set member",
        factors,
      };
    }
    return {
      relation: "different",
      confidence: 0.9,
      embeddingSimilarity: similarity,
      normalizedIncomingValue: structuredIncoming,
      normalizedExistingValue: structuredExisting,
      semanticIntent: incoming.semanticIntent,
      signal: "structured values differ",
      factors,
    };
  }
  if (structuredIncoming !== undefined || structuredExisting !== undefined) {
    factors.push("structured value on one side only");
  }

  // 2. Semantic comparison (open natural-language values).
  if (similarity === undefined) {
    factors.push("no comparable embeddings");
    return {
      relation: "unknown",
      confidence: 0.2,
      embeddingSimilarity: undefined,
      normalizedIncomingValue: structuredIncoming,
      normalizedExistingValue: structuredExisting,
      semanticIntent: incoming.semanticIntent,
      signal: "missing embedding",
      factors,
    };
  }
  factors.push(`cosine:${similarity.toFixed(3)}`);

  if (polarityDiffers) {
    factors.push("polarity differs");
    if (similarity >= CONTRA_SIMILARITY) {
      return {
        relation: "contradictory",
        confidence: 0.85,
        embeddingSimilarity: similarity,
        normalizedIncomingValue: structuredIncoming,
        normalizedExistingValue: structuredExisting,
        semanticIntent: incoming.semanticIntent,
        signal: "similar statement with opposite polarity",
        factors,
      };
    }
    return {
      relation: "unknown",
      confidence: 0.2,
      embeddingSimilarity: similarity,
      normalizedIncomingValue: structuredIncoming,
      normalizedExistingValue: structuredExisting,
      semanticIntent: incoming.semanticIntent,
      signal: "polarity differs without similar frame",
      factors,
    };
  }

  const intent = incoming.semanticIntent;
  if (similarity >= EQUIV_SIMILARITY) {
    return {
      relation: "equivalent",
      confidence: Math.min(0.95, 0.7 + (similarity - EQUIV_SIMILARITY) * 2),
      embeddingSimilarity: similarity,
      normalizedIncomingValue: structuredIncoming,
      normalizedExistingValue: structuredExisting,
      semanticIntent: intent,
      signal: "high embedding similarity",
      factors,
    };
  }
  if (similarity <= DIFF_SIMILARITY) {
    return {
      relation: incoming.cardinality === "set" || incoming.cardinality === "ordered"
        ? "additive"
        : "different",
      confidence: 0.75,
      embeddingSimilarity: similarity,
      normalizedIncomingValue: structuredIncoming,
      normalizedExistingValue: structuredExisting,
      semanticIntent: intent,
      signal: "low embedding similarity",
      factors,
    };
  }
  if ((intent === "reinforce" || intent === "correct") && similarity >= EQUIV_INTENT_FLOOR) {
    return {
      relation: "equivalent",
      confidence: 0.6,
      embeddingSimilarity: similarity,
      normalizedIncomingValue: structuredIncoming,
      normalizedExistingValue: structuredExisting,
      semanticIntent: intent,
      signal: "moderate similarity with reinforcing intent",
      factors,
    };
  }
  if (intent === "replace" && similarity <= DIFF_INTENT_CEILING) {
    return {
      relation: incoming.cardinality === "set" || incoming.cardinality === "ordered"
        ? "additive"
        : "different",
      confidence: 0.6,
      embeddingSimilarity: similarity,
      normalizedIncomingValue: structuredIncoming,
      normalizedExistingValue: structuredExisting,
      semanticIntent: intent,
      signal: "moderate similarity with replacing intent",
      factors,
    };
  }
  return {
    relation: "unknown",
    confidence: 0.2,
    embeddingSimilarity: similarity,
    normalizedIncomingValue: structuredIncoming,
    normalizedExistingValue: structuredExisting,
    semanticIntent: intent,
    signal: "ambiguous similarity without supporting intent",
    factors,
  };
}
