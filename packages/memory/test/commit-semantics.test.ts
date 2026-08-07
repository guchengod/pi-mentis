/**
 * CommitSemantics — unit tests for the phrase-free commit semantic planner.
 *
 * Deterministic prototype/content vectors exercise the decision rules;
 * open-expression generalization against the live model is validated by the
 * live probe (scripts/commit-semantics-probe.test.ts).
 */

import { describe, it, expect } from "vitest";

import { CommitSemanticPlanner } from "../src/commit-semantics.js";
import { DEFAULT_PREDICATE_REGISTRY } from "../src/predicate-registry.js";
import type { EmbeddingProvider, EmbeddingRequest, EmbeddingResponse } from "@pi-mentis/pi-mentis-inference";

const DIM = 16;
// Axis layout: [action:create, reinforce, correct, replace, retract,
//               polarity:pos, neg,
//               predicate:build, test, package_manager, database, deploy,
//               style, language, runtime, subject]
const AX = {
  create: 0,
  reinforce: 1,
  correct: 2,
  replace: 3,
  retract: 4,
  pos: 5,
  neg: 6,
  build: 7,
  test: 8,
  packageManager: 9,
  database: 10,
  deploy: 11,
  style: 12,
  language: 13,
  runtime: 14,
} as const;

function axis(a: number): Float32Array {
  const v = new Float32Array(DIM);
  v[a] = 1;
  return v;
}

type OwnerKind = "create" | "reinforce" | "correct" | "replace" | "retract";
type PolarityKind = "positive" | "negative";

function contentVector(
  action: OwnerKind,
  polarity: PolarityKind,
  predicateAxis: number,
): Float32Array {
  const v = new Float32Array(DIM);
  v[AX[action]] = 1;
  v[polarity === "positive" ? AX.pos : AX.neg] = 1;
  v[predicateAxis] = 1;
  return v;
}

class CommitTestEmbeddingProvider implements EmbeddingProvider {
  readonly id = "commit-test";
  readonly #routing = new Map<string, Float32Array>();

  register(text: string, vector: Float32Array): void {
    this.#routing.set(text, vector);
  }

  async capabilities() {
    return { models: [] };
  }

  async health() {
    return { status: "healthy" as const, checkedAt: Date.now() };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    return {
      model: { providerId: this.id, modelId: "commit-test", capabilityVersion: "1" },
      vectors: request.inputs.map((input) => ({
        values: this.#routing.get(input) ?? new Float32Array(DIM),
        dimensions: request.dimensions,
        normalized: true,
      })),
      usage: { inputTokens: request.inputs.reduce((sum, text) => sum + text.length, 0) },
    };
  }
}

function prototypes(): Map<string, Float32Array[]> {
  const map = new Map<string, Float32Array[]>();
  map.set("create", [axis(AX.create)]);
  map.set("reinforce", [axis(AX.reinforce)]);
  map.set("correct", [axis(AX.correct)]);
  map.set("replace", [axis(AX.replace)]);
  map.set("retract", [axis(AX.retract)]);
  map.set("polarity:positive", [axis(AX.pos)]);
  map.set("polarity:negative", [axis(AX.neg)]);
  // Predicate vectors: use the real registry so the domain-prior path is exercised.
  map.set("predicate:project_build_command", [axis(AX.build)]);
  map.set("predicate:project_test_command", [axis(AX.test)]);
  map.set("predicate:project_package_manager", [axis(AX.packageManager)]);
  map.set("predicate:project_database", [axis(AX.database)]);
  map.set("predicate:project_deployment_target", [axis(AX.deploy)]);
  map.set("predicate:response_style", [axis(AX.style)]);
  map.set("predicate:language", [axis(AX.language)]);
  map.set("predicate:runtime", [axis(AX.runtime)]);
  return map;
}

function planner() {
  const provider = new CommitTestEmbeddingProvider();
  return {
    provider,
    planner: new CommitSemanticPlanner({
      embedding: provider,
      dimensions: DIM,
      registry: DEFAULT_PREDICATE_REGISTRY,
      prototypeVectors: prototypes(),
    }),
  };
}

describe("CommitSemanticPlanner — action intent", () => {
  const cases: readonly {
    label: string;
    action: OwnerKind;
    polarity: PolarityKind;
    expected: string;
  }[] = [
    { label: "新事实", action: "create", polarity: "positive", expected: "create" },
    { label: "确认同意", action: "reinforce", polarity: "positive", expected: "reinforce" },
    { label: "纠正之前", action: "correct", polarity: "positive", expected: "correct" },
    { label: "更换配置", action: "replace", polarity: "positive", expected: "replace" },
    { label: "删除记忆", action: "retract", polarity: "negative", expected: "retract" },
  ];
  for (const c of cases) {
    it(`${c.label} → ${c.expected}`, async () => {
      const { provider, planner: plan } = planner();
      const text = `fact ${c.label}`;
      provider.register(text, contentVector(c.action, c.polarity, AX.build));
      const result = await plan.plan(text, contentVector(c.action, c.polarity, AX.build), "project");
      expect(result.actionIntent).toBe(c.expected);
    });
  }

  it("ambiguous action with low margin falls back to create (safe default)", async () => {
    const { planner: plan } = planner();
    // Equal create + replace activation → no margin → create
    const mixed = new Float32Array(DIM);
    mixed[AX.create] = 0.5;
    mixed[AX.replace] = 0.5;
    const result = await plan.plan("ambiguous", mixed, "project");
    expect(result.actionIntent).toBe("create");
  });

  it("retract requires a strong margin (destructive gate)", async () => {
    const { planner: plan } = planner();
    // retract barely beats create → must NOT retract
    const weak = new Float32Array(DIM);
    weak[AX.retract] = 0.52;
    weak[AX.create] = 0.48;
    const result = await plan.plan("weak retract", weak, "project");
    expect(result.actionIntent).not.toBe("retract");
  });
});

describe("CommitSemanticPlanner — predicate + type + cardinality", () => {
  it("project_build_command → type fact, cardinality single, predicate set", async () => {
    const { planner: plan } = planner();
    const result = await plan.plan("build", contentVector("create", "positive", AX.build), "project");
    expect(result.predicate).toBe("project_build_command");
    expect(result.type).toBe("fact");
    expect(result.cardinality).toBe("single");
    expect(result.fallbackPredicate).toBe(false);
  });

  it("language predicate → set cardinality + normalized value", async () => {
    const { planner: plan } = planner();
    const result = await plan.plan(
      "我喜欢 Go 和 TypeScript",
      contentVector("create", "positive", AX.language),
      "user",
    );
    expect(result.predicate).toBe("language");
    expect(result.cardinality).toBe("set");
  });

  it("domain prior: project domain prefers project_package_manager", async () => {
    const { planner: plan } = planner();
    // Slight edge to the preference variant; domain metadata must flip it.
    const v = new Float32Array(DIM);
    v[AX.packageManager] = 1;
    v[AX.packageManager] = 1;
    v[AX.create] = 1;
    v[AX.pos] = 1;
    const result = await plan.plan("package manager", v, "project");
    expect(result.predicate).toBe("project_package_manager");
  });

  it("no confident predicate → fallback (stable identity preserved)", async () => {
    const { planner: plan } = planner();
    const result = await plan.plan(
      "一些无法匹配的事实",
      contentVector("create", "positive", 15), // unused axis
      "user",
    );
    expect(result.fallbackPredicate).toBe(true);
    expect(result.predicate).toBeUndefined();
    expect(result.cardinality).toBe("single");
  });

  it("correction action forces type fact", async () => {
    const { planner: plan } = planner();
    const result = await plan.plan(
      "纠正",
      contentVector("correct", "positive", AX.database),
      "project",
    );
    expect(result.actionIntent).toBe("correct");
    expect(result.type).toBe("fact");
  });
});

describe("CommitSemanticPlanner — polarity", () => {
  it("positive content → positive", async () => {
    const { planner: plan } = planner();
    const result = await plan.plan(
      "允许",
      contentVector("create", "positive", AX.build),
      "project",
    );
    expect(result.polarity).toBe("positive");
  });

  it("negative content → negative", async () => {
    const { planner: plan } = planner();
    const result = await plan.plan(
      "禁止",
      contentVector("create", "negative", AX.build),
      "project",
    );
    expect(result.polarity).toBe("negative");
  });

  it("low polarity margin defaults to positive", async () => {
    const { planner: plan } = planner();
    const v = new Float32Array(DIM);
    v[AX.create] = 1;
    v[AX.pos] = 0.51;
    v[AX.neg] = 0.49;
    const result = await plan.plan("mixed", v, "project");
    expect(result.polarity).toBe("positive");
  });
});
