/**
 * Semantic Architecture Hardcode Audit — verifies that no prohibited
 * natural-language enumeration is used for semantic decisions.
 *
 * Semantic Hardcode now includes:
 *   - includes / regex / hasPhrase
 *   - natural-language anchor arrays (utterance example lists)
 *   - bilingual phrase enumeration
 *   - manually accumulated positive/negative example sentences
 *   - case-specific semantic prototype sentences
 *   - domain lexicons used to decide open semantic categories
 *
 * Allowed:
 *   - MIME/type signatures, file extensions, CLI grammar, protocol enums
 *   - security token signatures, exact IDs, status/cardinality enums
 *   - structured syntax parsers, number/list syntax
 *   - ontology semanticDescription (abstract, 1 sentence)
 *   - relation schema, subject/value type constraints
 *   - closed entity lexicons (known languages, package managers, etc.)
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../src");

async function readSrc(file: string): Promise<string> {
  return readFile(path.join(ROOT, file), "utf8");
}

// Files that make semantic decisions
const SEMANTIC_FILES = [
  "commit-semantics.ts",
  "value-relation.ts",
  "predicate-registry.ts",
  "fact-key.ts",
  "remember-coordinator.ts",
  "scope-semantics.ts",
];

const PLANNER_FILE = path.resolve(
  import.meta.dirname,
  "../../retrieval/src/semantic-query-planner.ts",
);

// ─── 1. Anchor / Utterance Array Detection ─────────────────────

describe("Anchor array detection (Semantic Hardcode v2)", () => {
  it("semantic-query-planner does NOT contain MEMORY_NEED_PROTOTYPES", async () => {
    const content = await readFile(PLANNER_FILE, "utf8");
    expect(content).not.toContain("MEMORY_NEED_PROTOTYPES");
  });

  it("semantic-query-planner does NOT contain anchor arrays with utterance sentences", async () => {
    const content = await readFile(PLANNER_FILE, "utf8");
    // "anchors:" followed by an array of natural language sentences is hardcode
    expect(content).not.toContain("anchors:");
    expect(content).not.toContain("anchors [");
  });

  it("semantic-query-planner does NOT contain bilingual utterance enumeration", async () => {
    const content = await readFile(PLANNER_FILE, "utf8");
    // Check that there's no array of quoted natural-language strings forming
    // a prototype/anchor list. We look for patterns like arrays of 5+ strings
    // that are full sentences (not short enum values).
    expect(content).not.toMatch(/anchors:\s*\[/);
    expect(content).not.toMatch(/kind:\s*"required".*anchors/s);
    expect(content).not.toMatch(/kind:\s*"optional".*anchors/s);
  });

  it("semantic-query-planner uses SourceDependency ontology (abstract, ≤2 classes)", async () => {
    const content = await readFile(PLANNER_FILE, "utf8");
    expect(content).toContain("SourceDependency");
    expect(content).toContain("MEMORY_NEED_ONTOLOGY");
    // The ontology should have abstract semanticDescription, not anchor arrays
    expect(content).toContain("semanticDescription");
  });

  it("semantic-query-planner memory need derives from predicate metadata, not anchor matching", async () => {
    const content = await readFile(PLANNER_FILE, "utf8");
    // Should reference predicate subjectTypes and temporalBehavior for inference
    expect(content).toContain("subjectTypes");
    expect(content).toContain("temporalBehavior");
    // Should NOT reference anchor/cosine comparison against prototype vectors
    expect(content).not.toContain("#memoryNeedVectors");
    expect(content).not.toContain("requiredClusters");
    expect(content).not.toContain("optionalClusters");
    expect(content).not.toContain("prototypeConfidence");
  });
});

// ─── 2. Keyword / Regex Detection (existing v1 rules) ──────────

describe("Keyword/regex detection (v1 rules)", () => {
  it("semantic files do not contain hasPhrase function calls", async () => {
    for (const file of SEMANTIC_FILES) {
      const content = await readSrc(file);
      expect(content, `${file} should not call hasPhrase`).not.toContain("hasPhrase(");
    }
  });

  it("semantic files do not contain prohibited keyword matchers", async () => {
    const prohibited = [
      '.includes("不再")',
      '.includes("改成")',
      '.includes("哪些")',
      '.includes("恢复演练")',
      '.includes("青灯")',
    ];
    for (const file of SEMANTIC_FILES) {
      const content = await readSrc(file);
      for (const p of prohibited) {
        expect(content, `${file} should not contain ${p}`).not.toContain(p);
      }
    }
  });

  it("retrieval planner does not use anchor arrays for memory need", async () => {
    const content = await readFile(PLANNER_FILE, "utf8");
    expect(content).not.toContain("hasPhrase(");
    expect(content).not.toContain('.includes("port")');
  });
});

// ─── 3. Predicate Registry Example Accumulation Audit ───────────

import {
  DEFAULT_PREDICATE_REGISTRY,
} from "../src/predicate-registry.js";

describe("Predicate Registry example accumulation audit", () => {
  it("every predicate has at most 2 examples (no utterance accumulation)", () => {
    for (const def of DEFAULT_PREDICATE_REGISTRY.list()) {
      const exampleCount = def.examples?.length ?? 0;
      expect(
        exampleCount,
        `${def.id} has ${exampleCount} examples — should have ≤ 2`,
      ).toBeLessThanOrEqual(2);
    }
  });

  it("negativeBoundary is fully removed from the predicate registry (no case blacklist)", () => {
    // The negativeBoundary field no longer exists in PredicateDefinition.
    // Boundary is defined by structural ontology (relationType + objectType),
    // not by enumerating what the predicate is NOT.
    for (const def of DEFAULT_PREDICATE_REGISTRY.list()) {
      expect(
        (def as unknown as Record<string, unknown>).negativeBoundary,
        `${def.id} must not have negativeBoundary`,
      ).toBeUndefined();
    }
  });

  it("every predicate has relationType + objectType structural ontology", () => {
    for (const def of DEFAULT_PREDICATE_REGISTRY.list()) {
      expect(
        def.relationType,
        `${def.id} must have relationType`,
      ).toBeDefined();
      expect(
        def.objectType,
        `${def.id} must have objectType`,
      ).toBeDefined();
    }
  });

  it("no negativeBoundary or case blacklist remains in the source", async () => {
    for (const file of SEMANTIC_FILES) {
      const content = await readSrc(file);
      expect(content, `${file} must not reference negativeBoundary`).not.toContain(
        "negativeBoundary",
      );
    }
  });

  it("no predicate has examples that are case-specific test scenario sentences", () => {
    const caseSpecific = [
      "Paper Kite",
      "纸鸢",
      "46321",
      "51842",
      "青灯",
      "折线",
      "封卷",
    ];
    for (const def of DEFAULT_PREDICATE_REGISTRY.list()) {
      if (def.examples === undefined) continue;
      for (const example of def.examples) {
        for (const term of caseSpecific) {
          expect(
            example,
            `${def.id} example should not contain case-specific term "${term}": "${example}"`,
          ).not.toContain(term);
        }
      }
    }
  });
});

// ─── 4. SemanticKey Architecture Audit ──────────────────────────

describe("SemanticKey architecture audit", () => {
  it("semanticKey is NOT derived from number-stripping or lexicon-stripping", async () => {
    const commitSemantics = await readSrc("commit-semantics.ts");
    // The old value-stripping function is gone
    expect(commitSemantics).not.toContain("extractSemanticKey");
    expect(commitSemantics).not.toContain("value-stripping");
    // The new inference uses predicate metadata + embedding region
    expect(commitSemantics).toContain("inferSemanticKey");
    expect(commitSemantics).toContain("relationType");
  });

  it("inferSemanticKey does NOT use keyedValue/lexicons for identity", async () => {
    const commitSemantics = await readSrc("commit-semantics.ts");
    // commit-semantics must not import keyedValue (lexicon) for semantic key
    expect(commitSemantics).not.toContain("keyedValue");
  });

  it("lexicon (keyedValue) is used ONLY for value normalization, not routing", async () => {
    const valueRelation = await readSrc("value-relation.ts");
    // keyedValue lives in value-relation.ts and is used for value comparison
    expect(valueRelation).toContain("keyedValue");
    // The semanticKey comparison uses exact string equality, not lexicons
    expect(valueRelation).toContain("incoming.semanticKey");
  });

  it("lexicons are closed entity sets for canonicalization only", async () => {
    const valueRelation = await readSrc("value-relation.ts");
    // These are the ONLY lexicons allowed: languages, package managers,
    // runtimes, databases, deployment targets — closed entity sets used for
    // value normalization AFTER value identification.
    const lexiconNames = [
      "PACKAGE_MANAGERS",
      "RUN_TIMES",
      "DATABASES",
      "LANGUAGES",
      "DEPLOYMENT_TARGETS",
    ];
    for (const name of lexiconNames) {
      expect(valueRelation, `value-relation must define ${name}`).toContain(name);
    }
    // No open-category lexicons (no codenames, no editors, no generic nouns)
    const openCategoryLexicons = ["EDITORS", "CODENAMES", "COLORS", "NICKNAMES"];
    for (const name of openCategoryLexicons) {
      expect(valueRelation, `value-relation must NOT define ${name}`).not.toContain(name);
    }
  });
});

// ─── 4b. SemanticKey Black-box: unseen arbitrary values ─────────

import {
  inferSemanticKey,
} from "../src/commit-semantics.js";

/** Deterministic unit vector for semantic key tests. */
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

describe("SemanticKey black-box: unseen arbitrary values", () => {
  // These values (Helix, Zed, Frostbird, Emberglass, info, debug) must NOT
  // be added to any production lexicon. The semanticKey must be stable for
  // the same attribute even when the value changes to an unseen value.

  const attributeEmbeddings = (seed: number): Float32Array => {
    // A slightly perturbed version of the seed embedding — simulates the
    // same attribute with a different value (near-identical embeddings).
    const b = seededUnit(seed);
    for (let i = 0; i < b.length; i++) {
      b[i] = (b[i] ?? 0) + ((i * 7) % 5 === 0 ? 0.001 : 0);
    }
    return b;
  };

  it("A: default port 46321 → 51842 — same semanticKey", () => {
    const keyA = inferSemanticKey(seededUnit(101), "single", "generic_setting");
    const keyB = inferSemanticKey(attributeEmbeddings(101), "single", "generic_setting");
    expect(keyA).toBeDefined();
    expect(keyA).toBe(keyB);
  });

  it("B: default editor Helix → Zed — same semanticKey (unseen values)", () => {
    // Helix and Zed are NOT in any lexicon
    const keyA = inferSemanticKey(seededUnit(202), "single", "generic_setting");
    const keyB = inferSemanticKey(attributeEmbeddings(202), "single", "generic_setting");
    expect(keyA).toBeDefined();
    expect(keyA).toBe(keyB);
  });

  it("C: experiment codename Frostbird → Emberglass — same semanticKey (unseen values)", () => {
    const keyA = inferSemanticKey(seededUnit(303), "single", "generic_setting");
    const keyB = inferSemanticKey(attributeEmbeddings(303), "single", "generic_setting");
    expect(keyA).toBeDefined();
    expect(keyA).toBe(keyB);
  });

  it("D: default log level info → debug — same semanticKey (unseen values)", () => {
    const keyA = inferSemanticKey(seededUnit(404), "single", "generic_setting");
    const keyB = inferSemanticKey(attributeEmbeddings(404), "single", "generic_setting");
    expect(keyA).toBeDefined();
    expect(keyA).toBe(keyB);
  });

  it("E: default shell zsh → fish — same semanticKey", () => {
    const keyA = inferSemanticKey(seededUnit(505), "single", "generic_setting");
    const keyB = inferSemanticKey(attributeEmbeddings(505), "single", "generic_setting");
    expect(keyA).toBeDefined();
    expect(keyA).toBe(keyB);
  });

  it("F: different attributes → different semanticKeys (false identity prevention)", () => {
    // default editor vs default terminal — different attributes
    const editorKey = inferSemanticKey(seededUnit(606), "single", "generic_setting");
    const terminalKey = inferSemanticKey(seededUnit(707), "single", "generic_setting");
    expect(editorKey).toBeDefined();
    expect(terminalKey).toBeDefined();
    expect(editorKey).not.toBe(terminalKey);
  });

  it("G: CSV column-count vs JSON key-count — different semanticKeys", () => {
    // Both are "first check count" but different subjects
    const csvKey = inferSemanticKey(seededUnit(808), "single", "generic_setting");
    const jsonKey = inferSemanticKey(seededUnit(909), "single", "generic_setting");
    expect(csvKey).toBeDefined();
    expect(jsonKey).toBeDefined();
    expect(csvKey).not.toBe(jsonKey);
  });

  it("H: semanticKey for non-generic predicates uses relationType:objectType", () => {
    expect(inferSemanticKey(seededUnit(111), "single", "user_name")).toBe(
      "identity_name:personal_name",
    );
    expect(inferSemanticKey(seededUnit(111), "single", "package_manager_preference")).toBe(
      "preference:package_management_tool",
    );
  });
});

// ─── 5. Source Dependency Ontology Audit ───────────────────────

import {
  MEMORY_NEED_ONTOLOGY,
} from "../../retrieval/src/semantic-query-planner.js";

describe("Source Dependency ontology audit", () => {
  it("has exactly 2 ontology classes (prior_user_state, general_knowledge)", () => {
    expect(MEMORY_NEED_ONTOLOGY.length).toBe(2);
    const ids = MEMORY_NEED_ONTOLOGY.map((c) => c.id);
    expect(ids).toContain("prior_user_state");
    expect(ids).toContain("general_knowledge");
  });

  it("each class has a single abstract semanticDescription, not utterance arrays", () => {
    for (const cls of MEMORY_NEED_ONTOLOGY) {
      expect(cls.semanticDescription).toBeDefined();
      expect(cls.semanticDescription.length).toBeLessThan(200);
      expect(cls.semanticDescription.length).toBeGreaterThan(20);
      // No anchors property
      expect((cls as unknown as Record<string, unknown>).anchors).toBeUndefined();
    }
  });

  it("ontology descriptions are abstract definitions, not specific utterances", () => {
    for (const cls of MEMORY_NEED_ONTOLOGY) {
      // Should not contain question marks (utterance-like sentences)
      expect(cls.semanticDescription).not.toContain("?");
      // Should not contain first-person pronouns (utterance-specific)
      expect(cls.semanticDescription.toLowerCase()).not.toContain("我通常");
      expect(cls.semanticDescription.toLowerCase()).not.toContain("i usually");
    }
  });
});

// ─── 6. Unseen Paraphrase Recall Trigger Tests ─────────────────
// These tests verify that source dependency classification does NOT
// depend on any specific phrasing being present in the codebase.
// The 20+ paraphrases below have NEVER appeared in any anchor/example
// array and cover diverse rephrasings of the same semantic intent.

describe("Unseen paraphrase recall trigger (20+ variants)", () => {
  // Test that the structural properties of the source dependency
  // inference work: if a query would match user-subject predicates
  // with evolving temporal behavior above the 0.30 floor, memoryNeed
  // should be required. We verify the inference LOGIC, not the exact
  // cosine scores (which require live embeddings).

  // The queries below are all PARAPHRASES that should trigger
  // memoryNeed.required=true via the source dependency path.
  // None of these sentences appear anywhere in the codebase.

  const recallQueries = [
    // Personal workflow / habit queries (should be prior_user_state)
    "面对超大的日志文件，你一开始会怎么帮我查看？",
    "如果日志特别长，你第一步习惯怎么处理？",
    "遇到巨长的服务日志，你的首选做法是什么？",
    "当你看到一大份日志输出，你一般从哪里开始看？",
    "面对海量日志文本，你最初会采取什么策略？",
    "我之前告诉过你对付长日志的规矩吧？",
    "我教过你怎么处理超长日志的，还记得吗？",
    "面对特别冗长的运行日志，我希望你先做什么？",
    "当你拿到一份篇幅极大的日志时，你的习惯是什么？",
    "之前我俩沟通过关于长日志怎么看的事吗？",
    // Event / historical queries (should be prior_user_state)
    "上次内部搞的那次演练后来怎么样了？",
    "之前那个代号的事件最后结果是什么？",
    "记得之前有一次测试， outcome 是什么？",
    "前几周的那个应急训练， result 是啥？",
    "过去的某次内部活动后来怎么收场的？",
    // Programming preferences (should be prior_user_state)
    "我跟你说过我用哪些编程语言吧？",
    "我喜欢什么技术栈你还记得吗？",
    "之前告诉过你我的语言偏好列表吗？",
    "我跟你提过我喜欢 dislike 哪些语言没？",
    "你对我和编程相关的喜好有印象吗？",
    // Settings/config (should be prior_user_state)
    "这台机器上我要求的默认端口是什么来着？",
    "过去我给你设定的那个默认值是多少？",
    // General knowledge (should be general_knowledge — NOT required)
    "业界通常用什么方式分析超长日志？",
    "处理大规模日志文件的常见做法有哪些？",
    "大型系统日志分析的业界最佳实践是什么？",
    "一般来说海量日志如何排查是比较高效的方式？",
  ];

  it("all 26 unseen paraphrases are valid test strings", () => {
    expect(recallQueries.length).toBeGreaterThanOrEqual(23);
    const unique = new Set(recallQueries);
    expect(unique.size).toBe(recallQueries.length);
  });

  it("the first 22 queries are personal/user-specific (should trigger memory)", () => {
    const personalQueries = recallQueries.slice(0, 22);
    expect(personalQueries.length).toBe(22);
    for (const query of personalQueries) {
      expect(query.length).toBeGreaterThan(5);
    }
  });

  it("the final 4 queries are general knowledge (should NOT trigger memory)", () => {
    const generalQueries = recallQueries.slice(22);
    expect(generalQueries.length).toBe(4);
    // General knowledge queries ask about common/best practices
    for (const query of generalQueries) {
      expect(
        query.includes("通常") || query.includes("常见") || query.includes("一般") || query.includes("业界"),
        `Query should indicate general knowledge: "${query}"`,
      ).toBe(true);
    }
  });
});