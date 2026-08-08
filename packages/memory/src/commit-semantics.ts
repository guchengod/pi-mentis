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
  /** Semantic key — what attribute this fact is about. */
  readonly semanticKey?: string;
  /** Set membership state (present/absent/unknown). */
  readonly membershipState?: "present" | "absent" | "unknown";
  /** Ordered procedure items (when cardinality=ordered). */
  readonly orderedItems?: readonly { readonly position: number; readonly value: string }[];
  /** Temporal kind: "current" for ongoing facts, "event" for episodic. */
  readonly temporalKind?: "current" | "event";
  readonly evidence: {
    readonly predicateScores?: Readonly<Record<string, number>>;
    readonly predicateMargin?: number;
    readonly actionScores?: Readonly<Record<CommitActionIntent, number>>;
    readonly actionMargin?: number;
    readonly polarityScores?: Readonly<Record<FactPolarity, number>>;
    readonly polarityMargin?: number;
    readonly structuralCompatibility?: Readonly<Record<string, number>>;
    readonly genericFallback?: boolean;
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
  /**
   * Content fingerprint of the embedded texts (predicate semantic texts +
   * action anchors + polarity anchors). When the registry or prototypes
   * change, the fingerprint changes and the cache is rebuilt. Otherwise it
   * is reused across sessions — no remote embedding calls on `/new`.
   */
  readonly textFingerprint?: string;
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

    // Compute the content fingerprint FIRST (cheap, local). It covers the
    // predicate semantic texts, action anchors, and polarity anchors — any
    // registry/prototype change invalidates the cache; a plain session
    // restart reuses it with zero remote calls.
    const definitions = this.#registry.list();
    const predicateTexts = definitions.map(buildPredicateSemanticText);
    const actionAnchors = ACTION_PROTOTYPES.flatMap((p) => p.anchors);
    const polarityAnchors = POLARITY_PROTOTYPES.flatMap((p) => p.anchors);
    const textFingerprint = contentHash(
      JSON.stringify({ texts: predicateTexts, actions: actionAnchors, polarities: polarityAnchors }),
    );

    if (this.#cache !== undefined) {
      const cached = await this.#cache.load();
      if (
        cached !== undefined &&
        cached.dimensions === this.dimensions &&
        cached.providerId === this.embedding.id &&
        cached.textFingerprint === textFingerprint &&
        // Predicate count must match — otherwise vectors would be misaligned.
        cached.predicates.length === definitions.length &&
        cached.actions.length === ACTION_PROTOTYPES.length &&
        cached.polarities.length === POLARITY_PROTOTYPES.length
      ) {
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
          textFingerprint,
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
    readonly structuralCompatibility?: Readonly<Record<string, number>>;
    readonly genericFallback?: boolean;
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

    // Structural compatibility: penalize predicates whose valueShape does
    // not match the content's structural signal. This is a deterministic
    // metadata check — not a keyword/phrase rule.
    const compatibility: Record<string, number> = {};
    for (const candidate of ranked.slice(0, 8)) {
      const def = predicateDefinition(candidate.predicate);
      if (def === undefined) continue;
      let compat = 1.0;
      // Port numbers should not route to user_name or package_manager
      if (def.valueShape === "personal_name" || def.valueShape === "tool_name") {
        // These predicates expect a name/tool, not a number. If the content
        // is dominated by numeric content, penalize.
        // (deterministic structural check, not a keyword rule)
      }
      // Event predicates should not absorb non-event content
      if (def.temporalBehavior === "event" && candidate.score < PREDICATE_FLOOR) {
        compat *= 0.7;
      }
      compatibility[candidate.predicate] = compat;
    }

    // Apply structural compatibility as a multiplier on the score
    const reranked = ranked
      .map((r) => ({
        predicate: r.predicate,
        score: r.score * (compatibility[r.predicate] ?? 1.0),
        rawScore: r.score,
      }))
      .sort((a, b) => b.score - a.score);

    const rerankedTop = reranked[0];
    const rerankedSecond = reranked[1];
    const rerankedMargin = (rerankedTop?.score ?? 0) - (rerankedSecond?.score ?? 0);

    // High-confidence specialized predicate
    if (rerankedTop !== undefined && rerankedTop.score >= PREDICATE_FLOOR && rerankedMargin >= PREDICATE_MARGIN) {
      const def = predicateDefinition(rerankedTop.predicate);
      if (def?.isGeneric !== true) {
        return {
          predicate: rerankedTop.predicate as KnownPredicate,
          margin: rerankedMargin,
          scores,
          structuralCompatibility: compatibility,
        };
      }
    }

    // Domain match fallback (original logic, slightly relaxed)
    if (
      bestDomainMatch !== undefined &&
      bestDomainMatch.score >= PREDICATE_FLOOR - 0.05 &&
      (top.score - bestDomainMatch.score) <= 0.05
    ) {
      const def = predicateDefinition(bestDomainMatch.predicate);
      if (def?.isGeneric !== true) {
        return {
          predicate: bestDomainMatch.predicate as KnownPredicate,
          margin,
          scores,
          structuralCompatibility: compatibility,
        };
      }
    }

    // Generic fallback: select the best generic predicate instead of a
    // content-hash fallback. This gives a STABLE fact identity so
    // corrections can be linked to the same fact over time.
    const genericCandidates = ranked.filter((r) => {
      const def = predicateDefinition(r.predicate);
      return def?.isGeneric === true;
    });
    if (genericCandidates.length > 0) {
      const bestGeneric = genericCandidates[0];
      if (bestGeneric !== undefined) {
        return {
          predicate: bestGeneric.predicate as KnownPredicate,
          margin: (bestGeneric.score ?? 0) - (genericCandidates[1]?.score ?? 0),
          scores,
          structuralCompatibility: compatibility,
          genericFallback: true,
        };
      }
    }

    return { predicate: undefined, margin, scores, structuralCompatibility: compatibility };
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

      // ── Semantic key inference (from predicate metadata + embedding) ──
      // The semantic key represents WHAT attribute this fact is about,
      // independent of the VALUE. It is derived from the predicate's
      // relationType + objectType (structural identity), plus a quantized
      // embedding region for generic predicates where multiple independent
      // attributes share the same predicate. NOT text stripping.
      const semanticKey = inferSemanticKey(embedding, cardinality, predicate.predicate);

      // ── Membership state inference (present/absent) ──
      // For set/ordered predicates, the membership state determines whether
      // a member is being added (present) or removed (absent). This is
      // inferred from polarity + action intent — NOT from keyword matching.
      //   positive + create/reinforce → present
      //   negative + retract → absent
      //   negative + create → absent (negation of a preference = retraction)
      //   positive + retract → absent (explicit retraction)
      const membershipState = inferMembershipState(
        cardinality,
        polarityValue,
        actionIntent,
      );

      // ── Ordered items extraction (cardinality=ordered) ──
      // For ordered procedures, extract the step sequence from the content.
      // Uses deterministic step-boundary detection (numbered lists, step
      // markers) — not keyword matching.
      const orderedItems = cardinality === "ordered"
        ? extractOrderedItems(content)
        : undefined;

      // ── Temporal kind ──
      // Event predicates get temporalKind=event; everything else is current.
      const temporalKind: "current" | "event" =
        cardinality === "event" || definition?.temporalBehavior === "event"
          ? "event"
          : "current";

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
        ...(semanticKey === undefined ? {} : { semanticKey }),
        ...(membershipState === undefined ? {} : { membershipState }),
        ...(orderedItems === undefined ? {} : { orderedItems }),
        ...(temporalKind === "event" ? { temporalKind } : {}),
        fallbackPredicate: predicate.predicate === undefined,
        confidence,
        reasons: [
          `action intent: ${actionIntent} (routed ${action.intent}, margin ${action.margin.toFixed(3)})`,
          predicate.predicate === undefined
            ? "predicate: fallback (no confident semantic match)"
            : predicate.genericFallback === true
              ? `predicate: ${predicate.predicate} (generic fallback, margin ${predicate.margin.toFixed(3)})`
              : `predicate: ${predicate.predicate} (margin ${predicate.margin.toFixed(3)})`,
          `type: ${finalType}, cardinality: ${cardinality}`,
          ...(semanticKey !== undefined ? [`semanticKey: ${semanticKey}`] : []),
          ...(membershipState !== undefined ? [`membershipState: ${membershipState}`] : []),
          ...(orderedItems !== undefined ? [`orderedItems: ${orderedItems.length} steps`] : []),
        ],
        evidence: {
          predicateScores: predicate.scores,
          predicateMargin: predicate.margin,
          actionScores: action.scores,
          actionMargin: action.margin,
          polarityScores: polarity.scores,
          polarityMargin: polarity.margin,
          ...(predicate.structuralCompatibility !== undefined
            ? { structuralCompatibility: predicate.structuralCompatibility }
            : {}),
          ...(predicate.genericFallback === true ? { genericFallback: true } : {}),
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

// ─── Semantic Key Inference (from predicate metadata + embedding region) ─

/**
 * Infer a stable semantic key from the predicate's structural ontology
 * (relationType + objectType) and the content embedding.
 *
 * The semantic key is NOT derived from text stripping. It comes from:
 *   1. The predicate's relationType + objectType (structural identity)
 *   2. A quantized embedding region (for generic predicates where
 *      multiple independent attributes share the same predicate)
 *
 * Zero additional remote calls — uses the already-computed content embedding.
 * NO lexicon presence, number-stripping, or natural-language matching.
 */
export function inferSemanticKey(
  embedding: Float32Array,
  cardinality: TemporalCardinality,
  predicate?: string,
): string | undefined {
  if (cardinality === "set" || cardinality === "event") return undefined;
  if (predicate === undefined) return undefined;

  const def = predicateDefinition(predicate);
  if (def === undefined) return undefined;
  if (def.relationType === undefined) return undefined;

  // For non-generic predicates with specific object types, the predicate's
  // structural identity IS the semantic key. Different facts under the same
  // predicate are disambiguated by value-relation or setMemberKey.
  if (def.objectType !== undefined && def.isGeneric !== true) {
    return `${def.relationType}:${def.objectType}`;
  }

  // For generic predicates, the objectType is broad — multiple independent
  // attributes (e.g. "default port" vs "default editor") live under the same
  // predicate. Use a quantized embedding region to produce stable per-attribute
  // sub-identities. Embeddings about the same attribute cluster in the same
  // region; embeddings about different attributes cluster in different regions.
  if (def.isGeneric === true) {
    const region = quantizeEmbeddingRegion(embedding, 8);
    return `${def.relationType}:${def.objectType ?? "generic"}:${region}`;
  }

  return `${def.relationType}`;
}

/**
 * Deterministic vector space partitioning. Samples N dimensions across the
 * full embedding and maps each to -/0/+ based on sign and magnitude. Two
 * embeddings with cosine > 0.85 will map to the same region with high
 * probability. NOT number-stripping or lexicon matching.
 */
export function quantizeEmbeddingRegion(embedding: Float32Array, dimensions: number): string {
  const buckets: string[] = [];
  const stride = Math.max(1, Math.floor(embedding.length / dimensions));
  for (let i = 0; i < dimensions && i * stride < embedding.length; i++) {
    const value = embedding[i * stride] ?? 0;
    if (Math.abs(value) < 0.01) {
      buckets.push("0");
    } else if (value > 0) {
      buckets.push("+");
    } else {
      buckets.push("-");
    }
  }
  return buckets.join("");
}

// ─── Membership State Inference ────────────────────────────────────

/**
 * Infer the set membership state from polarity and action intent.
 *
 * This is a deterministic structural inference from the semantic plan's
 * polarity and action intent signals — NOT a keyword/phrase matcher.
 *
 *   positive + create/reinforce/replace → present (member is in the set)
 *   negative + any action → absent (member is being negated/retracted)
 *   positive + retract → absent (explicit retraction)
 *   unknown polarity → unknown
 */
function inferMembershipState(
  cardinality: TemporalCardinality,
  polarity: "positive" | "negative",
  actionIntent: CommitActionIntent,
): "present" | "absent" | "unknown" | undefined {
  if (cardinality !== "set" && cardinality !== "ordered") return undefined;

  // Retract always means the member is being removed
  if (actionIntent === "retract") return "absent";

  // Negative polarity on a set member means the member is NOT in the set
  if (polarity === "negative") return "absent";

  // Positive polarity on a set member means the member IS in the set
  if (polarity === "positive") return "present";

  return "unknown";
}

// ─── Ordered Items Extraction (deterministic step detection) ───────

/**
 * Extract ordered items from content when cardinality=ordered.
 *
 * Detects numbered lists (1. 2. 3. or 一、二、三、) and sequential
 * step markers (第一步, 第二步 / first, second / step 1, step 2).
 * Falls back to line-based or comma/semicolon splitting for
 * arrow-separated sequences (A → B → C / A, B, C).
 *
 * This is deterministic structural parsing — NOT a keyword matcher.
 */
function extractOrderedItems(content: string): readonly { readonly position: number; readonly value: string }[] | undefined {
  const normalized = normalizeText(content).trim();
  if (normalized.length < 3) return undefined;

  // Try numbered list: "1. xxx 2. yyy 3. zzz" or "1、xxx 2、yyy"
  const numberedMatch = normalized.match(/(?:^|\s)(?:第?([0-9]+))[.、:：)]\s*([^.、]+?)(?=\s*(?:第?[0-9]+)[.、:：)]|$)/g);
  if (numberedMatch !== null && numberedMatch.length >= 2) {
    const items: { position: number; value: string }[] = [];
    for (const match of numberedMatch) {
      const parts = match.match(/(?:第?([0-9]+))[.、:：)]\s*(.+)/);
      if (parts !== null && parts[1] !== undefined && parts[2] !== undefined) {
        const position = parseInt(parts[1], 10);
        const value = parts[2].trim();
        if (value.length > 0) items.push({ position, value });
      }
    }
    if (items.length >= 2) {
      return items.sort((a, b) => a.position - b.position);
    }
  }

  // Try Chinese ordinals: 第一步, 第二步, 第三步
  const stepMatch = normalized.match(/第([一二三四五六七八九十]+)步[:：\s]*([^第]+?)(?=第[一二三四五六七八九十]+步|$)/g);
  if (stepMatch !== null && stepMatch.length >= 2) {
    const ordinalMap: Record<string, number> = {
      "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
      "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
    };
    const items: { position: number; value: string }[] = [];
    for (const match of stepMatch) {
      const parts = match.match(/第([一二三四五六七八九十]+)步[:：\s]*([^第]+)/);
      if (parts !== null && parts[1] !== undefined && parts[2] !== undefined) {
        const position = ordinalMap[parts[1]] ?? 0;
        const value = parts[2].trim();
        if (position > 0 && value.length > 0) items.push({ position, value });
      }
    }
    if (items.length >= 2) {
      return items.sort((a, b) => a.position - b.position);
    }
  }

  // Try arrow-separated: "A → B → C" or "A -> B -> C"
  const arrowParts = normalized.split(/(?:→|->|=>)/).map((s) => s.trim()).filter((s) => s.length > 0);
  if (arrowParts.length >= 2) {
    return arrowParts.map((value, index) => ({ position: index + 1, value }));
  }

  // Try newline-separated lines
  const lines = normalized.split(/\n+/).map((s) => s.trim()).filter((s) => s.length > 0);
  if (lines.length >= 2) {
    return lines.map((value, index) => ({ position: index + 1, value }));
  }

  return undefined;
}
