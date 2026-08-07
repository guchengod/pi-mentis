import { describe, it, expect } from "vitest";
import {
  detectProfileSignal,
  detectProjectSignal,
  detectCorrectionSignal,
} from "../src/scope-planner.js";
import { classifyDomain } from "../src/commit-planner.js";
import { deriveFactKey } from "../src/fact-key.js";

describe("correction detection", () => {
  it('detects "刚才说错了" as correction', () => {
    const result = detectCorrectionSignal("刚才说错了，数据库实际是 PostgreSQL");
    expect(result.isCorrection).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('detects "不是 X，是 Y" as correction', () => {
    const result = detectCorrectionSignal("刚才说错了，数据库不是 MySQL，应该是 PostgreSQL");
    expect(result.isCorrection).toBe(true);
  });

  it('detects "改成" as correction', () => {
    const result = detectCorrectionSignal("数据库改成 PostgreSQL");
    expect(result.isCorrection).toBe(true);
  });

  it("does NOT detect normal fact statement as correction", () => {
    const result = detectCorrectionSignal("这个项目的数据库是 MySQL");
    expect(result.isCorrection).toBe(false);
  });

  it("correction content classified as project domain for database facts", () => {
    const domain = classifyDomain("刚才说错了，数据库实际是 PostgreSQL", "fact", {
      tenantId: "local",
      userId: "local",
      appId: "pi",
      agentId: "pi-mentis",
      repositoryId: "test-repo",
    });
    expect(domain.domain).toBe("project");
  });

  it("correction and original fact share the same fact key predicate", () => {
    const oldKey = deriveFactKey("这个项目的数据库是 MySQL", "project");
    const correctionKey = deriveFactKey("刚才说错了，数据库实际是 PostgreSQL", "project");
    expect(oldKey.predicateKey).toBeDefined();
    expect(correctionKey.predicateKey).toBeDefined();
    expect(oldKey.factKey).toBe(correctionKey.factKey);
  });
});

describe("profile signal detection", () => {
  it('detects assistant alias from "记住你叫小明"', () => {
    const result = detectProfileSignal("以后叫你小明，记住这个名字。");
    expect(result.predicate).toBe("assistant_alias");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('detects user name from "我叫"', () => {
    const result = detectProfileSignal("我叫张三");
    expect(result.predicate).toBe("user_name");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('detects response style from "喜欢先看结论"', () => {
    const result = detectProfileSignal("我喜欢回答先给结论，再解释原因");
    expect(result.predicate).toBe("response_style");
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });
});

describe("project signal detection", () => {
  it("detects package manager as project_package_manager", () => {
    const result = detectProjectSignal("这个项目使用 pnpm 作为包管理器");
    expect(result.projectRelated).toBe(true);
    expect(result.predicate).toBe("project_package_manager");
  });

  it("detects build command as project_build_command", () => {
    const result = detectProjectSignal("构建命令是 pnpm build");
    expect(result.projectRelated).toBe(true);
    expect(result.predicate).toBe("project_build_command");
  });

  it("distinguishes general package manager preference from project-specific", () => {
    const general = detectProjectSignal("我一般用 pnpm");
    expect(general.predicate).toBe("general_package_manager_preference");
    expect(general.projectRelated).toBe(false);

    const project = detectProjectSignal("这个项目用 pnpm");
    expect(project.predicate).toBe("project_package_manager");
    expect(project.projectRelated).toBe(true);
  });
});

describe("fact key stability", () => {
  it("project_build_command predicate is detected for build content", () => {
    const key = deriveFactKey("构建命令是 pnpm build", "project");
    expect(key.predicateKey).toBe("project_build_command");
  });

  it("project_package_manager predicate is detected for package manager content", () => {
    const key = deriveFactKey("这个项目使用 pnpm", "project");
    expect(key.predicateKey).toBe("project_package_manager");
  });

  it("same predicate + same domain + same subject → same factKey", () => {
    const key1 = deriveFactKey("构建命令是 pnpm build", "project", {
      tenantId: "local",
      userId: "local",
      appId: "pi",
      agentId: "pi-mentis",
      repositoryId: "repo-a",
    });
    const key2 = deriveFactKey("这个项目的构建命令是 turbo build", "project", {
      tenantId: "local",
      userId: "local",
      appId: "pi",
      agentId: "pi-mentis",
      repositoryId: "repo-a",
    });
    expect(key1.predicateKey).toBe(key2.predicateKey);
    expect(key1.factKey).toBe(key2.factKey);
  });

  it("different repositories produce different factKeys for same fact", () => {
    const keyA = deriveFactKey("构建命令是 pnpm build", "project", {
      tenantId: "local",
      userId: "local",
      appId: "pi",
      agentId: "pi-mentis",
      repositoryId: "repo-a",
    });
    const keyB = deriveFactKey("构建命令是 npm run build", "project", {
      tenantId: "local",
      userId: "local",
      appId: "pi",
      agentId: "pi-mentis",
      repositoryId: "repo-b",
    });
    expect(keyA.predicateKey).toBe(keyB.predicateKey);
    expect(keyA.factKey).not.toBe(keyB.factKey);
  });

  it("assistant_alias fact key is stable", () => {
    const key1 = deriveFactKey("记住你叫小明", "user");
    const key2 = deriveFactKey("以后叫你小红", "user");
    expect(key1.predicateKey).toBeDefined();
    expect(key2.predicateKey).toBeDefined();
  });

  it("project_database fact key is consistent", () => {
    const key1 = deriveFactKey("数据库使用 MySQL", "project");
    const key2 = deriveFactKey("数据库实际是 PostgreSQL", "project");
    expect(key1.predicateKey).toBe("project_database");
    expect(key2.predicateKey).toBe("project_database");
  });

  it("response_style fact key is detected for Chinese content", () => {
    const key = deriveFactKey("我喜欢回答先给结论，再解释原因", "user");
    expect(key.predicateKey).toBeDefined();
    expect(key.fallbackUsed).toBe(false);
  });
});
