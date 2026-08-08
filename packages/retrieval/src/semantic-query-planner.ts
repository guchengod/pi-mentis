import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { contentHash, normalizeText } from "@pi-mentis/pi-mentis-core";
import {
  buildPredicateSemanticText,
  DEFAULT_PREDICATE_REGISTRY,
  toRemoteSafe,
  type MemorySubjectType,
  type PredicateRegistry,
} from "@pi-mentis/pi-mentis-memory-core";
import type {
  EmbeddingProvider,
  EmbeddingVector,
  InferenceOperationOptions,
} from "@pi-mentis/pi-mentis-inference";

export type QueryRetrievalMode = "focused" | "broad";
export type TemporalQueryIntent = "current" | "historical" | "evolution" | "any";

// ─── Source Dependency Ontology ──────────────────────────────────
// Abstract semantic definitions — NOT utterance examples. Each class
// defines what kind of information source the answer requires.
// MemoryNeed is derived from predicate routing metadata + this
// ontology, NOT from enumerated natural-language sentences.

export type SourceDependency =
  | "prior_user_state"
  | "general_knowledge"
  | "unknown";

export interface MemoryNeedClass {
  readonly id: SourceDependency;
  readonly semanticDescription: string;
}

export const MEMORY_NEED_ONTOLOGY: readonly MemoryNeedClass[] = [
  {
    id: "prior_user_state",
    semanticDescription:
      "The answer depends on user-specific state, preferences, conventions, or history established before the current turn.",
  },
  {
    id: "general_knowledge",
    semanticDescription:
      "The answer can be produced from general knowledge, current context, or live runtime state without requiring prior user-specific information.",
  },
];

export interface PredicateSemanticEntry {
  readonly predicate: string;
  readonly vector: Float32Array;
}

export interface PredicateSemanticScore {
  readonly predicate: string;
  readonly score: number;
}

export interface PredicateSemanticIndex {
  rank(
    queryVector: Float32Array,
    options?: { readonly limit?: number },
  ): readonly PredicateSemanticScore[];
}

export interface PredicateCandidate {
  readonly predicate: string;
  readonly confidence: number;
}

export interface SubjectCandidate {
  readonly subject: MemorySubjectType;
  readonly confidence: number;
}

export interface MemoryQueryPlan {
  readonly predicateCandidates: readonly PredicateCandidate[];
  readonly subjectCandidates: readonly SubjectCandidate[];
  readonly temporalIntent: TemporalQueryIntent;
  readonly retrievalMode: QueryRetrievalMode;
  readonly confidence: number;
  readonly memoryNeed: {
    readonly required: boolean;
    readonly confidence: number;
  };
  readonly sourceDependency?: SourceDependency;
  readonly diagnostics?: {
    readonly predicateMargin?: number;
    readonly predicateEntropy?: number;
    readonly plannerDegraded?: boolean;
    readonly sourceDependencySignal?: string;
  };
}

export interface PreparedSemanticQuery {
  readonly queryEmbedding?: EmbeddingVector;
  readonly plan: MemoryQueryPlan;
}

export interface PredicateVectorCacheRecord {
  readonly schemaVersion: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly dimensions: number;
  readonly entries: readonly {
    readonly predicate: string;
    readonly vector: readonly number[];
  }[];
}

export interface PredicateVectorCache {
  load(): Promise<PredicateVectorCacheRecord | undefined>;
  save(record: PredicateVectorCacheRecord): Promise<void>;
}

export class FilePredicateVectorCache implements PredicateVectorCache {
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;
  }

  async load(): Promise<PredicateVectorCacheRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.#file, "utf8")) as PredicateVectorCacheRecord;
    } catch (error: unknown) {
      const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
      if (code === "ENOENT" || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  async save(record: PredicateVectorCacheRecord): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), "utf8");
    await rename(temporary, this.#file);
  }
}

function cosine(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || left.length === 0) return -1;
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
  if (leftNorm === 0 || rightNorm === 0) return -1;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

export class InMemoryPredicateSemanticIndex implements PredicateSemanticIndex {
  readonly #entries: readonly PredicateSemanticEntry[];

  constructor(entries: readonly PredicateSemanticEntry[]) {
    this.#entries = [...entries];
  }

  rank(
    queryVector: Float32Array,
    options: { readonly limit?: number } = {},
  ): readonly PredicateSemanticScore[] {
    const limit = Math.max(
      0,
      Math.min(this.#entries.length, options.limit ?? this.#entries.length),
    );
    return this.#entries
      .map((entry) => ({ predicate: entry.predicate, score: cosine(queryVector, entry.vector) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizedEntropy(scores: readonly number[]): number {
  if (scores.length <= 1) return 0;
  const maximum = Math.max(...scores);
  const weights = scores.map((score) => Math.exp((score - maximum) / 0.08));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const entropy = weights.reduce((sum, weight) => {
    const probability = weight / total;
    return probability <= 0 ? sum : sum - probability * Math.log(probability);
  }, 0);
  return entropy / Math.log(weights.length);
}

export function inferRetrievalMode(
  rankedPredicates: readonly PredicateSemanticScore[],
): QueryRetrievalMode {
  if (rankedPredicates.length <= 1) return "focused";
  const top = rankedPredicates[0]?.score ?? -1;
  const second = rankedPredicates[1]?.score ?? -1;
  const distribution = rankedPredicates.slice(0, 6).map((entry) => entry.score);
  const entropy = normalizedEntropy(distribution);
  const nearTop = distribution.filter((score) => top - score <= 0.1).length;
  return top - second >= 0.12 || (entropy < 0.72 && nearTop <= 2) ? "focused" : "broad";
}

function temporalIntent(
  query: string,
  candidates: readonly PredicateCandidate[],
  registry: PredicateRegistry,
): TemporalQueryIntent {
  const normalized = normalizeText(query).toLowerCase();
  const hasEvolution =
    /(?:以前.*现在|之前.*后来|变化|演变|变更历史|evol(?:ve|ution)|how .* changed)/iu.test(
      normalized,
    );
  if (hasEvolution) return "evolution";
  const hasHistorical =
    /(?:以前|之前|当时|过去|历史|曾经|原来|previously|histor(?:y|ical)|used to|before)/iu.test(
      normalized,
    );
  const hasCurrent = /(?:现在|目前|当前|如今|最新|current(?:ly)?|right now|latest)/iu.test(
    normalized,
  );
  if (hasHistorical && hasCurrent) return "evolution";
  if (hasHistorical) return "historical";
  if (hasCurrent) return "current";

  const behaviors = candidates
    .map((candidate) => registry.get(candidate.predicate)?.temporalBehavior)
    .filter((value): value is NonNullable<typeof value> => value !== undefined);
  if (behaviors.length > 0 && behaviors.every((value) => value === "current")) return "current";
  if (behaviors.length > 0 && behaviors.every((value) => value === "event")) return "historical";
  return "any";
}

function degradedPlan(): MemoryQueryPlan {
  return {
    predicateCandidates: [],
    subjectCandidates: [],
    temporalIntent: "any",
    retrievalMode: "broad",
    confidence: 0,
    memoryNeed: { required: true, confidence: 0 },
    sourceDependency: "unknown",
    diagnostics: { plannerDegraded: true },
  };
}

export interface SemanticQueryPlannerOptions {
  readonly embedding: EmbeddingProvider;
  readonly modelId: string;
  readonly dimensions: number;
  readonly registry?: PredicateRegistry;
  readonly cache?: PredicateVectorCache;
  readonly queryCacheEntries?: number;
}

export class SemanticQueryPlanner {
  readonly #embedding: EmbeddingProvider;
  readonly #modelId: string;
  readonly #dimensions: number;
  readonly #registry: PredicateRegistry;
  readonly #cache: PredicateVectorCache | undefined;
  readonly #queryCacheEntries: number;
  readonly #queryCache = new Map<string, EmbeddingVector>();
  readonly #initialization: Promise<PredicateSemanticIndex>;

  constructor(options: SemanticQueryPlannerOptions) {
    this.#embedding = options.embedding;
    this.#modelId = options.modelId;
    this.#dimensions = options.dimensions;
    this.#registry = options.registry ?? DEFAULT_PREDICATE_REGISTRY;
    this.#cache = options.cache;
    this.#queryCacheEntries = Math.max(1, options.queryCacheEntries ?? 256);
    this.#initialization = this.#initialize();
  }

  async #initialize(): Promise<PredicateSemanticIndex> {
    const cached = await this.#cache?.load().catch(() => undefined);
    const definitions = this.#registry.list();
    if (
      cached !== undefined &&
      cached.schemaVersion === this.#registry.schemaVersion &&
      cached.providerId === this.#embedding.id &&
      cached.modelId === this.#modelId &&
      cached.dimensions === this.#dimensions &&
      cached.entries.length === definitions.length &&
      cached.entries.every(
        (entry) => this.#registry.has(entry.predicate) && entry.vector.length === this.#dimensions,
      )
    ) {
      return new InMemoryPredicateSemanticIndex(
        cached.entries.map((entry) => ({
          predicate: entry.predicate,
          vector: Float32Array.from(entry.vector),
        })),
      );
    }

    const texts = definitions.map(buildPredicateSemanticText);
    const entries: PredicateSemanticEntry[] = [];
    for (let offset = 0; offset < texts.length; offset += 32) {
      const response = await this.#embedding.embed(
        {
          inputs: texts.slice(offset, offset + 32),
          inputKind: "document",
          dimensions: this.#dimensions,
          truncate: "reject",
        },
        { priority: "background" },
      );
      for (const [index, vector] of response.vectors.entries()) {
        const predicate = definitions[offset + index]?.id;
        if (predicate === undefined || vector.values.length !== this.#dimensions) {
          throw new Error("Predicate embedding response does not match the registry");
        }
        entries.push({ predicate, vector: vector.values });
      }
    }
    if (entries.length !== definitions.length) {
      throw new Error("Predicate embedding response is incomplete");
    }
    await this.#cache
      ?.save({
        schemaVersion: this.#registry.schemaVersion,
        providerId: this.#embedding.id,
        modelId: this.#modelId,
        dimensions: this.#dimensions,
        entries: entries.map((entry) => ({
          predicate: entry.predicate,
          vector: [...entry.vector],
        })),
      })
      .catch(() => undefined);
    return new InMemoryPredicateSemanticIndex(entries);
  }

  async #embedQuery(
    query: string,
    options: InferenceOperationOptions,
  ): Promise<EmbeddingVector | undefined> {
    const remoteSafe = toRemoteSafe(query);
    if (remoteSafe.policy === "drop" || remoteSafe.policy === "local_only") return undefined;
    const safeText = remoteSafe.text ?? "[REDACTED]";
    const key = contentHash(
      `${this.#embedding.id}:${this.#modelId}:${this.#dimensions}:${safeText}`,
    );
    const cached = this.#queryCache.get(key);
    if (cached !== undefined) return cached;
    const response = await this.#embedding.embed(
      {
        inputs: [safeText],
        inputKind: "query",
        dimensions: this.#dimensions,
        truncate: "reject",
      },
      options,
    );
    const vector = response.vectors[0];
    if (vector === undefined || vector.values.length !== this.#dimensions) {
      throw new Error("Semantic query embedding response is empty or invalid");
    }
    this.#queryCache.set(key, vector);
    while (this.#queryCache.size > this.#queryCacheEntries) {
      const oldest = this.#queryCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#queryCache.delete(oldest);
    }
    return vector;
  }

  async prepare(
    query: string,
    options: InferenceOperationOptions = {},
  ): Promise<PreparedSemanticQuery> {
    try {
      const [index, queryEmbedding] = await Promise.all([
        this.#initialization,
        this.#embedQuery(query, { ...options, priority: "interactive" }),
      ]);
      if (queryEmbedding === undefined) return { plan: degradedPlan() };
      return {
        queryEmbedding,
        plan: this.planFromVector(query, queryEmbedding.values, index),
      };
    } catch {
      return { plan: degradedPlan() };
    }
  }

  planFromVector(
    query: string,
    queryVector: Float32Array,
    index: PredicateSemanticIndex,
  ): MemoryQueryPlan {
    const ranked = index.rank(queryVector);
    const mode = inferRetrievalMode(ranked);
    const top = ranked[0]?.score ?? -1;
    const second = ranked[1]?.score ?? -1;
    const entropy = normalizedEntropy(ranked.slice(0, 6).map((entry) => entry.score));
    const memoryConfidence = clamp01((top - 0.25) / 0.5);

    const candidateFloor =
      mode === "focused" ? Math.max(0.42, top - 0.2) : Math.max(0.38, top - 0.18);
    const predicateCandidates = ranked
      .filter((entry) => entry.score >= candidateFloor)
      .slice(0, mode === "focused" ? 3 : 8)
      .map((entry) => ({ predicate: entry.predicate, confidence: clamp01(entry.score) }));
    const subjects = new Map<MemorySubjectType, number>();
    for (const candidate of predicateCandidates) {
      for (const subject of this.#registry.get(candidate.predicate)?.subjectTypes ?? []) {
        subjects.set(subject, Math.max(subjects.get(subject) ?? 0, candidate.confidence));
      }
    }
    const subjectCandidates = [...subjects]
      .map(([subject, confidence]) => ({ subject, confidence }))
      .sort((left, right) => right.confidence - left.confidence);

    // ── Source Dependency Inference ──
    // Memory need is derived from predicate routing metadata, NOT from
    // enumerated natural-language anchor sentences. The existing predicate
    // candidate scores (from query embedding vs predicate semantic texts)
    // already tell us what KIND of topic the query is about. We check the
    // predicate registry metadata to determine if the answer depends on
    // prior user state.
    //
    // Signal: if any candidate predicate (even below the usual 0.42 floor)
    // has subjectTypes including "user" AND temporalBehavior is "evolving"
    // or "event", the answer depends on prior user-specific state.
    //
    // This uses ZERO additional embeddings — pure metadata inference from
    // the predicate routing that already happened.
    const USER_STATE_FLOOR = 0.30;
    const hasUserStatePredicate = ranked.some((entry) => {
      if (entry.score < USER_STATE_FLOOR) return false;
      const def = this.#registry.get(entry.predicate);
      if (def === undefined) return false;
      return (
        def.subjectTypes.includes("user") &&
        (def.temporalBehavior === "evolving" || def.temporalBehavior === "event")
      );
    });

    // Also check project/task/environment subjects (stored in memory)
    const hasStoredStatePredicate = ranked.some((entry) => {
      if (entry.score < 0.33) return false;
      const def = this.#registry.get(entry.predicate);
      if (def === undefined) return false;
      return def.subjectTypes.some(
        (s) => s === "project" || s === "repository" || s === "task" || s === "environment",
      );
    });

    let sourceDependency: SourceDependency;
    let sourceDependencySignal: string;
    if (hasUserStatePredicate) {
      sourceDependency = "prior_user_state";
      sourceDependencySignal = "user-subject predicate with evolving/event temporal behavior above floor";
    } else if (hasStoredStatePredicate) {
      sourceDependency = "prior_user_state";
      sourceDependencySignal = "project/task/environment-subject predicate above floor";
    } else {
      sourceDependency = "general_knowledge";
      sourceDependencySignal = "no user-state predicate above floor";
    }

    const required = top >= 0.42 || sourceDependency === "prior_user_state";
    const finalConfidence = required
      ? Math.max(memoryConfidence, 0.5)
      : memoryConfidence;

    return {
      predicateCandidates,
      subjectCandidates,
      temporalIntent: temporalIntent(query, predicateCandidates, this.#registry),
      retrievalMode: mode,
      confidence: finalConfidence,
      memoryNeed: { required, confidence: finalConfidence },
      sourceDependency,
      diagnostics: {
        predicateMargin: top - second,
        predicateEntropy: entropy,
        plannerDegraded: false,
        sourceDependencySignal,
      },
    };
  }
}
