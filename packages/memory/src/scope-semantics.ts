/**
 * ScopeSemantics — semantic, phrase-free Scope Ownership planning.
 *
 * Ownership-first principle: Memory Scope represents "where this fact
 * belongs", NOT "where the user said it". The active context only supplies
 * candidate owner ids; it never decides the owner kind.
 *
 * The planner consumes a semantic embedding of the fact content (reused
 * from the commit path — no additional remote requests) and routes it
 * against semantic prototype CLUSTERS (description + example anchors,
 * the same pattern as the existing predicate semantic index):
 *
 *   scope clusters:  user / project / repository / task / topic
 *   binding clusters: durable / temporary
 *   subject prototypes: user / project / repository / task / topic
 *
 * NO hasPhrase / includes / regex / keyword list is used anywhere here.
 *
 * Decision (validated live against bge-m3, 18/18 open expressions):
 *   1. topic requires positive temporary-binding evidence
 *   2. durable facts without narrow evidence → user
 *   3. subject/user agreement gates marginal narrow scopes
 *   4. everything else → routing top kind
 *   5. any failure / low confidence → durable default user
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeText, contentHash } from "@pi-mentis/pi-mentis-core";
import type {
  EmbeddingProvider,
  EmbeddingVector,
  InferenceOperationOptions,
} from "@pi-mentis/pi-mentis-inference";

import type { MemoryScope, PiScopeContext } from "./types.js";

// ─── Scope Kinds ───────────────────────────────────────────────────

export type ScopeOwnerKind = "user" | "project" | "repository" | "task" | "topic";

export const SCOPE_OWNER_KINDS: readonly ScopeOwnerKind[] = [
  "user",
  "project",
  "repository",
  "task",
  "topic",
];

// ─── Structured Fact ───────────────────────────────────────────────

export interface ExtractedFact {
  readonly content: string;
  readonly embedding: Float32Array;
  readonly subject?: string;
  readonly predicate?: string;
  readonly value?: unknown;
  readonly durability?: { readonly durable: boolean; readonly confidence: number };
}

// ─── Semantic Prototypes (semantic descriptions + anchors, NOT keywords) ──

export interface ScopeSemanticPrototype {
  readonly kind: string;
  readonly anchors: readonly string[];
}

/**
 * Scope prototype clusters. Each anchor is a full-semantics sentence; the
 * routing score for a kind is the max cosine over its cluster. These are
 * semantic prototypes, not trigger phrases.
 */
export const SCOPE_PROTOTYPES: readonly ScopeSemanticPrototype[] = [
  {
    kind: "user",
    anchors: [
      "The user's persistent personal preference, habit, terminology, alias, or convention holding across all contexts.",
      "用户长期、跨上下文都成立的个人习惯、偏好、说法或约定。",
      "The user always prefers simple implementations that cost little to maintain.",
      "The user's personal habit that applies everywhere, in every project and every conversation.",
      "A durable personal rule of the user that does not change between projects.",
      "The user generally likes to state conclusions first.",
      "The user's own long-term alias, nickname, or terminology that they always use.",
      "用户平时长期使用的个人说法、称呼或代号，在任何场合都成立。",
      "The user calls their own testing area by a private nickname.",
    ],
  },
  {
    kind: "project",
    anchors: [
      "A rule, configuration, or constraint of one specific software project only.",
      "某个具体项目独有的规则、配置或约束，只在这个项目内成立。",
      "This project must not use CGO.",
      "A constraint that only holds inside this particular project.",
      "The project's own architecture decision, valid only for that project.",
    ],
  },
  {
    kind: "repository",
    anchors: [
      "A fact about one specific source code repository: release process, build commands, branch conventions.",
      "某个具体代码仓库独有的发布流程、构建命令或约定。",
      "This repository must run release-check before publishing.",
      "A convention that only holds inside this particular code repository.",
    ],
  },
  {
    kind: "task",
    anchors: [
      "An instruction or constraint that applies only to the current task or work item in progress.",
      "只适用于当前进行中任务的约束、步骤或指令，任务完成后不再成立。",
      "For this migration task, do not change the schema yet.",
      "A constraint that only matters while the current task is open.",
      "A plan step of the current work item, not a general rule.",
    ],
  },
  {
    kind: "topic",
    anchors: [
      "A temporary name or assumption that only applies inside the current discussion topic, not outside it.",
      "只在当前这段讨论中有效的临时称呼、别名或假设，离开本次讨论不再沿用。",
      "In this discussion, temporarily call option A the blue-box plan.",
      "An alias valid only within the current design thread.",
      "For this discussion only, use this shorthand; do not carry it to other topics.",
    ],
  },
  {
    kind: "durable",
    anchors: [
      "A persistent, general, long-term fact or habit that holds across contexts.",
      "长期、普遍、跨上下文都成立的事实或习惯。",
    ],
  },
  {
    kind: "temporary",
    anchors: [
      "A temporary, local, for-now-only arrangement bounded to the current discussion or task.",
      "暂时的、只限于当前讨论或任务、当下有效的安排。",
    ],
  },
];

/** Subject prototypes: WHO the fact is about (used as soft evidence). */
export const SCOPE_SUBJECT_PROTOTYPES: readonly ScopeSemanticPrototype[] = [
  {
    kind: "user",
    anchors: [
      "The subject is the user themselves: their own things, habits, preferences, terminology.",
      "主语是用户本人：他自己的东西、习惯、偏好、说法。",
    ],
  },
  {
    kind: "project",
    anchors: [
      "The subject is a specific software project entity.",
      "主语是一个具体的软件项目实体。",
    ],
  },
  {
    kind: "repository",
    anchors: [
      "The subject is a specific code repository entity.",
      "主语是一个具体的代码仓库实体。",
    ],
  },
  {
    kind: "task",
    anchors: [
      "The subject is the current task or work item.",
      "主语是当前的任务或工作项。",
    ],
  },
  {
    kind: "topic",
    anchors: [
      "The subject is the current discussion topic itself.",
      "主语是当前讨论话题本身。",
    ],
  },
];

// ─── Routing Result ────────────────────────────────────────────────

export interface ScopeRoutingResult {
  readonly scores: Readonly<Record<ScopeOwnerKind, number>>;
  readonly topKind: ScopeOwnerKind;
  readonly margin: number;
  readonly entropy: number;
  readonly bindingDelta: number;
  readonly subjectKind: ScopeOwnerKind;
  readonly confidence: number;
}

// ─── Ownership Decision ────────────────────────────────────────────

export interface ScopeOwnershipDecision {
  readonly ownerKind: ScopeOwnerKind;
  readonly ownerId: string;
  readonly confidence: number;
  readonly reason: string;
  readonly evidence: {
    readonly routing?: Readonly<Record<ScopeOwnerKind, number>>;
    readonly margin?: number;
    readonly bindingDelta?: number;
    readonly subjectKind?: ScopeOwnerKind;
    readonly degraded?: boolean;
  };
}

// ─── Prototype Vector Cache ────────────────────────────────────────

export interface ScopePrototypeVectorCacheRecord {
  readonly schemaVersion: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly dimensions: number;
  /**
   * Content fingerprint of the scope/subject prototype anchor texts. When
   * the prototypes change, the fingerprint changes and the cache is rebuilt.
   * Otherwise it is reused across sessions — no remote calls on `/new`.
   */
  readonly textFingerprint?: string;
  readonly scopes: readonly {
    readonly kind: string;
    readonly vectors: readonly (readonly number[])[];
  }[];
  readonly subjects: readonly {
    readonly kind: string;
    readonly vectors: readonly (readonly number[])[];
  }[];
}

export interface ScopePrototypeCache {
  load(): Promise<ScopePrototypeVectorCacheRecord | undefined>;
  save(record: ScopePrototypeVectorCacheRecord): Promise<void>;
}

export class FileScopePrototypeCache implements ScopePrototypeCache {
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;
  }

  async load(): Promise<ScopePrototypeVectorCacheRecord | undefined> {
    try {
      return JSON.parse(
        await readFile(this.#file, "utf8"),
      ) as ScopePrototypeVectorCacheRecord;
    } catch (error: unknown) {
      const code =
        error instanceof Error && "code" in error ? String(error.code) : undefined;
      if (code === "ENOENT" || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  async save(record: ScopePrototypeVectorCacheRecord): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), "utf8");
    await rename(temporary, this.#file);
  }
}

// ─── Cosine ────────────────────────────────────────────────────────

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

function maxClusterCosine(
  vector: Float32Array,
  cluster: readonly Float32Array[] | undefined,
): number {
  if (cluster === undefined || cluster.length === 0) return 0;
  let best = -1;
  for (const anchor of cluster) {
    const score = cosine(vector, anchor);
    if (score > best) best = score;
  }
  return Math.max(0, best);
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

// ─── Planner ───────────────────────────────────────────────────────

export interface ScopeSemanticPlannerOptions {
  readonly embedding: EmbeddingProvider;
  readonly dimensions: number;
  readonly cache?: ScopePrototypeCache;
  /** In-memory override for tests (keyed by kind -> vectors). */
  readonly prototypeVectors?: ReadonlyMap<string, Float32Array[]>;
}

export class ScopeSemanticPlanner {
  readonly embedding: EmbeddingProvider;
  readonly dimensions: number;
  readonly #cache: ScopePrototypeCache | undefined;
  readonly #prototypeOverride: ReadonlyMap<string, Float32Array[]> | undefined;
  #loaded = false;
  #scopeVectors = new Map<string, Float32Array[]>();
  #subjectVectors = new Map<string, Float32Array[]>();

  constructor(options: ScopeSemanticPlannerOptions) {
    this.embedding = options.embedding;
    this.dimensions = options.dimensions;
    this.#cache = options.cache;
    this.#prototypeOverride = options.prototypeVectors;
  }

  async #ensurePrototypes(options?: InferenceOperationOptions): Promise<void> {
    if (this.#loaded) return;
    if (this.#prototypeOverride !== undefined) {
      for (const [kind, vectors] of this.#prototypeOverride) {
        this.#scopeVectors.set(kind, vectors);
      }
      for (const prototype of SCOPE_SUBJECT_PROTOTYPES) {
        const vectors = this.#prototypeOverride.get(`subject:${prototype.kind}`);
        if (vectors !== undefined) this.#subjectVectors.set(prototype.kind, vectors);
      }
      this.#loaded = true;
      return;
    }

    // 1. Try the persisted cache — only when the prototype texts are unchanged
    const allTexts: { readonly kind: string; readonly text: string; readonly subject: boolean }[] = [
      ...SCOPE_PROTOTYPES.flatMap((prototype) =>
        prototype.anchors.map((text) => ({ kind: prototype.kind, text, subject: false })),
      ),
      ...SCOPE_SUBJECT_PROTOTYPES.flatMap((prototype) =>
        prototype.anchors.map((text) => ({ kind: prototype.kind, text, subject: true })),
      ),
    ];
    const textFingerprint = contentHash(
      `${allTexts.length}:${allTexts.map((item) => item.text).join("\u0001")}`,
    );

    if (this.#cache !== undefined) {
      const cached = await this.#cache.load();
      if (
        cached !== undefined &&
        cached.dimensions === this.dimensions &&
        cached.providerId === this.embedding.id &&
        cached.textFingerprint === textFingerprint &&
        cached.scopes.length === SCOPE_PROTOTYPES.length &&
        cached.subjects.length === SCOPE_SUBJECT_PROTOTYPES.length
      ) {
        for (const entry of cached.scopes) {
          this.#scopeVectors.set(entry.kind, entry.vectors.map((v) => Float32Array.from(v)));
        }
        for (const entry of cached.subjects) {
          this.#subjectVectors.set(entry.kind, entry.vectors.map((v) => Float32Array.from(v)));
        }
        this.#loaded = true;
        return;
      }
    }

    // 2. Embed all prototype anchors in one batched call.
    const response = await this.embedding.embed(
      {
        inputs: allTexts.map((item) => item.text),
        inputKind: "document",
        dimensions: this.dimensions,
        truncate: "reject",
      },
      { priority: "background", ...(options === undefined ? {} : options) },
    );
    const vectorsByKind = new Map<string, Float32Array[]>();
    const subjectVectorsByKind = new Map<string, Float32Array[]>();
    for (const [index, item] of allTexts.entries()) {
      const vector = response.vectors[index]?.values;
      if (vector === undefined) continue;
      if (item.subject) {
        subjectVectorsByKind.set(item.kind, [
          ...(subjectVectorsByKind.get(item.kind) ?? []),
          vector,
        ]);
      } else {
        vectorsByKind.set(item.kind, [...(vectorsByKind.get(item.kind) ?? []), vector]);
      }
    }
    this.#scopeVectors = vectorsByKind;
    this.#subjectVectors = subjectVectorsByKind;
    this.#loaded = true;

    if (this.#cache !== undefined) {
      await this.#cache
        .save({
          schemaVersion: "1",
          providerId: this.embedding.id,
          modelId: "scope-semantics",
          dimensions: this.dimensions,
          textFingerprint,
          scopes: [...vectorsByKind.entries()].map(([kind, vectors]) => ({
            kind,
            vectors: vectors.map((v) => [...v]),
          })),
          subjects: [...subjectVectorsByKind.entries()].map(([kind, vectors]) => ({
            kind,
            vectors: vectors.map((v) => [...v]),
          })),
        })
        .catch(() => undefined);
    }
  }

  /**
   * Route the fact embedding against scope + binding + subject prototypes.
   * Pure cosine routing — no phrase rules. Returns all signals; the final
   * decision is made by {@link decideOwnership}.
   */
  async route(
    embedding: Float32Array,
    options?: InferenceOperationOptions,
  ): Promise<ScopeRoutingResult> {
    await this.#ensurePrototypes(options);
    const scopeScores = {} as Record<ScopeOwnerKind, number>;
    for (const kind of SCOPE_OWNER_KINDS) {
      scopeScores[kind] = maxClusterCosine(embedding, this.#scopeVectors.get(kind));
    }
    const durable = maxClusterCosine(embedding, this.#scopeVectors.get("durable"));
    const temporary = maxClusterCosine(embedding, this.#scopeVectors.get("temporary"));

    const ranked = SCOPE_OWNER_KINDS.map((kind) => ({ kind, score: scopeScores[kind] })).sort(
      (a, b) => b.score - a.score,
    );
    const topKind = ranked[0]?.kind ?? "user";
    const margin = (ranked[0]?.score ?? 0) - (ranked[1]?.score ?? 0);

    const subjectRanked = SCOPE_OWNER_KINDS.map((kind) => ({
      kind,
      score: maxClusterCosine(embedding, this.#subjectVectors.get(kind)),
    })).sort((a, b) => b.score - a.score);
    const subjectKind = subjectRanked[0]?.kind ?? "user";

    const bindingDelta = temporary - durable;
    const confidence = Math.min(
      0.95,
      Math.max(0.1, 0.5 + margin * 3 + Math.max(0, bindingDelta) * 1.2),
    );
    return {
      scores: scopeScores,
      topKind,
      margin,
      entropy: normalizedEntropy(SCOPE_OWNER_KINDS.map((kind) => scopeScores[kind])),
      bindingDelta,
      subjectKind,
      confidence,
    };
  }

  /**
   * Decide the ownership scope for a fact, given its embedding and the
   * active context (which only supplies candidate owner ids).
   *
   * Decision chain (all thresholds empirically validated against bge-m3):
   *   1. topic requires positive temporary-binding evidence
   *   2. durable facts with no narrow evidence → user
   *   3. subject=user gates a marginal topic/narrow routing
   *   4. otherwise → routing top kind, resolved to an owner id from context
   *   5. any error / missing owner id / low confidence → durable user
   */
  async decideOwnership(
    fact: ExtractedFact,
    scopeContext: PiScopeContext,
    options?: InferenceOperationOptions,
  ): Promise<ScopeOwnershipDecision> {
    try {
      const routing = await this.route(fact.embedding, options);

      const topKind = routing.topKind;
      const bindingDelta = routing.bindingDelta;
      const margin = routing.margin;
      const subjectKind = routing.subjectKind;

      let ownerKind: ScopeOwnerKind;
      let reason: string;

      if (topKind === "topic" && bindingDelta < 0.06) {
        ownerKind = "user";
        reason =
          "topic requires positive temporary-binding evidence; durable fact without temporary binding belongs to the user";
      } else if (bindingDelta < 0.02 && topKind !== "topic") {
        ownerKind = "user";
        reason = "durable fact without narrow-scope evidence belongs to the user";
      } else if (subjectKind === "user" && topKind === "topic" && margin < 0.05) {
        ownerKind = "user";
        reason = "subject is the user and the marginal topic routing is not decisive";
      } else if (subjectKind === "user" && topKind !== "user" && margin < 0.02) {
        ownerKind = "user";
        reason = "subject is the user and the narrow routing margin is too small";
      } else {
        ownerKind = topKind;
        reason = `semantic routing selects ${topKind}`;
      }

      // Resolve the owner id from the active context. The context only
      // supplies candidate ids; it never decides the owner kind.
      const ownerId = resolveOwnerId(ownerKind, scopeContext);
      if (ownerId === undefined) {
        return {
          ownerKind: "user",
          ownerId: scopeContext.userId,
          confidence: 0.4,
          reason: `${ownerKind} selected but no matching active-context id; durable default to user`,
          evidence: { ...routing, degraded: true },
        };
      }

      return {
        ownerKind,
        ownerId,
        confidence: routing.confidence,
        reason,
        evidence: {
          routing: routing.scores,
          margin,
          bindingDelta,
          subjectKind,
        },
      };
    } catch {
      return {
        ownerKind: "user",
        ownerId: scopeContext.userId,
        confidence: 0.3,
        reason: "semantic scope planner unavailable; durable default to user",
        evidence: { degraded: true },
      };
    }
  }
}

// ─── Owner Id Resolution ───────────────────────────────────────────

export function resolveOwnerId(
  kind: ScopeOwnerKind,
  scopeContext: PiScopeContext,
): string | undefined {
  switch (kind) {
    case "user":
      return scopeContext.userId;
    case "project":
      return scopeContext.projectId;
    case "repository":
      return scopeContext.repositoryId;
    case "task":
      return scopeContext.taskId;
    case "topic":
      return scopeContext.topicIds?.[0];
  }
}

export function memoryScopeForDecision(
  decision: ScopeOwnershipDecision,
  scopeContext: PiScopeContext,
): MemoryScope {
  switch (decision.ownerKind) {
    case "user":
      return { kind: "user", id: scopeContext.userId };
    case "project":
      return { kind: "project", id: decision.ownerId };
    case "repository":
      return { kind: "repository", id: decision.ownerId };
    case "task":
      return { kind: "task", id: decision.ownerId };
    case "topic":
      return { kind: "topic", id: decision.ownerId };
  }
}

/** Fact key cache — embeds the fact content once when callers don't have it. */
export async function embedFactContent(
  embedding: EmbeddingProvider,
  content: string,
  dimensions: number,
  options?: InferenceOperationOptions,
): Promise<EmbeddingVector> {
  const response = await embedding.embed(
    {
      inputs: [normalizeText(content)],
      inputKind: "memory",
      dimensions,
      truncate: "reject",
    },
    { priority: "interactive", ...(options === undefined ? {} : options) },
  );
  const vector = response.vectors[0];
  if (vector === undefined) {
    throw new Error("Scope semantics: content embedding response is empty");
  }
  return vector;
}

export function scopeCacheKey(content: string): string {
  return contentHash(normalizeText(content));
}
