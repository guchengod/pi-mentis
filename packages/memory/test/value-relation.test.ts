/**
 * ValueRelation — unit tests for the same-fact / same-value semantic
 * equivalence router (Cases A–F + false positives from the spec).
 */

import { describe, expect, it } from "vitest";

import {
  decideValueRelation,
  type ValueRelationInput,
} from "../src/value-relation.js";

// ─── Vector helpers ───────────────────────────────────────────────

function seededUnit(seed: number): Float32Array {
  const vector = new Float32Array(64);
  let state = seed * 2654435761;
  let squared = 0;
  for (let index = 0; index < vector.length; index++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const value = ((state / 0xffffffff) * 2 - 1) as number;
    vector[index] = value;
    squared += value * value;
  }
  const norm = Math.sqrt(squared);
  for (let index = 0; index < vector.length; index++) {
    vector[index] = (vector[index] ?? 0) / norm;
  }
  return vector;
}

/** A unit vector with a target cosine against `base`. */
function withCosine(base: Float32Array, target: number, seed: number): Float32Array {
  const perpendicular = seededUnit(seed);
  let dot = 0;
  for (let index = 0; index < perpendicular.length; index++) {
    dot += (base[index] ?? 0) * (perpendicular[index] ?? 0);
  }
  const component = new Float32Array(perpendicular.length);
  for (let index = 0; index < component.length; index++) {
    component[index] = (perpendicular[index] ?? 0) - dot * (base[index] ?? 0);
  }
  let squared = 0;
  for (const value of component) squared += value * value;
  const norm = Math.sqrt(squared) || 1;
  const result = new Float32Array(base.length);
  for (let index = 0; index < result.length; index++) {
    result[index] =
      target * (base[index] ?? 0) +
      Math.sqrt(Math.max(0, 1 - target * target)) * ((component[index] ?? 0) / norm);
  }
  return result;
}

// ─── Input builder ────────────────────────────────────────────────

function input(overrides: {
  readonly incomingContent?: string;
  readonly existingContent?: string;
  readonly similarity?: number;
  readonly incomingEmbedding?: Float32Array;
  readonly existingEmbedding?: Float32Array;
  readonly incomingPolarity?: "positive" | "negative";
  readonly existingPolarity?: "positive" | "negative";
  readonly incomingValue?: string;
  readonly existingValue?: string;
  readonly incomingSetMember?: string;
  readonly existingSetMember?: string;
  readonly cardinality?: "single" | "set" | "ordered" | "event";
  readonly predicate?: string;
  readonly intent?: "create" | "reinforce" | "correct" | "replace" | "retract";
}): ValueRelationInput {
  const base = seededUnit(7);
  const similarity = overrides.similarity;
  const incomingEmbedding = overrides.incomingEmbedding ?? base;
  const existingEmbedding =
    overrides.existingEmbedding ??
    (similarity === undefined ? base : withCosine(base, similarity, 13));
  return {
    incoming: {
      content: overrides.incomingContent ?? "incoming",
      embedding: incomingEmbedding,
      polarity: overrides.incomingPolarity,
      normalizedValue: overrides.incomingValue,
      setMemberKey: overrides.incomingSetMember,
      cardinality: overrides.cardinality ?? "single",
      semanticIntent: overrides.intent,
    },
    existing: {
      content: overrides.existingContent ?? "existing",
      embedding: existingEmbedding,
      polarity: overrides.existingPolarity,
      normalizedValue: overrides.existingValue,
      setMemberKey: overrides.existingSetMember,
      cardinality: overrides.cardinality ?? "single",
    },
    predicate: overrides.predicate,
  };
}

describe("ValueRelation — structured values win", () => {
  it("same structured value → equivalent", () => {
    const decision = decideValueRelation(
      input({
        incomingValue: "pnpm",
        existingValue: "pnpm",
        predicate: "project_package_manager",
        similarity: 0.99,
      }),
    );
    expect(decision.relation).toBe("equivalent");
    expect(decision.confidence).toBeGreaterThan(0.9);
    expect(decision.signal).toContain("structured");
  });

  it("same structured value with flipped polarity → contradictory", () => {
    const decision = decideValueRelation(
      input({
        incomingValue: "pnpm",
        existingValue: "pnpm",
        incomingPolarity: "negative",
        existingPolarity: "positive",
        predicate: "project_package_manager",
      }),
    );
    expect(decision.relation).toBe("contradictory");
  });

  it("different structured value, single cardinality → different (Case D)", () => {
    const decision = decideValueRelation(
      input({
        incomingValue: "fish",
        existingValue: "zsh",
        predicate: "runtime",
        similarity: 0.99, // near-identical wording — structure must win
      }),
    );
    expect(decision.relation).toBe("different");
  });

  it("different structured value, set cardinality → additive (Case E)", () => {
    const decision = decideValueRelation(
      input({
        incomingValue: "typescript",
        existingValue: "go",
        cardinality: "set",
        predicate: "language",
        similarity: 0.9,
      }),
    );
    expect(decision.relation).toBe("additive");
  });

  it("lexicon extraction: shell paraphrase → equivalent (Case C)", () => {
    const decision = decideValueRelation(
      input({
        incomingContent: "我的默认 shell 使用 zsh。",
        existingContent: "默认 shell 是 zsh。",
        predicate: "runtime",
        similarity: 0.7, // structure decides, similarity is irrelevant
      }),
    );
    expect(decision.relation).toBe("equivalent");
    expect(decision.normalizedIncomingValue).toBe("zsh");
    expect(decision.normalizedExistingValue).toBe("zsh");
  });

  it("lexicon extraction: zsh vs fish → different (Case D)", () => {
    const decision = decideValueRelation(
      input({
        incomingContent: "默认 shell 现在是 fish。",
        existingContent: "默认 shell 是 zsh。",
        predicate: "runtime",
        similarity: 0.99, // near-identical wording — structure must win
      }),
    );
    expect(decision.relation).toBe("different");
    expect(decision.normalizedIncomingValue).toBe("fish");
    expect(decision.normalizedExistingValue).toBe("zsh");
  });

  it("no lexicon for predicate → semantic path decides (moderate similarity → unknown)", () => {
    const decision = decideValueRelation(
      input({
        incomingContent: "默认 shell 现在是 fish。",
        existingContent: "默认 shell 是 zsh。",
        predicate: "user_name",
        similarity: 0.7,
      }),
    );
    expect(decision.relation).toBe("unknown");
  });
});

describe("ValueRelation — semantic equivalence (open preferences)", () => {
  it("high similarity + same polarity → equivalent (Case A/B)", () => {
    const decision = decideValueRelation(
      input({
        incomingContent: "写实现时我倾向直白、少层级。",
        existingContent: "我喜欢简单直接的代码。",
        similarity: 0.95,
        predicate: "code_style_preference",
      }),
    );
    expect(decision.relation).toBe("equivalent");
    expect(decision.confidence).toBeGreaterThan(0.8);
  });

  it("high similarity + set cardinality → equivalent (Case A set)", () => {
    const decision = decideValueRelation(
      input({
        similarity: 0.95,
        cardinality: "set",
        predicate: "code_style_preference",
      }),
    );
    expect(decision.relation).toBe("equivalent");
  });

  it("low similarity → different (changed value)", () => {
    const decision = decideValueRelation(
      input({ similarity: 0.3, predicate: "user_name" }),
    );
    expect(decision.relation).toBe("different");
  });

  it("moderate similarity without intent → unknown (no destructive action)", () => {
    const decision = decideValueRelation(
      input({ similarity: 0.7, predicate: "user_name" }),
    );
    expect(decision.relation).toBe("unknown");
  });

  it("reinforce intent + moderate similarity → equivalent even without confirmative wording (sec. 7)", () => {
    const decision = decideValueRelation(
      input({
        similarity: 0.83,
        intent: "reinforce",
        predicate: "user_name",
      }),
    );
    expect(decision.relation).toBe("equivalent");
  });

  it("replace intent + moderate similarity → different even with confirmative wording (sec. 8)", () => {
    const decision = decideValueRelation(
      input({
        similarity: 0.7,
        intent: "replace",
        predicate: "user_name",
      }),
    );
    expect(decision.relation).toBe("different");
  });

  it("flipped polarity + high similarity → contradictory (Case F)", () => {
    const decision = decideValueRelation(
      input({
        incomingContent: "我喜欢自动生成分支名。",
        existingContent: "我不喜欢自动生成分支名。",
        similarity: 0.9,
        incomingPolarity: "positive",
        existingPolarity: "negative",
        predicate: "user_name",
      }),
    );
    expect(decision.relation).toBe("contradictory");
  });

  it("missing embedding → unknown", () => {
    const base = seededUnit(7);
    const decision = decideValueRelation({
      incoming: {
        content: "incoming",
        embedding: base,
        polarity: undefined,
        normalizedValue: undefined,
        setMemberKey: undefined,
        cardinality: "single",
        semanticIntent: undefined,
      },
      existing: {
        content: "existing",
        embedding: undefined,
        polarity: undefined,
        normalizedValue: undefined,
        setMemberKey: undefined,
        cardinality: "single",
      },
      predicate: "user_name",
    });
    expect(decision.relation).toBe("unknown");
    expect(decision.embeddingSimilarity).toBeUndefined();
  });
});

describe("ValueRelation — false positives must not reinforce", () => {
  it("similar but distinct values (实现 vs 回答) → not equivalent", () => {
    const decision = decideValueRelation(
      input({ similarity: 0.65, predicate: "user_name" }),
    );
    expect(decision.relation).not.toBe("equivalent");
    expect(decision.relation).toBe("unknown");
  });

  it("different subjects (实验分支 vs 生产分支) → not equivalent without intent", () => {
    const decision = decideValueRelation(
      input({ similarity: 0.82, predicate: "user_name" }),
    );
    expect(decision.relation).not.toBe("equivalent");
    expect(decision.relation).toBe("unknown");
  });

  it("different subjects with reinforce intent at moderate similarity → still not equivalent", () => {
    const decision = decideValueRelation(
      input({ similarity: 0.75, intent: "reinforce", predicate: "user_name" }),
    );
    expect(decision.relation).not.toBe("equivalent");
  });
});

describe("ValueRelation — evidence surface", () => {
  it("reports similarity, values, intent, and signal for traces", () => {
    const decision = decideValueRelation(
      input({
        incomingContent: "对，就是这样",
        similarity: 0.9,
        intent: "reinforce",
        predicate: "user_name",
      }),
    );
    expect(decision.embeddingSimilarity).toBeGreaterThan(0.89);
    expect(decision.semanticIntent).toBe("reinforce");
    expect(decision.factors.length).toBeGreaterThan(0);
    expect(decision.signal.length).toBeGreaterThan(0);
  });
});
