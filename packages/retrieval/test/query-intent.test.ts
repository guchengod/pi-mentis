import { describe, it, expect } from "vitest";
import {
  analyzeQueryIntent,
  predicateCompatibility,
  predicateBoostScore,
  computeRelevanceThreshold,
  formatIntentSummary,
} from "../src/query-intent.js";

describe("analyzeQueryIntent", () => {
  it("recognizes code design preference query as specific", () => {
    const intent = analyzeQueryIntent("我对代码设计有什么偏好？");
    expect(intent.domain).toBe("code_design");
    expect(intent.specificity).toBe("specific");
    expect(intent.predicates).toContain("code_style_preference");
    expect(intent.predicates).toContain("architecture_preference");
    expect(intent.predicates).toContain("abstraction_preference");
  });

  it("recognizes code design preference query without question mark", () => {
    const intent = analyzeQueryIntent("我代码设计有什么偏好");
    expect(intent.domain).toBe("code_design");
    expect(intent.specificity).toBe("specific");
  });

  it("recognizes response style query", () => {
    const intent = analyzeQueryIntent("我喜欢什么回答方式？");
    expect(intent.domain).toBe("response_style");
    expect(intent.specificity).toBe("specific");
    expect(intent.predicates).toContain("response_style");
  });

  it("recognizes package manager query", () => {
    const intent = analyzeQueryIntent("我一般喜欢哪个包管理器？");
    expect(intent.domain).toBe("package_manager");
    expect(intent.predicates).toContain("package_manager_preference");
  });

  it("recognizes pnpm query as package_manager", () => {
    const intent = analyzeQueryIntent("我用pnpm还是npm？");
    expect(intent.domain).toBe("package_manager");
  });

  it("recognizes broad preference summary query", () => {
    const intent = analyzeQueryIntent("总结一下我的偏好。");
    expect(intent.specificity).toBe("broad");
  });

  it("recognizes broad 'what are my preferences' query", () => {
    const intent = analyzeQueryIntent("我有什么偏好？");
    expect(intent.specificity).toBe("broad");
  });

  it("returns broad specificity for generic queries", () => {
    const intent = analyzeQueryIntent("告诉我你知道什么");
    expect(intent.specificity).toBe("broad");
    expect(intent.domain).toBeUndefined();
  });

  it("returns specific specificity when domain is present but query is not broad", () => {
    const intent = analyzeQueryIntent("代码喜欢简单直接");
    expect(intent.domain).toBe("code_design");
    expect(intent.specificity).toBe("specific");
  });

  it("recognizes editor preference query", () => {
    const intent = analyzeQueryIntent("我用什么编辑器？");
    expect(intent.domain).toBe("editor");
  });

  it("recognizes database preference query", () => {
    const intent = analyzeQueryIntent("我喜欢哪个数据库？");
    expect(intent.domain).toBe("database");
  });
});

describe("predicateCompatibility", () => {
  const codeIntent = analyzeQueryIntent("我对代码设计有什么偏好？");
  const responseIntent = analyzeQueryIntent("我喜欢什么回答方式？");
  const pkgIntent = analyzeQueryIntent("我一般喜欢哪个包管理器？");

  it("marks code design content as compatible with code design query", () => {
    const result = predicateCompatibility("用户代码风格偏好：简单直接、避免不必要抽象", codeIntent);
    expect(result.compatible).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });

  it("marks response style content as incompatible with code design query", () => {
    const result = predicateCompatibility("用户偏好回答先给结论，再解释原因", codeIntent);
    // For specific code design queries, response style should be incompatible
    expect(result.compatible).toBe(false);
  });

  it("marks pnpm content as incompatible with code design query", () => {
    const result = predicateCompatibility("用户偏好 pnpm", codeIntent);
    expect(result.compatible).toBe(false);
  });

  it("marks response style content as compatible with response style query", () => {
    const result = predicateCompatibility(
      "用户偏好回答先给结论，再解释原因",
      responseIntent,
    );
    expect(result.compatible).toBe(true);
  });

  it("returns lower score for code design content on response style query", () => {
    // Cross-domain keywords like "风格" can appear in both, so compatibility check
    // is lenient, but the score should be low or negative
    const result = predicateCompatibility(
      "用户代码风格偏好：简单直接、避免不必要抽象",
      responseIntent,
    );
    expect(result.score).toBeLessThan(0.2);
  });

  it("marks pnpm content as compatible with package manager query", () => {
    const result = predicateCompatibility("用户偏好 pnpm", pkgIntent);
    expect(result.compatible).toBe(true);
  });

  it("marks code design content as incompatible with package manager query", () => {
    const result = predicateCompatibility(
      "用户倾向简单直接的代码设计，避免为了抽象而增加不必要的接口层",
      pkgIntent,
    );
    expect(result.compatible).toBe(false);
  });

  it("allows all content for broad queries", () => {
    const broadIntent = analyzeQueryIntent("总结一下我的偏好。");
    const codeResult = predicateCompatibility(
      "用户代码风格偏好：简单直接、避免不必要抽象",
      broadIntent,
    );
    const responseResult = predicateCompatibility(
      "用户偏好回答先给结论，再解释原因",
      broadIntent,
    );
    const pkgResult = predicateCompatibility("用户偏好 pnpm", broadIntent);
    expect(codeResult.compatible).toBe(true);
    expect(responseResult.compatible).toBe(true);
    expect(pkgResult.compatible).toBe(true);
  });
});

describe("predicateBoostScore", () => {
  const codeIntent = analyzeQueryIntent("我对代码设计有什么偏好？");

  it("boosts code design content for code design queries", () => {
    const boost = predicateBoostScore("用户代码风格偏好：简单直接、避免不必要抽象", codeIntent);
    expect(boost).toBeGreaterThan(0);
  });

  it("penalizes response style content for code design queries", () => {
    const boost = predicateBoostScore("用户偏好回答先给结论，再解释原因", codeIntent);
    expect(boost).toBeLessThan(0);
  });

  it("returns zero boost when no specific domain", () => {
    const broadIntent = { specificity: "broad" as const };
    const boost = predicateBoostScore("任意内容", broadIntent);
    expect(boost).toBe(0);
  });
});

describe("computeRelevanceThreshold", () => {
  it("returns higher threshold for specific queries", () => {
    expect(computeRelevanceThreshold({ specificity: "specific" })).toBe(0.12);
  });

  it("returns lower threshold for broad queries", () => {
    expect(computeRelevanceThreshold({ specificity: "broad" })).toBe(0.06);
  });
});

describe("formatIntentSummary", () => {
  it("returns undefined for empty hits", () => {
    expect(formatIntentSummary([], { specificity: "specific" })).toBeUndefined();
  });

  it("truncates single hit to 150 chars", () => {
    const long = "a".repeat(200);
    const result = formatIntentSummary([{ content: long }], { specificity: "specific" });
    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(153); // 150 + "..."
  });

  it("uses domain label for specific queries with multiple hits", () => {
    const intent = analyzeQueryIntent("我对代码设计有什么偏好？");
    const result = formatIntentSummary(
      [{ content: "简单直接的代码" }, { content: "避免不必要抽象" }],
      intent,
    );
    expect(result).toBeDefined();
    expect(result!).toContain("代码设计偏好");
  });

  it("synthesizes broad queries by joining content", () => {
    const intent = analyzeQueryIntent("总结一下我的偏好。");
    const result = formatIntentSummary(
      [{ content: "回答先给结论" }, { content: "喜欢简单代码" }],
      intent,
    );
    expect(result).toBeDefined();
    expect(result!).toContain("回答先给结论");
    expect(result!).toContain("喜欢简单代码");
  });
});
