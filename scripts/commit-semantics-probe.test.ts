/* Live probe: validate CommitSemanticPlanner prototype routing with real bge-m3. */
import { describe, it, expect } from "vitest";
import { loadConfig } from "@pi-mentis/pi-mentis-core";
import { SiliconFlowEmbeddingProvider } from "@pi-mentis/pi-mentis-siliconflow";
import {
  ACTION_PROTOTYPES,
  POLARITY_PROTOTYPES,
  decideValueRelation,
} from "@pi-mentis/pi-mentis-memory-core";

const CASES: readonly {
  label: string;
  text: string;
  action: string;
  polarity: string;
}[] = [
  { label: "C1", text: "以后我说默认方案时，意思是维护成本最低的方案。", action: "create", polarity: "positive" },
  { label: "C2", text: "对，就是这个，没错。", action: "reinforce", polarity: "positive" },
  { label: "C3", text: "刚才说错了，数据库实际是 PostgreSQL。", action: "correct", polarity: "positive" },
  { label: "C4", text: "包管理器改成 pnpm，不用 npm 了。", action: "replace", polarity: "positive" },
  { label: "C5", text: "忘掉我之前说的那个配置。", action: "retract", polarity: "negative" },
  { label: "C6", text: "这个项目不能使用 CGO。", action: "create", polarity: "negative" },
  { label: "C7", text: "我处理任务时喜欢先拆最小步骤。", action: "create", polarity: "positive" },
  { label: "C8", text: "构建命令是 pnpm build。", action: "create", polarity: "positive" },
  { label: "C9", text: "撤掉那条记忆。", action: "retract", polarity: "negative" },
  { label: "C10", text: "之前说的不算，改用 yarn。", action: "replace", polarity: "positive" },
];

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}
function cosine(a: Float32Array, b: Float32Array): number {
  const la = Math.sqrt(dot(a, a));
  const lb = Math.sqrt(dot(b, b));
  if (la === 0 || lb === 0) return 0;
  return dot(a, b) / (la * lb);
}

describe("commit semantics prototype routing probe (live)", () => {
  it("routes action/type/polarity", async () => {
    const config = await loadConfig(process.cwd());
    const provider = new SiliconFlowEmbeddingProvider(config.inference.siliconflow);
    const dims = config.inference.siliconflow.embedding.dimensions;
    const embed = async (texts: string[]) => {
      const resp = await provider.embed({ inputs: texts, inputKind: "document", dimensions: dims });
      return resp.vectors.map((v) => v.values);
    };
    const clusterScore = (vec: Float32Array, cluster: readonly { anchors: string[] }[] | undefined, kind: string): number => {
      const anchors = cluster?.find((c) => c.kind === kind)?.anchors ?? [];
      return Math.max(0, ...anchors.map((a) => cosine(vec, anchorVecs.get(a) ?? vec)));
    };
    const anchorVecs = new Map<string, Float32Array>();
    const allAnchors = [...ACTION_PROTOTYPES, ...POLARITY_PROTOTYPES].flatMap(
      (c) => c.anchors,
    );
    const vecs = await embed(allAnchors);
    allAnchors.forEach((a, i) => anchorVecs.set(a, vecs[i] ?? new Float32Array(dims)));

    let actionOk = 0;
    let polarityOk = 0;
    let gatedOkCount = 0;
    const rows: string[] = [];
    for (const c of CASES) {
      const [vec] = await embed([c.text]);
      const actionScores = ACTION_PROTOTYPES.map((p) => ({ kind: p.kind, score: clusterScore(vec, ACTION_PROTOTYPES, p.kind) })).sort((a, b) => b.score - a.score);
      const polarityScores = POLARITY_PROTOTYPES.map((p) => ({ kind: p.kind, score: clusterScore(vec, POLARITY_PROTOTYPES, p.kind) })).sort((a, b) => b.score - a.score);
      const action = actionScores[0]?.kind ?? "?";
      const polarity = polarityScores[0]?.kind ?? "?";
      if (action === c.action) actionOk++;
      if (polarity === c.polarity) polarityOk++;
      const aMargin = (actionScores[0]?.score ?? 0) - (actionScores[1]?.score ?? 0);
      const pMargin = (polarityScores[0]?.score ?? 0) - (polarityScores[1]?.score ?? 0);
      // Production decision gates (mirrors commit-semantics.ts):
      //   retract requires margin >= 0.08 (destructive); other intents >= 0.03; else create.
      const gated =
        action === "retract" && aMargin >= 0.08
          ? "retract"
          : action !== "create" && action !== "retract" && aMargin >= 0.03
            ? action
            : "create";
      const gatedOk = gated === c.action;
      if (gatedOk) gatedOkCount++;
      rows.push(
        `${gatedOk ? "G✓" : "G✗"} ${c.label.padEnd(3)} raw=${action.padEnd(9)}(aM=${aMargin.toFixed(3)}) gated=${gated.padEnd(9)}(exp ${c.action.padEnd(9)}) polarity=${polarity}(pM=${pMargin.toFixed(3)})`,
      );
    }
    console.log("\n" + rows.join("\n"));
    console.log(`\nRAW ACTION: ${actionOk}/${CASES.length}  POLARITY: ${polarityOk}/${CASES.length}  GATED DECISION: ${gatedOkCount}/${CASES.length}`);
    expect(true).toBe(true);
  }, 120_000);
});

// ─── Value-relation probe: same fact, equivalent vs changed value ──

const VALUE_CASES: readonly {
  label: string;
  incoming: string;
  existing: string;
  predicate: string;
  expected: string;
}[] = [
  {
    label: "V1 (real regression)",
    incoming: "我对实验分支的命名偏好是使用星体、星座等天文主题名称，避免单纯的数字名称。",
    existing: "我个人给实验性分支起名字时，更喜欢使用天文相关的名称，不喜欢纯数字编号。",
    predicate: "user_name",
    expected: "equivalent",
  },
  {
    label: "V2 (Case A)",
    incoming: "写实现时我倾向直白、少层级。",
    existing: "我喜欢简单直接的代码。",
    predicate: "code_style_preference",
    expected: "equivalent",
  },
  {
    label: "V3 (Case C)",
    incoming: "我的默认 shell 使用 zsh。",
    existing: "默认 shell 是 zsh。",
    predicate: "runtime",
    expected: "equivalent",
  },
  {
    label: "V4 (Case D)",
    incoming: "默认 shell 现在是 fish。",
    existing: "默认 shell 是 zsh。",
    predicate: "runtime",
    expected: "different",
  },
  {
    label: "V5 (Case E)",
    incoming: "TypeScript 也是我喜欢的语言。",
    existing: "我喜欢 Go。",
    predicate: "language",
    expected: "additive",
  },
  {
    label: "V6 (Case F)",
    incoming: "我喜欢自动生成分支名。",
    existing: "我不喜欢自动生成分支名。",
    predicate: "user_name",
    expected: "contradictory",
  },
  {
    label: "V7 (false positive)",
    incoming: "我喜欢简单直接的回答。",
    existing: "我喜欢简单直接的实现。",
    predicate: "code_style_preference",
    expected: "not-equivalent",
  },
  {
    label: "V8 (false positive)",
    incoming: "生产分支使用天文命名。",
    existing: "实验分支使用天文命名。",
    predicate: "user_name",
    expected: "not-equivalent",
  },
];

describe("value relation probe (live)", () => {
  it("routes equivalent vs changed value on same fact", async () => {
    const config = await loadConfig(process.cwd());
    const provider = new SiliconFlowEmbeddingProvider(config.inference.siliconflow);
    const dims = config.inference.siliconflow.embedding.dimensions;
    const embed = async (texts: string[]) => {
      const resp = await provider.embed({ inputs: texts, inputKind: "document", dimensions: dims });
      return resp.vectors.map((v: { values: Float32Array }) => v.values);
    };
    const rows: string[] = [];
    for (const c of VALUE_CASES) {
      const [incomingVec, existingVec] = await embed([c.incoming, c.existing]);
      const decision = decideValueRelation({
        incoming: {
          content: c.incoming,
          embedding: incomingVec,
          polarity: c.incoming.includes("不喜欢") ? "negative" : "positive",
          normalizedValue: undefined,
          setMemberKey: undefined,
          cardinality: c.predicate === "language" ? "set" : "single",
          semanticIntent: undefined,
        },
        existing: {
          content: c.existing,
          embedding: existingVec,
          polarity: c.existing.includes("不喜欢") ? "negative" : "positive",
          normalizedValue: undefined,
          setMemberKey: undefined,
          cardinality: c.predicate === "language" ? "set" : "single",
        },
        predicate: c.predicate,
      });
      const ok =
        c.expected === "not-equivalent"
          ? decision.relation !== "equivalent"
          : decision.relation === c.expected;
      rows.push(
        `${ok ? "✓" : "✗"} ${c.label.padEnd(20)} relation=${decision.relation.padEnd(13)} (exp ${c.expected.padEnd(13)}) cosine=${decision.embeddingSimilarity?.toFixed(3)} signal=${decision.signal}`,
      );
    }
    console.log("\n" + rows.join("\n"));
    expect(true).toBe(true);
  }, 120_000);
});
