/**
 * CommitSemantics — unified, phrase-free Commit Semantic Planning.
 *
 * One planner consumes the fact content embedding (reused from the commit
 * path — zero additional remote calls) and produces every semantic decision
 * the Memory Write Path needs:
 *
 *   predicate, subject, type, cardinality, action intent, polarity,
 *   normalized value, set member identity, confidence
 *
 * Techniques:
 *   - predicate: semantic prototype routing against the existing
 *     PredicateRegistry semantic texts (description + examples), fused with
 *     the ownership domain as a metadata prior, gated by margin.
 *   - type/cardinality/subject: deterministic metadata derived from the
 *     selected predicate (registry definitions), NOT from content phrases.
 *   - action intent (create/reinforce/correct/replace/retract): semantic
 *     prototype clusters. Destructive actions (retract) require a high
 *     margin — a mis-routed forget would delete data.
 *   - polarity: semantic prototype clusters, positive default.
 *
 * NO hasPhrase / includes / regex / keyword lists are used anywhere here.
 */

import { normalizeText, contentHash } from "@pi-mentis/pi-mentis-core";
import type {
  EmbeddingProvider,
  InferenceOperationOptions,
} from "@pi-mentis/pi-mentis-inference";

import {
  buildPredicateSemanticText,
  DEFAULT_PREDICATE_REGISTRY,
  predicateDefinition,
  type KnownPredicate,
  type MemorySubjectType,
  type PredicateRegistry,
} from "./predicate-registry.js";
import type { MemoryDomain, MemoryType, TemporalCardinality } from "./types.js";

// ─── Semantic Domains ─────────────────────────────────────────────

export type CommitActionIntent = "create" | "reinforce" | "correct" | "replace" | "retract";

export type FactPolarity = "positive" | "negative";

export interface CommitSemanticPlan {
  readonly predicate: KnownPredicate | undefined;
  readonly predicateConfidence: number;
  readonly subject: MemorySubjectType | undefined;
  readonly type: MemoryType;
  readonly cardinality: TemporalCardinality;
  readonly actionIntent: CommitActionIntent;
  readonly polarity: FactPolarity;
  readonly normalizedValue?: string;
  readonly setMemberKey?: string;
  readonly fallbackPredicate: boolean;
  readonly confidence: number;
  readonly reasons: readonly string[];
  readonly evidence: {
    readonly predicateScores?: Readonly<Record<string, number>>;
    readonly predicateMargin?: number;
    readonly actionScores?: Readonly<Record<CommitActionIntent, number>>;
    readonly actionMargin?: number;
    readonly polarityScores?: Readonly<Record<FactPolarity, number>>;
    readonly polarityMargin?: number;
    readonly degraded?: boolean;
  };
}

// ─── Action Intent Prototypes (semantic clusters) ─────────────────

export interface CommitSemanticPrototype {
  readonly kind: string;
  readonly anchors: readonly string[];
}

export const ACTION_PROTOTYPES: readonly CommitSemanticPrototype[] = [
  {
    kind: "create",
    anchors: [
      "Establishing a brand new fact or preference that has not been stated before.",
      "陈述一个全新的、之前没有提到过的事实或偏好。",
      "This is new information being recorded for the first time.",
      "用户第一次提出这个说法或约定。",
      "Introducing a fresh statement; nothing like it was recorded earlier.",
    ],
  },
  {
    kind: "reinforce",
    anchors: [
      "Confirming, agreeing with, or reaffirming something already established.",
      "确认、同意或再次肯定已经确立的内容。",
      "Yes, that is correct, keep it as it is.",
      "对，没错，就是这样，继续保持。",
    ],
  },
  {
    kind: "correct",
    anchors: [
      "Saying a previous statement was wrong and giving the right version.",
      "表示之前说的错了，并给出正确的版本。",
      "What I said earlier was a mistake; the real value is different.",
      "纠正之前说过的话，指出错误并给出对的答案。",
    ],
  },
  {
    kind: "replace",
    anchors: [
      "Switching from an old value to a new value going forward.",
      "从现在起用新的值替换旧的值。",
      "Stop using the old setting and use this new one instead from now on.",
      "The package manager was npm before; now it is pnpm from now on.",
      "从今天起，端口号改为 8080。",
      "新的版本号是 2.0，替代旧的 1.0。",
    ],
  },
  {
    kind: "retract",
    anchors: [
      "Deleting, forgetting, or invalidating a previously stored fact entirely.",
      "删除、忘记或彻底作废之前保存的事实。",
      "Forget that memory, remove it, it should not exist anymore.",
      "忘掉之前保存的那条记忆，把它删掉。",
      "Erase that previously stored record; it is no longer valid.",
      "Take back what was recorded and discard the old note.",
      "那条记录不要了，把它从记忆里清除。",
      "忘掉我刚才说的那句话，不用记了。",
      "撤销之前保存的那条信息。",
    ],
  },
];

export const POLARITY_PROTOTYPES: readonly CommitSemanticPrototype[] = [
  {
    kind: "positive",
    anchors: [
      "Something is allowed, enabled, true, or done.",
      "允许、启用、成立或已完成。",
      "This is a positive, affirmative statement.",
    ],
  },
  {
    kind: "negative",
    anchors: [
      "Something is forbidden, disabled, untrue, or not done.",
      "禁止、禁用、不成立或未完成。",
      "This statement expresses negation or prohibition.",
    ],
  },
];

// ─── Prototype Vector Cache ───────────────────────────────────────

export interface CommitSemanticCacheRecord {
  readonly schemaVersion: string;
  readonly providerId: string;
  readonly dimensions: number;
  readonly actions: readonly { readonly kind: string; readonly vectors: readonly (readonly number[])[] }[];
  readonly polarities: readonly { readonly kind: string; readonly vectors: readonly (readonly number[])[] }[];
  readonly predicates: readonly { readonly predicate: string; readonly vector: readonly number[] }[];
}

export interface CommitSemanticCache {
  load(): Promise<CommitSemanticCacheRecord | undefined>;
  save(record: CommitSemanticCacheRecord): Promise<void>;
}

export class FileCommitSemanticCache implements CommitSemanticCache {
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;
  }

  async load(): Promise<CommitSemanticCacheRecord | undefined> {
    try {
      const { readFile } = await import("node:fs/promises");
      return JSON.parse(await readFile(this.#file, "utf8")) as CommitSemanticCacheRecord;
    } catch (error: unknown) {
      const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
      if (code === "ENOENT" || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  async save(record: CommitSemanticCacheRecord): Promise<void> {
    const { mkdir, rename, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), "utf8");
    await rename(temporary, this.#file);
  }
}

// ─── Cosine ───────────────────────────────────────────────────────

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

function maxClusterCosine(vector: Float32Array, cluster: readonly Float32Array[] | undefined): number {
  if (cluster === undefined || cluster.length === 0) return 0;
  let best = -1;
  for (const anchor of cluster) {
    const score = cosine(vector, anchor);
    if (score > best) best = score;
  }
  return Math.max(0, best);
}

// ─── Decision Thresholds (validated against bge-m3) ───────────────

/** Minimum margin for any non-default action intent. */
const ACTION_MARGIN = 0.03;
/** Retract is destructive — requires a much stronger margin. */
const RETRACT_MARGIN = 0.08;
/** Minimum margin for a predicate to be accepted instead of fallback. */
const PREDICATE_MARGIN = 0.02;
/** Minimum absolute predicate score. */
const PREDICATE_FLOOR = 0.4;
/** Minimum margin for polarity to leave the positive default. */
const POLARITY_MARGIN = 0.03;

// ─── Value Type → Memory Type (deterministic metadata mapping) ────

function memoryTypeForValueType(valueType: string | undefined): MemoryType {
  switch (valueType) {
    case "preference":
      return "preference";
    case "requirement":
      return "requirement";
    case "procedure":
      return "procedural";
    case "decision":
      return "decision";
    case "event":
      return "episodic";
    default:
      return "fact";
  }
}

function cardinalityForDefinition(cardinality: string | undefined, type: MemoryType): TemporalCardinality {
  if (cardinality === "set" || cardinality === "ordered" || cardinality === "event") {
    return cardinality;
  }
  if (type === "episodic" || type === "task") return "event";
  return "single";
}

// ─── Planner ──────────────────────────────────────────────────────

export interface CommitSemanticPlannerOptions {
  readonly embedding: EmbeddingProvider;
  readonly dimensions: number;
  readonly registry?: PredicateRegistry;
  readonly cache?: CommitSemanticCache;
  /** In-memory override for tests (kind -> vectors). */
  readonly prototypeVectors?: ReadonlyMap<string, Float32Array[]>;
}

export class CommitSemanticPlanner {
  readonly embedding: EmbeddingProvider;
  readonly dimensions: number;
  readonly #registry: PredicateRegistry;
  readonly #cache: CommitSemanticCache | undefined;
  readonly #prototypeOverride: ReadonlyMap<string, Float32Array[]> | undefined;
  #loaded = false;
  #actionVectors = new Map<string, Float32Array[]>();
  #polarityVectors = new Map<string, Float32Array[]>();
  #predicateVectors: readonly { readonly predicate: string; readonly vector: Float32Array }[] = [];

  constructor(options: CommitSemanticPlannerOptions) {
    this.embedding = options.embedding;
    this.dimensions = options.dimensions;
    this.#registry = options.registry ?? DEFAULT_PREDICATE_REGISTRY;
    this.#cache = options.cache;
    this.#prototypeOverride = options.prototypeVectors;
  }

  async #ensurePrototypes(options?: InferenceOperationOptions): Promise<void> {
    if (this.#loaded) return;
    if (this.#prototypeOverride !== undefined) {
      for (const [kind, vectors] of this.#prototypeOverride) {
        if (kind.startsWith("polarity:")) {
          this.#polarityVectors.set(kind.slice("polarity:".length), vectors);
        } else if (kind.startsWith("predicate:")) {
          const predicate = kind.slice("predicate:".length);
          this.#predicateVectors = [
            ...this.#predicateVectors,
            ...vectors.map((vector) => ({ predicate, vector })),
          ];
        } else {
          this.#actionVectors.set(kind, vectors);
        }
      }
      this.#loaded = true;
      return;
    }

    if (this.#cache !== undefined) {
      const cached = await this.#cache.load();
      if (cached !== undefined && cached.dimensions === this.dimensions && cached.providerId === this.embedding.id) {
        for (const entry of cached.actions) {
          this.#actionVectors.set(entry.kind, entry.vectors.map((v) => Float32Array.from(v)));
        }
        for (const entry of cached.polarities) {
          this.#polarityVectors.set(entry.kind, entry.vectors.map((v) => Float32Array.from(v)));
        }
        this.#predicateVectors = cached.predicates.map((p) => ({
          predicate: p.predicate,
          vector: Float32Array.from(p.vector),
        }));
        this.#loaded = true;
        return;
      }
    }

    const definitions = this.#registry.list();
    const predicateTexts = definitions.map(buildPredicateSemanticText);
    const actionAnchors = ACTION_PROTOTYPES.flatMap((p) => p.anchors);
    const polarityAnchors = POLARITY_PROTOTYPES.flatMap((p) => p.anchors);
    const response = await this.embedding.embed(
      {
        inputs: [...predicateTexts, ...actionAnchors, ...polarityAnchors],
        inputKind: "document",
        dimensions: this.dimensions,
        truncate: "reject",
      },
      { priority: "background", ...(options === undefined ? {} : options) },
    );
    const vectors = response.vectors;

    const predicateVectors: { readonly predicate: string; readonly vector: Float32Array }[] = [];
    for (const [index, def] of definitions.entries()) {
      const vector = vectors[index]?.values;
      if (vector !== undefined) predicateVectors.push({ predicate: def.id, vector });
    }
    this.#predicateVectors = predicateVectors;

    const actionOffset = predicateTexts.length;
    const actionVectors = new Map<string, Float32Array[]>();
    let cursor = actionOffset;
    for (const prototype of ACTION_PROTOTYPES) {
      const cluster: Float32Array[] = [];
      for (let anchorIndex = 0; anchorIndex < prototype.anchors.length; anchorIndex++) {
        const vector = vectors[cursor]?.values;
        if (vector !== undefined) cluster.push(vector);
        cursor++;
      }
      if (cluster.length > 0) actionVectors.set(prototype.kind, cluster);
    }
    this.#actionVectors = actionVectors;

    const polarityVectors = new Map<string, Float32Array[]>();
    for (const prototype of POLARITY_PROTOTYPES) {
      const cluster: Float32Array[] = [];
      for (let anchorIndex = 0; anchorIndex < prototype.anchors.length; anchorIndex++) {
        const vector = vectors[cursor]?.values;
        if (vector !== undefined) cluster.push(vector);
        cursor++;
      }
      if (cluster.length > 0) polarityVectors.set(prototype.kind, cluster);
    }
    this.#polarityVectors = polarityVectors;
    this.#loaded = true;

    if (this.#cache !== undefined) {
      await this.#cache
        .save({
          schemaVersion: "1",
          providerId: this.embedding.id,
          dimensions: this.dimensions,
          actions: [...actionVectors.entries()].map(([kind, vectors]) => ({
            kind,
            vectors: vectors.map((v) => [...v]),
          })),
          polarities: [...polarityVectors.entries()].map(([kind, vectors]) => ({
            kind,
            vectors: vectors.map((v) => [...v]),
          })),
          predicates: predicateVectors.map((p) => ({ predicate: p.predicate, vector: [...p.vector] })),
        })
        .catch(() => undefined);
    }
  }

  #routeAction(embedding: Float32Array): {
    readonly intent: CommitActionIntent;
    readonly margin: number;
    readonly scores: Readonly<Record<CommitActionIntent, number>>;
  } {
    const intents: readonly CommitActionIntent[] = ["create", "reinforce", "correct", "replace", "retract"];
    const scores = {} as Record<CommitActionIntent, number>;
    for (const intent of intents) {
      scores[intent] = maxClusterCosine(embedding, this.#actionVectors.get(intent));
    }
    const ranked = intents
      .map((intent) => ({ intent, score: scores[intent] }))
      .sort((a, b) => b.score - a.score);
    const margin = (ranked[0]?.score ?? 0) - (ranked[1]?.score ?? 0);
    return { intent: ranked[0]?.intent ?? "create", margin, scores };
  }

  #routePolarity(embedding: Float32Array): {
    readonly polarity: FactPolarity;
    readonly margin: number;
    readonly scores: Readonly<Record<FactPolarity, number>>;
  } {
    const positive = maxClusterCosine(embedding, this.#polarityVectors.get("positive"));
    const negative = maxClusterCosine(embedding, this.#polarityVectors.get("negative"));
    const margin = Math.abs(positive - negative);
    return {
      polarity: negative > positive ? "negative" : "positive",
      margin,
      scores: { positive, negative },
    };
  }

  #routePredicate(
    embedding: Float32Array,
    domain: MemoryDomain,
  ): {
    readonly predicate: KnownPredicate | undefined;
    readonly margin: number;
    readonly scores: Readonly<Record<string, number>>;
  } {
    const ranked = this.#predicateVectors
      .map((entry) => ({ predicate: entry.predicate, score: cosine(embedding, entry.vector) }))
      .sort((a, b) => b.score - a.score);
    const top = ranked[0];
    if (top === undefined) return { predicate: undefined, margin: 0, scores: {} };
    const second = ranked[1];
    const margin = (top.score ?? 0) - (second?.score ?? 0);
    const scores = Object.fromEntries(ranked.slice(0, 8).map((r) => [r.predicate, r.score]));

    // Domain metadata prior: prefer predicates whose memoryDomains contain
    // the ownership domain. This is deterministic metadata fusion, NOT a
    // content-phrase rule — e.g. "项目用 pnpm" (project domain) should pick
    // project_package_manager over general_package_manager_preference.
    const domainMatches = ranked.filter((r) =>
      predicateDefinition(r.predicate)?.memoryDomains.includes(domain),
    );
    const bestDomainMatch = domainMatches[0];

    if (top.score >= PREDICATE_FLOOR && margin >= PREDICATE_MARGIN) {
      return {
        predicate: top.predicate as KnownPredicate,
        margin,
        scores,
      };
    }
    if (
      bestDomainMatch !== undefined &&
      bestDomainMatch.score >= PREDICATE_FLOOR - 0.05 &&
      (top.score - bestDomainMatch.score) <= 0.05
    ) {
      return {
        predicate: bestDomainMatch.predicate as KnownPredicate,
        margin,
        scores,
      };
    }
    return { predicate: undefined, margin, scores };
  }

  /**
   * Plan all write-path semantics from the content embedding.
   *
   * @param content    raw user content
   * @param embedding  content embedding (reused from the commit path)
   * @param domain     ownership domain from the scope planner (metadata prior)
   */
  async plan(
    content: string,
    embedding: Float32Array,
    domain: MemoryDomain,
    options?: InferenceOperationOptions,
  ): Promise<CommitSemanticPlan> {
    try {
      await this.#ensurePrototypes(options);

      const action = this.#routeAction(embedding);
      const polarity = this.#routePolarity(embedding);
      const predicate = this.#routePredicate(embedding, domain);

      // Action intent decision (conservative gates):
      //   - retract is destructive → requires a strong margin
      //   - other non-create intents require a moderate margin
      //   - everything ambiguous → create (safe default)
      let actionIntent: CommitActionIntent = "create";
      if (action.intent === "retract" && action.margin >= RETRACT_MARGIN) {
        actionIntent = "retract";
      } else if (action.intent !== "create" && action.intent !== "retract" && action.margin >= ACTION_MARGIN) {
        actionIntent = action.intent;
      }

      // Predicate metadata → type / cardinality / subject (deterministic).
      const definition =
        predicate.predicate === undefined ? undefined : predicateDefinition(predicate.predicate);
      const type = memoryTypeForValueType(definition?.valueType);
      const cardinality = cardinalityForDefinition(definition?.cardinality, type);
      const subject = definition?.subjectTypes[0];
      const polarityValue: FactPolarity =
        polarity.margin >= POLARITY_MARGIN ? polarity.polarity : "positive";

      // Normalized value / set member identity (post-predicate, deterministic).
      const normalizedValue =
        predicate.predicate === "programming_language_preference" ||
        predicate.predicate === "language"
          ? extractLanguages(content)
          : undefined;
      const setMemberKey =
        cardinality === "set"
          ? normalizedValue ?? normalizeText(content).toLowerCase().slice(0, 60)
          : undefined;

      // Corrections are always facts (deterministic rule, not a phrase rule).
      const finalType: MemoryType =
        actionIntent === "correct" || actionIntent === "replace" || actionIntent === "retract"
          ? "fact"
          : type;

      const confidence = Math.min(
        0.95,
        Math.max(0.3, predicate.predicate !== undefined ? 0.5 + predicate.margin * 2 : 0.4),
      );

      return {
        predicate: predicate.predicate,
        predicateConfidence: predicate.predicate === undefined ? 0 : confidence,
        subject,
        type: finalType,
        cardinality,
        actionIntent,
        polarity: polarityValue,
        ...(normalizedValue === undefined ? {} : { normalizedValue }),
        ...(setMemberKey === undefined ? {} : { setMemberKey }),
        fallbackPredicate: predicate.predicate === undefined,
        confidence,
        reasons: [
          `action intent: ${actionIntent} (routed ${action.intent}, margin ${action.margin.toFixed(3)})`,
          predicate.predicate === undefined
            ? "predicate: fallback (no confident semantic match)"
            : `predicate: ${predicate.predicate} (margin ${predicate.margin.toFixed(3)})`,
          `type: ${finalType}, cardinality: ${cardinality}`,
        ],
        evidence: {
          predicateScores: predicate.scores,
          predicateMargin: predicate.margin,
          actionScores: action.scores,
          actionMargin: action.margin,
          polarityScores: polarity.scores,
          polarityMargin: polarity.margin,
        },
      };
    } catch {
      return {
        predicate: undefined,
        predicateConfidence: 0,
        subject: undefined,
        type: "fact",
        cardinality: "single",
        actionIntent: "create",
        polarity: "positive",
        fallbackPredicate: true,
        confidence: 0.3,
        reasons: ["semantic commit planner unavailable; safe defaults"],
        evidence: { degraded: true },
      };
    }
  }
}

// ─── Post-predicate value extraction (deterministic, predicate-gated) ──

const LANGUAGE_PATTERN =
  /\b(?:go\b|golang|rust|types?cript|python|java(?!script)|kotlin|swift|zig|elixir|c\b|c#|c\+\+|ruby|php|scala|haskell|clojure|dart|lua|perl|r\b)\b/gi;

function extractLanguages(content: string): string | undefined {
  const normalized = normalizeText(content).toLowerCase();
  const langs = [...new Set(normalized.match(LANGUAGE_PATTERN) ?? [])].map((lang) =>
    lang === "golang" ? "go" : lang,
  );
  return langs.length > 0 ? langs.join(", ") : undefined;
}

export function commitSemanticCacheKey(content: string): string {
  return contentHash(normalizeText(content));
}
