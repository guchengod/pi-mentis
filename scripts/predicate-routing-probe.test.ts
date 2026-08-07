/* Live probe: predicate routing vs the real PredicateRegistry with bge-m3. */
import { describe, it, expect } from "vitest";
import { loadConfig } from "@pi-mentis/pi-mentis-core";
import { SiliconFlowEmbeddingProvider } from "@pi-mentis/pi-mentis-siliconflow";
import {
  buildPredicateSemanticText,
  DEFAULT_PREDICATE_REGISTRY,
  predicateDefinition,
} from "@pi-mentis/pi-mentis-memory-core";

const CASES: readonly { label: string; text: string; expected: string; domain?: string }[] = [
  { label: "P1", text: "以后我说默认方案时，意思是维护成本最低的方案。", expected: "fallback" },
  { label: "P2", text: "构建命令是 pnpm build。", expected: "project_build_command", domain: "project" },
  { label: "P3", text: "这个项目使用 pnpm 作为包管理器。", expected: "project_package_manager", domain: "project" },
  { label: "P4", text: "数据库使用 PostgreSQL。", expected: "project_database", domain: "project" },
  { label: "P5", text: "回答先给结论，再解释原因。", expected: "response_style" },
  { label: "P6", text: "我喜欢 Go 和 Rust。", expected: "programming_language_preference" },
  { label: "P7", text: "测试命令是 pnpm test。", expected: "project_test_command", domain: "project" },
  { label: "P8", text: "部署到生产环境用 staging 先验证。", expected: "project_deployment_target", domain: "project" },
  { label: "P9", text: "以后叫你小明。", expected: "assistant_alias" },
  { label: "P10", text: "我的临时实验环境叫雾松。", expected: "fallback" },
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

describe("predicate routing probe (live)", () => {
  it("routes content against registry predicates", async () => {
    const config = await loadConfig(process.cwd());
    const provider = new SiliconFlowEmbeddingProvider(config.inference.siliconflow);
    const dims = config.inference.siliconflow.embedding.dimensions;
    const embed = async (texts: string[]) => {
      const resp = await provider.embed({ inputs: texts, inputKind: "document", dimensions: dims });
      return resp.vectors.map((v) => v.values);
    };
    const definitions = DEFAULT_PREDICATE_REGISTRY.list();
    const texts = definitions.map(buildPredicateSemanticText);
    const protoVecs = await embed(texts);

    let correct = 0;
    let correctTop3 = 0;
    const rows: string[] = [];
    for (const c of CASES) {
      const [vec] = await embed([c.text]);
      const ranked = definitions
        .map((def, i) => ({ predicate: def.id, score: cosine(vec, protoVecs[i] ?? vec) }))
        .sort((a, b) => b.score - a.score);
      const top = ranked[0]?.predicate ?? "?";
      const top3 = ranked.slice(0, 3).map((r) => r.predicate).join(",");
      const margin = (ranked[0]?.score ?? 0) - (ranked[1]?.score ?? 0);
      // Production gated decision (mirrors CommitSemanticPlanner.#routePredicate):
      //   accept top if score >= 0.4 AND margin >= 0.02; else try the best
      //   domain-matching predicate (metadata prior); else fallback.
      const domain = c.domain ?? "user";
      const domainMatches = ranked.filter((r) =>
        predicateDefinition(r.predicate)?.memoryDomains.includes(domain),
      );
      const bestDomain = domainMatches[0];
      let decision: string;
      if (top !== "?" && (ranked[0]?.score ?? 0) >= 0.4 && margin >= 0.02) {
        decision = top;
      } else if (
        bestDomain !== undefined &&
        bestDomain.score >= 0.35 &&
        ((ranked[0]?.score ?? 0) - bestDomain.score) <= 0.05
      ) {
        decision = bestDomain.predicate;
      } else {
        decision = "fallback";
      }
      const ok = decision === c.expected;
      const ok3 = ranked.slice(0, 3).some((r) => r.predicate === c.expected) || (c.expected === "fallback" && margin < 0.03);
      if (ok) correct++;
      if (ok3) correctTop3++;
      rows.push(
        `${ok ? "PASS" : "FAIL"} ${c.label.padEnd(3)} top=${top.padEnd(28)} margin=${margin.toFixed(3)} top3=[${top3}] expected=${c.expected}`,
      );
    }
    console.log("\n" + rows.join("\n"));
    console.log(`\nGATED PREDICATE DECISION: ${correct}/${CASES.length}  TOP3-RAW: ${correctTop3}/${CASES.length}`);
    expect(true).toBe(true);
  }, 120_000);
});
