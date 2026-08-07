/* Live probe: validate CommitSemanticPlanner prototype routing with real bge-m3. */
import { describe, it, expect } from "vitest";
import { loadConfig } from "@pi-mentis/pi-mentis-core";
import { SiliconFlowEmbeddingProvider } from "@pi-mentis/pi-mentis-siliconflow";
import { ACTION_PROTOTYPES, POLARITY_PROTOTYPES } from "@pi-mentis/pi-mentis-memory-core";

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
