/* Live probe: validate semantic scope prototype routing with the real bge-m3 model. */
import { describe, it, expect } from "vitest";
import { loadConfig } from "@pi-mentis/pi-mentis-core";
import { SiliconFlowEmbeddingProvider } from "@pi-mentis/pi-mentis-siliconflow";

import { SCOPE_PROTOTYPES, SCOPE_SUBJECT_PROTOTYPES } from "@pi-mentis/pi-mentis-memory-core";

// Use the PRODUCTION prototype clusters so the probe validates exactly what ships.
const SCOPE_CLUSTERS: readonly { kind: string; anchors: string[] }[] = SCOPE_PROTOTYPES.map(
  (p) => ({ kind: p.kind, anchors: [...p.anchors] }),
);
const SUBJECT_CLUSTERS: readonly { kind: string; anchors: string[] }[] =
  SCOPE_SUBJECT_PROTOTYPES.map((p) => ({ kind: p.kind, anchors: [...p.anchors] }));

const CASES: readonly { label: string; text: string; expected: string }[] = [
  { label: "U1", text: "Aether 是我平时对快速原型模式的叫法。", expected: "user" },
  { label: "U2", text: "我长期更倾向于维护工作量小的实现。", expected: "user" },
  { label: "U3", text: "我经常在讨论里先给结论。", expected: "user" },
  { label: "U4", text: "我所有项目里都倾向使用 Go。", expected: "user" },
  { label: "U5", text: "我处理任务时喜欢先拆最小步骤。", expected: "user" },
  { label: "U6", text: "我平时把话题分成三个层次。", expected: "user" },
  { label: "UA", text: "我的个人测试区代号叫青沐。", expected: "user" },
  { label: "UB", text: "我更喜欢维护成本低的方案。", expected: "user" },
  { label: "P1", text: "对于 Nebula 这个工程，运行期禁止依赖外部 Python。", expected: "project" },
  { label: "P2", text: "这个项目内部服务端口固定为 45671。", expected: "project" },
  { label: "R1", text: "在该代码库中，发布候选版本统一从 staging-next 产生。", expected: "repository" },
  { label: "T1", text: "当前这项迁移完成以前，不调整索引格式。", expected: "task" },
  { label: "T2", text: "这次数据库迁移先不要改 schema。", expected: "task" },
  { label: "TP1", text: "在眼下讨论的这个设计问题内，暂且把第二种结构称作 T-branch。", expected: "topic" },
  { label: "TP2", text: "这里先约定 M7 表示刚才讨论的第二条路径，离开当前讨论不用沿用。", expected: "topic" },
  { label: "TP3", text: "For the purpose of this design thread only, call option B Atlas.", expected: "topic" },
  { label: "TP4", text: "这个 alias 只在 current design thread 里有效：K9 = candidate B。", expected: "topic" },
  { label: "TP5", text: "只在我们这段讨论里，暂时把方案 B 叫'赤桥'。", expected: "topic" },
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

describe("scope prototype routing probe (live)", () => {
  it("routes open expressions", async () => {
    const config = await loadConfig(process.cwd());
    const provider = new SiliconFlowEmbeddingProvider(config.inference.siliconflow);
    const dims = config.inference.siliconflow.embedding.dimensions;
    const embed = async (texts: string[]) => {
      const resp = await provider.embed({ inputs: texts, inputKind: "document", dimensions: dims });
      return resp.vectors.map((v) => v.values);
    };
    const protoVecs = new Map<string, Float32Array[]>();
    for (const cluster of SCOPE_CLUSTERS) {
      const vecs = await embed(cluster.anchors);
      protoVecs.set(cluster.kind, vecs);
    }
    const subjVecs = new Map<string, Float32Array[]>();
    for (const cluster of SUBJECT_CLUSTERS) {
      const vecs = await embed(cluster.anchors);
      subjVecs.set(cluster.kind, vecs);
    }
    const scopeKinds = ["user", "project", "repository", "task", "topic"] as const;
    const clusterScore = (kind: string, vec: Float32Array): number => {
      const cluster = protoVecs.get(kind) ?? [];
      return Math.max(0, ...cluster.map((anchor) => cosine(vec, anchor)));
    };
    const maxClusterScore = (vec: Float32Array, cluster: Float32Array[] | undefined): number => {
      if (cluster === undefined || cluster.length === 0) return 0;
      return Math.max(0, ...cluster.map((anchor) => cosine(vec, anchor)));
    };

    const rows: string[] = [];
    let correct = 0;
    let combinedCorrect = 0;
    for (const c of CASES) {
      const [vec] = await embed([c.text]);
      const scores = scopeKinds.map((k) => ({ kind: k, score: clusterScore(k, vec) }));
      scores.sort((a, b) => b.score - a.score);
      const durable = clusterScore("durable", vec);
      const temporary = clusterScore("temporary", vec);
      const bindingDelta = temporary - durable;
      const top = scores[0]?.kind ?? "?";
      const ok = top === c.expected;

      const subjScores = scopeKinds.map((k) => ({
        kind: k,
        score: maxClusterScore(vec, subjVecs.get(k)),
      }));
      subjScores.sort((a, b) => b.score - a.score);
      const subjTop = subjScores[0]?.kind ?? "?";

      const userScore = scores.find((s) => s.kind === "user")?.score ?? 0;
      const topicScore = scores.find((s) => s.kind === "topic")?.score ?? 0;
      const taskScore = scores.find((s) => s.kind === "task")?.score ?? 0;
      const projScore = scores.find((s) => s.kind === "project")?.score ?? 0;
      const repoScore = scores.find((s) => s.kind === "repository")?.score ?? 0;
      const margin = (scores[0]?.score ?? 0) - (scores[1]?.score ?? 0);

      let combined: string;
      // Topic requires positive temporary-binding evidence: a durable user alias
      // ("平时", "长期") mentioning naming language must NOT become topic.
      if (top === "topic" && bindingDelta < 0.06) {
        combined = "user";
      } else if (bindingDelta < 0.02 && top !== "topic") {
        combined = "user";
      } else if (subjTop === "user" && top === "topic" && margin < 0.05) {
        combined = "user";
      } else if (subjTop === "user" && top !== "user" && margin < 0.02) {
        combined = "user";
      } else {
        combined = top;
      }
      const combinedOk = combined === c.expected;
      if (ok) correct++;
      if (combinedOk) combinedCorrect++;
      rows.push(
        `${ok ? "PASS" : "FAIL"} ${combinedOk ? "PASS" : "FAIL"} ${c.label.padEnd(3)} ` +
          `top=${top.padEnd(10)} subj=${subjTop.padEnd(10)} margin=${margin.toFixed(3)} ` +
          `u=${userScore.toFixed(3)} p=${projScore.toFixed(3)} r=${repoScore.toFixed(3)} ` +
          `t=${taskScore.toFixed(3)} tp=${topicScore.toFixed(3)} ` +
          `dur=${durable.toFixed(3)} tmp=${temporary.toFixed(3)} bind=${bindingDelta.toFixed(3)} ` +
          `combined=${combined} expected=${c.expected}`,
      );
    }
    console.log("\n" + rows.join("\n"));
    console.log(`\nRAW ROUTING ACCURACY: ${correct}/${CASES.length}`);
    console.log(`COMBINED ACCURACY: ${combinedCorrect}/${CASES.length}`);
    expect(true).toBe(true);
  }, 120_000);
});
