import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const suite = process.argv[2] ?? "all";
const allowedSuites = new Set([
  "all",
  "inference",
  "knowledge",
  "memory",
  "combined",
  "pi",
  "restart",
  "performance",
  "formats",
  "faults",
  "migration",
]);
if (!allowedSuites.has(suite)) throw new Error(`Unknown Live E2E suite: ${suite}`);
if (process.env.PI_MENTIS_LIVE_E2E !== "1") {
  throw new Error("Refusing real API use unless PI_MENTIS_LIVE_E2E=1");
}

function requiredEnvironment(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value !== undefined && value !== "") return { name, value };
  }
  throw new Error(`${names.join(" or ")} is required; no fallback is permitted`);
}

const apiKey = requiredEnvironment("SILICONFLOW_API_KEY");
const embeddingModel = requiredEnvironment("SILICONFLOW_EMBEDDING_MODEL");
const rerankModel = requiredEnvironment("SILICONFLOW_RERANK_MODEL", "SILICONFLOW_RERANKER_MODEL");
const baseUrl = process.env.SILICONFLOW_BASE_URL?.trim() || "https://api.siliconflow.cn/v1";
const dimensions = Number(
  process.env.SILICONFLOW_EMBEDDING_DIMENSIONS?.trim() ||
    (embeddingModel.value === "BAAI/bge-m3" ? "1024" : ""),
);
const rerankMaxInputTokens = Number(
  process.env.SILICONFLOW_RERANK_MAX_INPUT_TOKENS?.trim() ||
    (rerankModel.value === "BAAI/bge-reranker-v2-m3" ? "8192" : ""),
);
if (!Number.isSafeInteger(dimensions)) {
  throw new Error("SILICONFLOW_EMBEDDING_DIMENSIONS is required for this Embedding model");
}
if (!Number.isSafeInteger(rerankMaxInputTokens)) {
  throw new Error("SILICONFLOW_RERANK_MAX_INPUT_TOKENS is required for this Rerank model");
}

const runId = `live-e2e-${new Date().toISOString().replaceAll(/[-:.]/g, "").replace("Z", "Z")}-${randomBytes(3).toString("hex")}`;
const artifactRoot = path.join(root, ".artifacts", "live-e2e", runId);
const directories = Object.fromEntries(
  ["home", "pi-config", "workspace", "zvec", "fixtures", "reports", "logs", "packages"].map(
    (name) => [name, path.join(artifactRoot, name)],
  ),
);
await Promise.all(
  Object.values(directories).map((directory) => mkdir(directory, { recursive: true })),
);

const diagnosticsFile = path.join(directories.logs, "inference.jsonl");
process.env.PI_MENTIS_INFERENCE_DIAGNOSTICS_FILE = diagnosticsFile;
const budget = {
  maxEmbeddingRequests: 200,
  maxEmbeddingInputs: 2_500,
  maxRerankRequests: 80,
  maxRerankDocuments: 2_000,
  maxEstimatedTokens: 1_000_000,
};
const report = {
  runId,
  suite,
  startedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    piVersion: "0.83.0",
    piCommit: "845d6ff",
    os: `${os.platform()} ${os.release()}`,
    architecture: os.arch(),
    zvecVersion: "0.6.0",
    siliconFlowBaseUrl: baseUrl,
    embeddingModel: embeddingModel.value,
    embeddingDimensions: dimensions,
    rerankModel: rerankModel.value,
    rerankMaxInputTokens,
    credentialSource: `${apiKey.name} from process environment`,
    embeddingModelSource: `${embeddingModel.name} from process environment`,
    rerankModelSource: `${rerankModel.name} from process environment`,
  },
  budget,
  tools: {},
  scenarios: [],
  restarts: [],
};
console.log(
  JSON.stringify({
    runId,
    suite,
    configuration: {
      apiKey: "set (redacted)",
      baseUrl,
      embeddingModel: embeddingModel.value,
      dimensions,
      rerankModel: rerankModel.value,
      rerankMaxInputTokens,
    },
    budget,
  }),
);

const childEnvironment = {
  ...process.env,
  HOME: directories.home,
  PI_CONFIG_DIR: directories["pi-config"],
  PI_MENTIS_LIVE_E2E: "1",
  PI_MENTIS_INFERENCE_DIAGNOSTICS_FILE: diagnosticsFile,
  SILICONFLOW_BASE_URL: baseUrl,
  SILICONFLOW_EMBEDDING_MODEL: embeddingModel.value,
  SILICONFLOW_EMBEDDING_DIMENSIONS: String(dimensions),
  SILICONFLOW_RERANK_MODEL: rerankModel.value,
  SILICONFLOW_RERANKER_MODEL: rerankModel.value,
  SILICONFLOW_RERANK_MAX_INPUT_TOKENS: String(rerankMaxInputTokens),
};

async function runCommand(label, command, argumentsList, options = {}) {
  const started = performance.now();
  const output = [];
  const child = spawn(command, argumentsList, {
    cwd: options.cwd ?? root,
    env: options.env ?? childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const text = Buffer.concat(output).toString("utf8");
  await writeFile(path.join(directories.logs, `${label}.log`), text);
  if (exitCode !== 0)
    throw new Error(`${label} failed with exit ${exitCode}: ${text.slice(-2_000)}`);
  return { durationMs: performance.now() - started, output: text };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function scenario(name, started, evidence = {}) {
  report.scenarios.push({
    name,
    status: "PASS",
    durationMs: performance.now() - started,
    ...evidence,
  });
}

async function preparePackages() {
  await runCommand("build", "pnpm", ["build"]);
  await runCommand("pack", "pnpm", ["pack:extensions"]);
  const archiveDirectory = path.join(root, "dist", "extensions");
  const archives = (await readdir(archiveDirectory))
    .filter((filename) => filename.endsWith(".tgz"))
    .map((filename) => path.join(archiveDirectory, filename));
  assert(archives.length === 3, `Expected three packed extensions, found ${archives.length}`);
  await writeFile(
    path.join(directories.packages, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        pnpm: { onlyBuiltDependencies: ["@zvec/zvec"] },
      },
      null,
      2,
    )}\n`,
  );
  await runCommand(
    "install-packed-extensions",
    "pnpm",
    [
      "add",
      "--ignore-workspace",
      ...archives,
      "@earendil-works/pi-coding-agent@0.83.0",
      "@earendil-works/pi-agent-core@0.83.0",
      "@earendil-works/pi-ai@0.83.0",
      "@earendil-works/pi-tui@0.83.0",
      "@zvec/zvec@0.6.0",
      "csv-parse@6.1.0",
      "fast-xml-parser@5.3.3",
      "fflate@0.8.2",
      "pdfjs-dist@5.4.530",
      "smol-toml@1.6.0",
      "yaml@2.8.1",
      "typebox@1.3.7",
    ],
    { cwd: directories.packages },
  );
}

await writeFile(path.join(directories.workspace, ".pi-mentis", "config.json"), "").catch(
  async (error) => {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(path.join(directories.workspace, ".pi-mentis"), { recursive: true });
  },
);
await writeFile(
  path.join(directories.workspace, ".pi-mentis", "config.json"),
  `${JSON.stringify(
    {
      knowledge: { defaultNamespace: `e2e:${runId}`, autoSync: false },
      retrieval: {
        autoRecallSoftTimeoutMs: 15_000,
        autoRecallHardTimeoutMs: 30_000,
        manualSearchTimeoutMs: 30_000,
        maxManualSearchTimeoutMs: 60_000,
      },
      inference: {
        embedding: { queryCacheEntries: 8, queryCacheTtlMs: 60_000 },
        rerank: { cacheEntries: 8, cacheTtlMs: 60_000 },
        siliconflow: {
          timeout: { embeddingMs: 60_000, rerankMs: 60_000 },
          retry: { maxAttempts: 2, baseDelayMs: 200, maxDelayMs: 1_000 },
        },
      },
      storage: { rootDir: directories.zvec, lockTimeoutMs: 10_000 },
    },
    null,
    2,
  )}\n`,
);
await preparePackages();

let driverSequence = 0;
async function runPi(packageName, operations, identity = {}) {
  driverSequence++;
  const stem = `pi-${driverSequence}-${packageName.split("/").at(-1)}`;
  const requestFile = path.join(directories.logs, `${stem}-request.json`);
  const responseFile = path.join(directories.logs, `${stem}-response.json`);
  const request = {
    runId,
    packageName,
    packagesDir: directories.packages,
    workspace: directories.workspace,
    piConfigDir: directories["pi-config"],
    sessionId: identity.sessionId ?? `session-e2e-${runId}-${driverSequence}`,
    branchId: identity.branchId ?? `branch:e2e:${runId}`,
    operations,
  };
  await writeFile(requestFile, `${JSON.stringify(request, null, 2)}\n`);
  await runCommand(
    stem,
    process.execPath,
    [path.join(root, "scripts/live-e2e-pi-driver.mjs"), requestFile, responseFile],
    { env: { ...childEnvironment, ...(identity.environment ?? {}) } },
  );
  const response = JSON.parse(await readFile(responseFile, "utf8"));
  assert(response.ok === true, `Pi driver failed: ${response.error ?? "unknown error"}`);
  assert(response.piVersion === "0.83.0", `Packed extension loaded with Pi ${response.piVersion}`);
  for (const tool of response.toolDefinitions ?? []) {
    assertNoStringLiteralUnion(tool.parameters, `${tool.name}.parameters`);
  }
  return response;
}

function assertNoStringLiteralUnion(value, location) {
  if (value === null || typeof value !== "object") return;
  if (
    Array.isArray(value.anyOf) &&
    value.anyOf.length > 0 &&
    value.anyOf.every(
      (entry) => entry !== null && typeof entry === "object" && typeof entry.const === "string",
    )
  ) {
    throw new Error(`${location} uses a Google-incompatible string literal union`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "anyOf" && Array.isArray(child)) {
      child.forEach((entry, index) =>
        assertNoStringLiteralUnion(entry, `${location}.anyOf[${index}]`),
      );
      continue;
    }
    assertNoStringLiteralUnion(child, `${location}.${key}`);
  }
}

function toolPayload(entry) {
  const text = entry?.result?.content?.find((item) => item.type === "text")?.text;
  assert(typeof text === "string", "Pi tool did not return a text result");
  return JSON.parse(text);
}

function searchPayload(entry) {
  const payload = toolPayload(entry);
  return payload.search ?? payload;
}

function simplePdf(text) {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

async function createFormatFixtures() {
  const require = createRequire(path.join(root, "packages/file-parsers/package.json"));
  const { strToU8, zipSync } = require("fflate");
  const short = runId.slice(-12).replaceAll("-", "");
  const entries = [];
  async function fixture(name, bytes, query, marker, kind = "file") {
    const filename = path.join(directories.fixtures, name);
    await writeFile(filename, bytes);
    entries.push({ name, filename, query, marker, kind });
  }
  await fixture(
    "format.txt",
    `TXT_MARKER_${short} deployment window is midnight.`,
    "TXT deployment window?",
    `TXT_MARKER_${short}`,
  );
  await fixture(
    "format.md",
    `# Markdown Policy\n\nMD_MARKER_${short} labels use kebab-case.`,
    "Markdown label policy?",
    `MD_MARKER_${short}`,
  );
  await fixture(
    "format.json",
    JSON.stringify({ databaseBudget: `JSON_MARKER_${short}_900` }),
    "JSON database budget?",
    `JSON_MARKER_${short}`,
  );
  await fixture(
    "format.yaml",
    `service:\n  owner: YAML_MARKER_${short}_platform\n`,
    "YAML service owner?",
    `YAML_MARKER_${short}`,
  );
  await fixture(
    "format.toml",
    `[database]\nengine = "TOML_MARKER_${short}_zvec"\n`,
    "TOML database engine?",
    `TOML_MARKER_${short}`,
  );
  await fixture(
    "format.csv",
    `item,budget\ndatabase,CSV_MARKER_${short}_900\n`,
    "CSV database budget?",
    `CSV_MARKER_${short}`,
  );
  await fixture(
    "format.html",
    `<h1>Architecture</h1><p>HTML_MARKER_${short} uses Zvec.</p>`,
    "HTML architecture database?",
    `HTML_MARKER_${short}`,
  );
  await fixture(
    "format.xml",
    `<?xml version="1.0"?><root><owner>XML_MARKER_${short}_infra</owner></root>`,
    "XML owner?",
    `XML_MARKER_${short}`,
  );
  await fixture(
    "format.ts",
    `export function TS_MARKER_${short}() { return "accounts"; }\n`,
    "TypeScript account symbol?",
    `TS_MARKER_${short}`,
  );
  await fixture(
    "format.go",
    `package formats\nfunc GO_MARKER_${short}() string { return "labels" }\n`,
    "Go label symbol?",
    `GO_MARKER_${short}`,
  );
  await fixture(
    "format.pdf",
    simplePdf(`PDF_MARKER_${short} database budget is 900`),
    "PDF database budget?",
    `PDF_MARKER_${short}`,
  );
  await fixture(
    "format.docx",
    zipSync({
      "word/document.xml": strToU8(
        `<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>DOCX_MARKER_${short} approval owner is Galvin</w:t></w:r></w:p></w:body></w:document>`,
      ),
    }),
    "DOCX approval owner?",
    `DOCX_MARKER_${short}`,
  );
  await fixture(
    "format.epub",
    zipSync({
      "chapter.xhtml": strToU8(
        `<html><body><h1>Chapter</h1><p>EPUB_MARKER_${short} retention is seven days.</p></body></html>`,
      ),
    }),
    "EPUB retention?",
    `EPUB_MARKER_${short}`,
  );
  await fixture(
    "format.xlsx",
    zipSync({
      "xl/sharedStrings.xml": strToU8(
        `<sst><si><t>database</t></si><si><t>XLSX_MARKER_${short}_900</t></si></sst>`,
      ),
      "xl/worksheets/sheet1.xml": strToU8(
        `<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row></sheetData></worksheet>`,
      ),
    }),
    "XLSX database budget?",
    `XLSX_MARKER_${short}`,
  );
  await fixture(
    "format.pptx",
    zipSync({
      "ppt/slides/slide1.xml": strToU8(`<p:sld xmlns:p="p" xmlns:a="a"><a:t>intro</a:t></p:sld>`),
      "ppt/slides/slide2.xml": strToU8(`<p:sld xmlns:p="p" xmlns:a="a"><a:t>details</a:t></p:sld>`),
      "ppt/slides/slide3.xml": strToU8(
        `<p:sld xmlns:p="p" xmlns:a="a"><a:t>PPTX_MARKER_${short} choose Zvec</a:t></p:sld>`,
      ),
    }),
    "PPTX slide 3 decision?",
    `PPTX_MARKER_${short}`,
  );
  const eml = `From: sender@example.com\nTo: receiver@example.com\nSubject: Format E2E\nMessage-ID: <EML_MARKER_${short}@example.com>\nContent-Type: multipart/mixed; boundary=x\n\n--x\nContent-Type: text/plain\n\nmail body\n--x\nContent-Disposition: attachment; filename="EML_MARKER_${short}.txt"\n\nattachment\n--x--\n`;
  await fixture("format.eml", eml, "EML Message-ID and attachment?", `EML_MARKER_${short}`);
  await fixture(
    "format.mbox",
    `From sender@example.com Wed Jul 29 00:00:00 2026\nSubject: MBOX_MARKER_${short}\nMessage-ID: <mbox-${short}@example.com>\n\nMBOX retention rule.\n`,
    "MBOX subject?",
    `MBOX_MARKER_${short}`,
  );
  await fixture(
    "format.zip",
    zipSync({ "rules.md": strToU8(`# ZIP rule\nZIP_MARKER_${short} archive owner is platform.`) }),
    "ZIP archive owner?",
    `ZIP_MARKER_${short}`,
  );
  await fixture(
    "openapi.yaml",
    `openapi: 3.1.0\npaths:\n  /accounts:\n    post:\n      description: OPENAPI_MARKER_${short}\n      requestBody:\n        fields: [email, label]\n`,
    "POST /accounts request fields?",
    `OPENAPI_MARKER_${short}`,
  );
  await fixture(
    "pi-extension.json",
    JSON.stringify({
      marker: `PI_EXTENSION_MARKER_${short}`,
      tools: ["mail_send"],
      commands: ["mail"],
    }),
    "Pi extension registered Tool and Command?",
    `PI_EXTENSION_MARKER_${short}`,
    "pi-package",
  );
  await fixture(
    "skill.md",
    `# Skill\n\nSKILL_MARKER_${short}\n\nUse for mail setup.\n\n1. Validate account.\n2. Send message.\n`,
    "Skill scenario and steps?",
    `SKILL_MARKER_${short}`,
    "skill",
  );
  await fixture(
    "mcp-schema.json",
    JSON.stringify({
      marker: `MCP_MARKER_${short}`,
      tools: [{ name: "mail_send", inputSchema: { required: ["to", "subject"] } }],
    }),
    "MCP tools and input schema?",
    `MCP_MARKER_${short}`,
    "mcp",
  );
  return entries;
}

async function loadInferenceModules() {
  const core = await import(pathToFileURL(path.join(root, "packages/core/dist/index.js")).href);
  const inference = await import(
    pathToFileURL(path.join(root, "packages/inference/dist/index.js")).href
  );
  const provider = await import(
    pathToFileURL(path.join(root, "packages/siliconflow-provider/dist/index.js")).href
  );
  const config = await core.loadConfig(directories.workspace);
  return { core, inference, provider, config };
}

function cosine(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

async function runInference() {
  const started = performance.now();
  const { inference, provider, config } = await loadInferenceModules();
  const embedding = new provider.SiliconFlowEmbeddingProvider(config.inference.siliconflow);
  const reranker = new provider.SiliconFlowRerankProvider(config.inference.siliconflow);
  const marker = `${runId}-inference`;
  const inputs = [
    `中文自然语言：${marker} 使用 Zvec 持久化知识。`,
    `English natural language: ${marker} stores durable knowledge in Zvec.`,
    `export const database = "${marker}-zvec";`,
    `package main\nfunc Database() string { return "${marker}-zvec" }`,
    `${marker} short query`,
    `${marker} ${"long document segment ".repeat(80)}`,
    `${marker} batch document alpha`,
    `${marker} batch document omega`,
  ];
  const embedded = await embedding.embed({
    inputs,
    inputKind: "document",
    dimensions,
    truncate: "reject",
  });
  assert(embedded.vectors.length === 8, "Real Embedding batch did not preserve item count");
  for (const vector of embedded.vectors) {
    assert(vector.values.length === dimensions, "Embedding dimension mismatch");
    assert(vector.values.every(Number.isFinite), "Embedding contained NaN or Infinity");
    assert(
      vector.values.some((value) => value !== 0),
      "Embedding was all zeros",
    );
  }
  const smoke = await embedding.embed({
    inputs: ["项目数据库必须使用 Zvec", "该系统要求采用 Zvec 作为持久化数据库", "今天北京天气很好"],
    inputKind: "query",
    dimensions,
  });
  const related = cosine(smoke.vectors[0].values, smoke.vectors[1].values);
  const unrelated = cosine(smoke.vectors[0].values, smoke.vectors[2].values);
  assert(related > unrelated, `Embedding smoke similarity failed: ${related} <= ${unrelated}`);
  const candidates = [
    { id: "zvec-primary", text: "Pi Mentis 使用 Zvec 保存知识和长期记忆。" },
    { id: "sqlite", text: "SQLite 是一种常见的关系数据库。" },
    { id: "mail", text: "邮件系统可以支持 IMAP 和 SMTP。" },
    { id: "zvec-vector", text: "Zvec 支持向量检索和结构化过滤。" },
    { id: "weather", text: "今天的天气适合散步。" },
  ];
  const ranked = await reranker.rerank({
    query: "Pi Mentis 使用什么数据库保存知识和记忆？",
    documents: candidates,
    topN: candidates.length,
  });
  assert(ranked.items.length === candidates.length, "Rerank result count mismatch");
  assert(
    new Set(ranked.items.map((item) => item.originalIndex)).size === candidates.length,
    "Duplicate Rerank index",
  );
  assert(
    ranked.items.every((item) => Number.isFinite(item.relevanceScore)),
    "Invalid Rerank score",
  );
  assert(
    ranked.items.slice(0, 2).some((item) => item.documentId === "zvec-primary"),
    "Relevant Zvec document was not near the top",
  );
  const aborted = new globalThis.AbortController();
  aborted.abort(new Error("live-e2e-aborted"));
  await embedding
    .embed(
      { inputs: [`${marker}-abort`], inputKind: "query", dimensions },
      { signal: aborted.signal },
    )
    .then(
      () => {
        throw new Error("Pre-aborted Embedding request unexpectedly succeeded");
      },
      () => undefined,
    );
  const capability = inference.getVerifiedEmbeddingModel(embeddingModel.value);
  const unsupported = [768, 1024, 4096].find(
    (candidate) => !capability.supportedDimensions.includes(candidate),
  );
  if (unsupported !== undefined) {
    let rejected = false;
    try {
      await embedding.embed({
        inputs: [`${marker}-unsupported-dimension`],
        inputKind: "query",
        dimensions: unsupported,
      });
    } catch {
      rejected = true;
    }
    assert(rejected, `Unsupported Embedding dimension ${unsupported} was not rejected`);
  }
  scenario("I1 real Embedding and Rerank", started, {
    embeddingBatchInputs: embedded.vectors.length,
    similarityRelated: related,
    similarityUnrelated: unrelated,
    rerankTop: ranked.items[0]?.documentId,
    embeddingTrace: embedded.traceId ?? null,
    rerankTrace: ranked.traceId ?? null,
    supportedDimensions: capability.supportedDimensions,
  });
  if (capability.supportedDimensions.length < 3) {
    report.scenarios.push({
      name: "D1/G1 multi-dimension Zvec generation migration",
      status: "BLOCKED",
      reason: `${embeddingModel.value} exposes only ${capability.supportedDimensions.join(", ")} dimensions; the configured model was not replaced`,
    });
  }
}

async function readKnowledgeGeneration() {
  const manifest = JSON.parse(
    await readFile(path.join(directories.zvec, "active-index-manifest.json"), "utf8"),
  );
  const generation = manifest.generations?.find(
    (candidate) => candidate.generationId === manifest.knowledgeGeneration,
  );
  assert(generation !== undefined, "Active knowledge generation is missing from the manifest");
  return { manifest, generation };
}

async function runEmbeddingMigration() {
  const started = performance.now();
  const { inference } = await loadInferenceModules();
  const capability = inference.getVerifiedEmbeddingModel(embeddingModel.value);
  const targets = capability.supportedDimensions.filter(
    (candidate) => candidate >= 768 && candidate <= 4_096 && candidate !== dimensions,
  );
  assert(
    targets.length >= 2,
    `Embedding migration E2E requires two alternate production dimensions; ${embeddingModel.value} exposes ${capability.supportedDimensions.join(", ")}`,
  );
  const firstTarget = targets[0];
  const secondTarget = targets[1];
  assert(firstTarget !== undefined && secondTarget !== undefined, "Migration targets are missing");
  const namespace = `migration:${runId}`;
  const marker = `MIGRATION_MARKER_${runId}`;
  const initial = await runPi("@galvinsan/pi-mentis-knowledge", [
    {
      kind: "tool",
      name: "commit_knowledge",
      parameters: {
        kind: "text",
        value: `${marker}: Zvec generation migration must preserve searchable knowledge.`,
        namespace,
      },
      waitForKnowledgeJob: true,
    },
    {
      kind: "tool",
      name: "search_knowledge",
      parameters: { query: `Find ${marker}`, namespace, limit: 10 },
    },
  ]);
  assert(
    searchPayload(initial.results[1]).hits?.some((hit) => hit.text.includes(marker)),
    "Initial generation could not retrieve the migration marker",
  );
  const initialState = await readKnowledgeGeneration();
  assert(
    initialState.generation.embeddingSpace.dimensions === dimensions,
    "Initial generation dimension does not match the configured model",
  );

  const firstMigration = await runPi("@galvinsan/pi-mentis-knowledge", [
    {
      kind: "command",
      name: "kb",
      arguments: `migrate-embedding ${firstTarget}`,
      waitForKnowledgeJob: true,
    },
  ]);
  const firstJob = firstMigration.results[0].job;
  assert(
    firstJob?.result?.activated === true && firstJob.result.migrated >= 1,
    "First embedding migration did not activate a complete generation",
  );
  const firstState = await readKnowledgeGeneration();
  assert(
    firstState.generation.embeddingSpace.dimensions === firstTarget,
    "First migrated generation has the wrong dimension",
  );
  assert(
    firstState.manifest.generations.find(
      (candidate) => candidate.generationId === initialState.generation.generationId,
    )?.state === "superseded",
    "Initial generation was not superseded after migration",
  );

  const secondMigration = await runPi(
    "@galvinsan/pi-mentis-knowledge",
    [
      {
        kind: "tool",
        name: "search_knowledge",
        parameters: { query: `Find ${marker}`, namespace, limit: 10 },
      },
      {
        kind: "command",
        name: "kb",
        arguments: `migrate-embedding ${secondTarget}`,
        waitForKnowledgeJob: true,
      },
    ],
    { environment: { SILICONFLOW_EMBEDDING_DIMENSIONS: String(firstTarget) } },
  );
  assert(
    searchPayload(secondMigration.results[0]).hits?.some((hit) => hit.text.includes(marker)),
    "Restarted first migrated generation could not retrieve the marker",
  );
  const secondJob = secondMigration.results[1].job;
  assert(
    secondJob?.result?.activated === true && secondJob.result.migrated >= 1,
    "Second embedding migration did not activate a complete generation",
  );
  const secondState = await readKnowledgeGeneration();
  assert(
    secondState.generation.embeddingSpace.dimensions === secondTarget,
    "Second migrated generation has the wrong dimension",
  );

  const rollback = await runPi(
    "@galvinsan/pi-mentis-knowledge",
    [
      {
        kind: "tool",
        name: "search_knowledge",
        parameters: { query: `Find ${marker}`, namespace, limit: 10 },
      },
      {
        kind: "command",
        name: "kb",
        arguments: `rollback-embedding ${initialState.generation.generationId}`,
      },
    ],
    { environment: { SILICONFLOW_EMBEDDING_DIMENSIONS: String(secondTarget) } },
  );
  assert(
    searchPayload(rollback.results[0]).hits?.some((hit) => hit.text.includes(marker)),
    "Restarted second migrated generation could not retrieve the marker",
  );
  const rolledBackState = await readKnowledgeGeneration();
  assert(
    rolledBackState.generation.generationId === initialState.generation.generationId &&
      rolledBackState.generation.embeddingSpace.dimensions === dimensions,
    "Rollback did not reactivate the initial generation",
  );
  const finalRecall = await runPi(
    "@galvinsan/pi-mentis-knowledge",
    [
      {
        kind: "tool",
        name: "search_knowledge",
        parameters: { query: `Find ${marker}`, namespace, limit: 10 },
      },
    ],
    { environment: { SILICONFLOW_EMBEDDING_DIMENSIONS: String(dimensions) } },
  );
  assert(
    searchPayload(finalRecall.results[0]).hits?.some((hit) => hit.text.includes(marker)),
    "Rolled-back generation could not retrieve the marker after process restart",
  );
  report.restarts.push(
    {
      beforeProcessId: initial.processId,
      afterProcessId: firstMigration.processId,
      recalled: false,
    },
    {
      beforeProcessId: firstMigration.processId,
      afterProcessId: secondMigration.processId,
      recalled: true,
    },
    {
      beforeProcessId: secondMigration.processId,
      afterProcessId: rollback.processId,
      recalled: true,
    },
    {
      beforeProcessId: rollback.processId,
      afterProcessId: finalRecall.processId,
      recalled: true,
    },
  );
  scenario("D1/G1 real multi-dimension Zvec generation migration and rollback", started, {
    model: embeddingModel.value,
    dimensions: [dimensions, firstTarget, secondTarget, dimensions],
    generations: [
      initialState.generation.generationId,
      firstState.generation.generationId,
      secondState.generation.generationId,
      rolledBackState.generation.generationId,
    ],
    migratedRecords: [firstJob.result.migrated, secondJob.result.migrated],
    processRestarts: 4,
    rollbackRecall: true,
  });
}

async function runPiSurfaces() {
  const started = performance.now();
  const modes = [
    ["@galvinsan/pi-mentis-knowledge", ["commit_knowledge", "search_knowledge"], ["kb"]],
    ["@galvinsan/pi-mentis-memory", ["commit_memory", "search_memory"], []],
    ["@galvinsan/pi-mentis", ["commit_memory", "search_memory"], ["kb"]],
  ];
  for (const [packageName, expectedTools, expectedCommands] of modes) {
    const response = await runPi(packageName, []);
    assert(
      JSON.stringify(response.toolSurface) === JSON.stringify(expectedTools),
      `${packageName} tool surface mismatch: ${response.toolSurface.join(",")}`,
    );
    for (const command of expectedCommands) {
      assert(response.commandSurface.includes(command), `${packageName} missing /${command}`);
    }
    report.tools[packageName] = {
      tools: response.toolSurface,
      commands: response.commandSurface,
      extensionPath: response.extensionPath,
    };
  }
  scenario("P1 packed Pi v0.83.0 extension surfaces", started);
}

async function runMemory() {
  const started = performance.now();
  const projectScope = `project:e2e:${runId}`;
  const response = await runPi("@galvinsan/pi-mentis-memory", [
    {
      kind: "tool",
      name: "commit_memory",
      parameters: {
        content: `在项目 ${runId} 中，用户明确要求所有包统一使用 pnpm，禁止使用 npm 和 yarn。`,
        type: "requirement",
        scopeKind: "project",
        scopeId: projectScope,
      },
    },
    {
      kind: "tool",
      name: "search_memory",
      parameters: {
        query: "安装依赖时应该选择什么工具？",
        scopeKind: "project",
        scopeId: projectScope,
      },
    },
    {
      kind: "tool",
      name: "commit_memory",
      parameters: {
        content: `项目 ${runId} 的依赖管理必须使用 pnpm，不得改用 npm 或 yarn。`,
        type: "requirement",
        scopeKind: "project",
        scopeId: projectScope,
      },
    },
    {
      kind: "tool",
      name: "commit_memory",
      parameters: {
        content: `项目 ${runId} 的默认 Embedding 维度是 768。`,
        type: "fact",
        scopeKind: "project",
        scopeId: projectScope,
      },
    },
  ]);
  assert(
    JSON.stringify(response.toolSurface) === JSON.stringify(["commit_memory", "search_memory"]),
    "Memory-only tool surface mismatch",
  );
  const firstCommit = toolPayload(response.results[0]);
  const semanticSearch = searchPayload(response.results[1]);
  const reinforcement = toolPayload(response.results[2]);
  const oldDimension = toolPayload(response.results[3]);
  assert(firstCommit.outcome === "created", `Memory commit outcome was ${firstCommit.outcome}`);
  assert(
    semanticSearch.hits?.some(
      (hit) =>
        hit.text.includes(runId) &&
        hit.text.includes("pnpm") &&
        hit.metadata?.scope?.kind === "project" &&
        hit.metadata?.scope?.id === projectScope,
    ),
    "Semantic memory search did not return the scoped pnpm rule",
  );
  assert(
    reinforcement.outcome === "reinforced" && reinforcement.record.reinforceCount >= 1,
    `Memory duplicate was not reinforced: ${reinforcement.outcome}`,
  );
  const correction = await runPi("@galvinsan/pi-mentis-memory", [
    {
      kind: "tool",
      name: "commit_memory",
      parameters: {
        content: `项目 ${runId} 的默认 Embedding 维度已经调整为 1024，旧的 768 配置不再使用。`,
        type: "fact",
        scopeKind: "project",
        scopeId: projectScope,
        supersedesIds: [oldDimension.record.id],
      },
    },
    {
      kind: "tool",
      name: "search_memory",
      parameters: {
        query: `项目 ${runId} 当前默认 Embedding 维度是多少？`,
        scopeKind: "project",
        scopeId: projectScope,
      },
    },
  ]);
  const corrected = toolPayload(correction.results[0]);
  const correctedSearch = searchPayload(correction.results[1]);
  assert(corrected.outcome === "superseded", `Correction outcome was ${corrected.outcome}`);
  assert(correctedSearch.hits?.[0]?.text.includes("1024"), "Corrected 1024 memory was not active");
  scenario("M1-M4 real memory commit, semantic search, reinforcement, correction", started, {
    recordId: firstCommit.record.id,
    reinforceCount: reinforcement.record.reinforceCount,
    supersededId: oldDimension.record.id,
  });

  const isolationStarted = performance.now();
  const scopes = {
    projectA: `project:e2e:${runId}:A`,
    projectB: `project:e2e:${runId}:B`,
    session: `session:e2e:${runId}:isolated`,
    branch: `branch:e2e:${runId}:isolated`,
  };
  const isolation = await runPi("@galvinsan/pi-mentis-memory", [
    {
      kind: "tool",
      name: "commit_memory",
      parameters: {
        content: `隔离标记 ${runId}：Project A 的向量维度策略是 1024。`,
        type: "fact",
        scopeKind: "project",
        scopeId: scopes.projectA,
      },
    },
    {
      kind: "tool",
      name: "commit_memory",
      parameters: {
        content: `隔离标记 ${runId}：Project B 的向量维度策略是 4096。`,
        type: "fact",
        scopeKind: "project",
        scopeId: scopes.projectB,
      },
    },
    {
      kind: "tool",
      name: "commit_memory",
      parameters: {
        content: `隔离标记 ${runId}：Session-only secret is SESSION-GREEN.`,
        type: "episodic",
        scopeKind: "session",
        scopeId: scopes.session,
      },
    },
    {
      kind: "tool",
      name: "commit_memory",
      parameters: {
        content: `隔离标记 ${runId}：Branch-only secret is BRANCH-BLUE.`,
        type: "episodic",
        scopeKind: "branch",
        scopeId: scopes.branch,
      },
    },
    {
      kind: "tool",
      name: "search_memory",
      parameters: {
        query: `Project A ${runId} 的向量维度策略`,
        scopeKind: "project",
        scopeId: scopes.projectA,
        limit: 20,
      },
    },
    {
      kind: "tool",
      name: "search_memory",
      parameters: {
        query: `Project B ${runId} 的向量维度策略`,
        scopeKind: "project",
        scopeId: scopes.projectB,
        limit: 20,
      },
    },
    {
      kind: "tool",
      name: "search_memory",
      parameters: {
        query: `Session-only ${runId}`,
        scopeKind: "project",
        scopeId: scopes.projectA,
        limit: 20,
      },
    },
    {
      kind: "tool",
      name: "search_memory",
      parameters: {
        query: `Session-only ${runId}`,
        scopeKind: "session",
        scopeId: scopes.session,
        limit: 20,
      },
    },
    {
      kind: "tool",
      name: "search_memory",
      parameters: {
        query: `Branch-only ${runId}`,
        scopeKind: "branch",
        scopeId: scopes.branch,
        limit: 20,
      },
    },
    {
      kind: "tool",
      name: "search_memory",
      parameters: {
        query: `隔离标记 ${runId} 的 Project A 和 Project B 向量维度策略`,
        limit: 100,
      },
    },
  ]);
  const projectA = searchPayload(isolation.results[4]);
  const projectB = searchPayload(isolation.results[5]);
  const projectLeakProbe = searchPayload(isolation.results[6]);
  const sessionSearch = searchPayload(isolation.results[7]);
  const branchSearch = searchPayload(isolation.results[8]);
  const contextualSearch = searchPayload(isolation.results[9]);
  assert(
    projectA.hits?.some((hit) => hit.text.includes("Project A") && hit.text.includes("1024")) &&
      !projectA.hits?.some((hit) => hit.text.includes("Project B") || hit.text.includes("4096")),
    "Project A scope leaked Project B memory",
  );
  assert(
    projectB.hits?.some((hit) => hit.text.includes("Project B") && hit.text.includes("4096")) &&
      !projectB.hits?.some((hit) => hit.text.includes("Project A") || hit.text.includes("1024")),
    "Project B scope leaked Project A memory",
  );
  assert(
    !projectLeakProbe.hits?.some((hit) => hit.text.includes("SESSION-GREEN")),
    "Session memory leaked into a project scope",
  );
  assert(
    sessionSearch.hits?.some((hit) => hit.text.includes("SESSION-GREEN")),
    "Session-scoped memory was not searchable in its own scope",
  );
  assert(
    branchSearch.hits?.some((hit) => hit.text.includes("BRANCH-BLUE")),
    "Branch-scoped memory was not searchable in its own scope",
  );
  assert(
    !contextualSearch.hits?.some((hit) =>
      ["Project A", "Project B", "SESSION-GREEN", "BRANCH-BLUE"].some((marker) =>
        hit.text.includes(marker),
      ),
    ),
    "Default contextual search leaked explicitly scoped memory",
  );
  scenario("M5 project, session, branch, and default contextual scope behavior", isolationStarted, {
    scopes,
    contextualNamespaces: [...new Set(contextualSearch.hits.map((hit) => hit.namespace))],
  });
}

async function runRestart() {
  const started = performance.now();
  const scopeId = `project:e2e:${runId}:restart`;
  const first = await runPi("@galvinsan/pi-mentis-memory", [
    {
      kind: "tool",
      name: "commit_memory",
      parameters: {
        content: `重启持久化标记 ${runId}：这个项目必须使用 pnpm。`,
        type: "requirement",
        scopeKind: "project",
        scopeId,
      },
    },
  ]);
  const firstPid = first.processId;
  const second = await runPi("@galvinsan/pi-mentis-memory", [
    {
      kind: "tool",
      name: "search_memory",
      parameters: {
        query: "这个项目使用什么包管理器？",
        scopeKind: "project",
        scopeId,
      },
    },
  ]);
  assert(firstPid !== second.processId, "Restart test reused the same process");
  const search = searchPayload(second.results[0]);
  assert(
    search.hits?.some((hit) => hit.text.includes(runId) && hit.text.includes("pnpm")),
    "Restarted process could not recall the persisted memory",
  );
  report.restarts.push({
    beforeProcessId: firstPid,
    afterProcessId: second.processId,
    recalled: true,
  });
  scenario("M6/Z4 complete process restart persistence", started, {
    beforeProcessId: firstPid,
    afterProcessId: second.processId,
  });
}

async function runKnowledge() {
  const basicStarted = performance.now();
  const namespace = `e2e:${runId}`;
  const markdownPath = path.join(directories.fixtures, "mail-extension.md");
  const directoryPath = path.join(directories.fixtures, "mail-directory");
  await mkdir(path.join(directoryPath, "src"), { recursive: true });
  await Promise.all([
    writeFile(
      path.join(directoryPath, "README.md"),
      `# Mail directory ${runId}\n\nThe mail extension loads account implementations from src/accounts.ts.\n`,
    ),
    writeFile(
      path.join(directoryPath, "src", "accounts.ts"),
      `export const directoryMarker = "${runId}";\nexport function selectMailAccount(defaultAccount: string) { return defaultAccount || "gmail"; }\n`,
    ),
    writeFile(
      path.join(directoryPath, "src", "labels.ts"),
      `export const labelPattern = /^[a-zA-Z0-9._-]+$/;\n`,
    ),
    writeFile(
      path.join(directoryPath, "openapi.yaml"),
      `openapi: 3.1.0\ninfo:\n  title: Mail Directory ${runId}\n  version: 1.0.0\npaths: {}\n`,
    ),
    writeFile(
      path.join(directoryPath, "config.example.json"),
      `${JSON.stringify({ marker: runId, provider: "gmail" }, null, 2)}\n`,
    ),
  ]);
  await writeFile(
    markdownPath,
    `# 邮件扩展规范\n\n## 账户\n\n系统必须支持 Gmail、QQ 邮箱和新浪邮箱。\n\n## 默认账户\n\n默认账户由 \`default_account\` 文件决定。\n\n## 标签规则\n\n标签名称必须匹配 \`[a-zA-Z0-9._-]+\`。\n\n## 附件\n\n必须支持附件列表和下载。\n`,
  );
  const text = `Pi Mentis E2E 规范 ${runId}：\n\n本项目的唯一持久化数据库是 Zvec。禁止使用 SQLite。\n\n知识搜索必须先执行混合检索，再进行重排序。\n\n${Array.from({ length: 8 }, (_, index) => `验证段落 ${index + 1}：${runId} 的 Zvec 规则是当前权威规范。`).join("\n\n")}`;
  const response = await runPi("@galvinsan/pi-mentis-knowledge", [
    {
      kind: "tool",
      name: "commit_knowledge",
      parameters: { kind: "text", value: text, namespace },
      waitForKnowledgeJob: true,
    },
    {
      kind: "tool",
      name: "search_knowledge",
      parameters: { query: `项目 ${runId} 允许使用 SQLite 吗？`, namespace, limit: 10 },
    },
    {
      kind: "tool",
      name: "commit_knowledge",
      parameters: { kind: "file", value: markdownPath, namespace },
      waitForKnowledgeJob: true,
    },
    {
      kind: "tool",
      name: "search_knowledge",
      parameters: { query: "邮件扩展的标签名称有什么限制？", namespace, limit: 10 },
    },
    {
      kind: "tool",
      name: "search_knowledge",
      parameters: { query: "默认邮箱账户从哪里读取？", namespace, limit: 10 },
    },
  ]);
  assert(
    JSON.stringify(response.toolSurface) ===
      JSON.stringify(["commit_knowledge", "search_knowledge"]),
    "Knowledge-only tool surface mismatch",
  );
  const textSearch = searchPayload(response.results[1]);
  const labelSearch = searchPayload(response.results[3]);
  const accountSearch = searchPayload(response.results[4]);
  assert(
    textSearch.hits?.some((hit) => hit.text.includes(runId) && hit.text.includes("SQLite")),
    "Knowledge text search did not return the current run's SQLite prohibition",
  );
  assert(
    textSearch.hits?.some((hit) => hit.metadata?.sourceId && hit.metadata?.documentId),
    "Knowledge result omitted Source or Document identity",
  );
  assert(
    labelSearch.hits?.some((hit) => hit.text.includes("[a-zA-Z0-9._-]+")),
    "Markdown label rule was not retrieved",
  );
  assert(
    accountSearch.hits?.some((hit) => hit.text.includes("default_account")),
    "Markdown default_account rule was not retrieved",
  );
  scenario("K1-K2 real text and Markdown knowledge", basicStarted, {
    textJob: response.results[0].job,
    markdownJob: response.results[2].job,
  });

  const directoryStarted = performance.now();
  const directory = await runPi("@galvinsan/pi-mentis-knowledge", [
    {
      kind: "tool",
      name: "commit_knowledge",
      parameters: { kind: "directory", value: directoryPath, namespace },
      waitForKnowledgeJob: true,
    },
    {
      kind: "tool",
      name: "search_knowledge",
      parameters: {
        query: `邮件账户选择逻辑在哪个代码文件？ selectMailAccount ${runId}`,
        namespace,
        limit: 20,
      },
    },
  ]);
  const directorySearch = searchPayload(directory.results[1]);
  const accountHit = directorySearch.hits?.find(
    (hit) =>
      hit.text.includes("selectMailAccount") &&
      String(hit.metadata?.canonicalUri ?? "").endsWith("/src/accounts.ts") &&
      hit.metadata?.symbol?.name === "selectMailAccount" &&
      Number(hit.metadata?.location?.lineStart) >= 1,
  );
  assert(accountHit !== undefined, "Directory retrieval omitted the exact src/accounts.ts path");
  assert(
    directory.results[0].job?.result?.documentIds?.length >= 5,
    "Directory ingestion did not index every supported fixture file",
  );
  scenario("K3 recursive directory ingestion with source path and symbol", directoryStarted, {
    job: directory.results[0].job,
    canonicalUri: accountHit.metadata.canonicalUri,
    symbol: accountHit.metadata.symbol ?? null,
    location: accountHit.metadata.location,
  });

  const incrementalStarted = performance.now();
  await writeFile(
    markdownPath,
    `# 邮件扩展规范\n\n## 账户\n\n系统必须支持 Gmail、QQ 邮箱、新浪邮箱和 Outlook。\n\n## 默认账户\n\n默认账户由 \`default_account\` 文件决定。\n\n## 标签规则\n\n标签名称必须匹配 \`[a-zA-Z0-9._-]+\`。\n\n## 附件\n\n必须支持附件列表和下载。\n`,
  );
  const incremental = await runPi("@galvinsan/pi-mentis-knowledge", [
    {
      kind: "tool",
      name: "commit_knowledge",
      parameters: { kind: "file", value: markdownPath, namespace },
      waitForKnowledgeJob: true,
    },
    {
      kind: "tool",
      name: "search_knowledge",
      parameters: { query: "邮件扩展是否支持 Outlook？", namespace, limit: 20 },
    },
    {
      kind: "tool",
      name: "commit_knowledge",
      parameters: { kind: "directory", value: directoryPath, namespace },
      waitForKnowledgeJob: true,
    },
  ]);
  const incrementalSearch = searchPayload(incremental.results[1]);
  const outlookHit = incrementalSearch.hits?.find((hit) => hit.text.includes("Outlook"));
  assert(outlookHit !== undefined, "Changed Markdown content was not retrieved after restart");
  assert(
    Number(outlookHit.metadata?.revision) >= 2,
    `Changed Markdown revision was ${String(outlookHit.metadata?.revision)}`,
  );
  assert(
    incremental.results[2].job?.result?.unchanged >= 5,
    "Unchanged directory documents were unexpectedly re-indexed",
  );
  scenario("K4 incremental update and unchanged-document reuse", incrementalStarted, {
    changedJob: incremental.results[0].job,
    activeRevision: outlookHit.metadata.revision,
    unchangedDocuments: incremental.results[2].job.result.unchanged,
  });

  const deleteStarted = performance.now();
  const markdownSourceId = response.results[2].job?.result?.sourceIds?.[0];
  assert(typeof markdownSourceId === "string", "Markdown ingest returned no source ID");
  const removed = await runPi("@galvinsan/pi-mentis-knowledge", [
    { kind: "command", name: "kb", arguments: `remove ${markdownSourceId}` },
    {
      kind: "tool",
      name: "search_knowledge",
      parameters: { query: "默认邮箱账户从哪里读取 default_account？", namespace, limit: 20 },
    },
    {
      kind: "tool",
      name: "search_knowledge",
      parameters: {
        query: `邮件账户选择逻辑 selectMailAccount ${runId}`,
        namespace,
        limit: 20,
      },
    },
  ]);
  const removalNotice = JSON.stringify(removed.results[0].notifications);
  const deletedSearch = searchPayload(removed.results[1]);
  const survivingSearch = searchPayload(removed.results[2]);
  assert(/Removed [1-9]\d* chunks/.test(removalNotice), "Knowledge delete removed no chunks");
  assert(
    !deletedSearch.hits?.some((hit) => hit.metadata?.sourceId === markdownSourceId),
    "Deleted source remained searchable",
  );
  assert(
    survivingSearch.hits?.some((hit) => hit.text.includes("selectMailAccount")),
    "Deleting one source damaged unrelated directory knowledge",
  );
  scenario("K5 source deletion preserves unrelated knowledge", deleteStarted, {
    sourceId: markdownSourceId,
    notification: removed.results[0].notifications,
  });
}

async function runCombined() {
  const started = performance.now();
  const namespace = `e2e:${runId}`;
  const authorityPath = path.join(directories.fixtures, "combined-authority.md");
  const rerankPath = path.join(directories.fixtures, "combined-rerank.md");
  await writeFile(
    authorityPath,
    `# 当前存储规范 ${runId}\n\n知识库和记忆系统的唯一数据库是 Zvec。SQLite 被明确禁止。当前默认 Embedding 维度为 ${dimensions}。\n\n# 当前 Pi 版本\n\n当前项目使用 Pi v0.83.0，这是本次运行的权威版本。\n\n# Pi Extension 能力\n\nPi Extension 支持注册 Tool、Command 和生命周期监听。邮件系统可以通过 Extension 集成本地配置，也可以通过 MCP 提供远程服务。\n\n# 邮件标签规则\n\n标签名称必须匹配 [a-zA-Z0-9._-]+。\n`,
  );
  const rerankSections = [
    ...Array.from({ length: 3 }, (_, index) => ({
      heading: `Highly Relevant ${index + 1}`,
      body: `Pi Mentis ${runId} combines dense Zvec vectors, exact terms, full text retrieval, SiliconFlow reranking, and MMR. The definitive answer is that real rerank scores must replace the RRF candidate order before diversity selection.`,
    })),
    ...Array.from({ length: 5 }, (_, index) => ({
      heading: `Partially Relevant ${index + 1}`,
      body: `Vector search candidate ${runId} discusses retrieval ranking and persistent indexes, but only partially explains the final ordering pipeline.`,
    })),
    ...Array.from({ length: 16 }, (_, index) => ({
      heading: `Unrelated Domain ${index + 1}`,
      body: `Unrelated archive ${runId} section ${index + 1} covers weather, recipes, calendar colors, office chairs, travel, and generic email formatting.`,
    })),
  ];
  await writeFile(
    rerankPath,
    `${rerankSections
      .map(
        ({ heading, body }) =>
          `# ${heading}\n\n${body} ${"Independent evidence paragraph used to preserve a distinct candidate chunk. ".repeat(5)}`,
      )
      .join("\n\n")}\n`,
  );
  const response = await runPi("@galvinsan/pi-mentis", [
    {
      kind: "command",
      name: "kb",
      arguments: `add ${authorityPath}`,
      waitForKnowledgeJob: true,
    },
    {
      kind: "tool",
      name: "commit_memory",
      parameters: {
        content: `历史背景 ${runId}：早期讨论中曾考虑使用 SQLite 保存部分元数据。`,
        type: "episodic",
      },
    },
    {
      kind: "tool",
      name: "commit_memory",
      parameters: {
        content: `用户要求 ${runId} 邮件系统支持 Gmail、QQ 和新浪邮箱，并通过 default_account 设置默认账户。`,
        type: "requirement",
      },
    },
    {
      kind: "tool",
      name: "commit_memory",
      parameters: {
        content: `项目 ${runId} 使用 Pi v0.81.0。`,
        type: "episodic",
      },
    },
    {
      kind: "tool",
      name: "search_memory",
      parameters: {
        query: `当前项目 ${runId} 使用哪个 Pi 版本？`,
        namespace,
        limit: 20,
      },
    },
    {
      kind: "tool",
      name: "search_memory",
      parameters: {
        query: `再次确认当前项目 ${runId} 的 Pi 版本`,
        namespace,
        limit: 20,
      },
    },
    {
      kind: "tool",
      name: "search_memory",
      parameters: {
        query: `这个项目 ${runId} 现在使用什么数据库？SQLite 还能使用吗？`,
        namespace,
        limit: 20,
      },
    },
    {
      kind: "tool",
      name: "search_memory",
      parameters: {
        query: `按照我的要求应该怎样用 Pi Extension 和 MCP 实现邮件系统 ${runId}，并配置 default_account？`,
        namespace,
        limit: 20,
      },
    },
    {
      kind: "command",
      name: "kb",
      arguments: `add ${rerankPath}`,
      waitForKnowledgeJob: true,
    },
    {
      kind: "tool",
      name: "search_memory",
      parameters: {
        query: `Pi Mentis ${runId} 的真实检索排序流水线如何应用 Rerank 和 MMR？`,
        namespace,
        limit: 20,
      },
    },
    {
      kind: "before_agent_start",
      prompt: `继续实现我们之前讨论的邮件扩展 ${runId}，并遵守账户和标签规则。`,
    },
    { kind: "before_agent_start", prompt: "你好" },
  ]);
  const version = searchPayload(response.results[4]);
  const versionAfterVerification = searchPayload(response.results[5]);
  const storage = searchPayload(response.results[6]);
  const mail = searchPayload(response.results[7]);
  const rerankJob = response.results[8].job;
  const reranked = searchPayload(response.results[9]);
  assert(
    storage.hits?.some((hit) => hit.kind === "knowledge" && hit.text.includes("Zvec")),
    "Combined search missed authoritative Zvec knowledge",
  );
  assert(
    storage.hits?.some((hit) => hit.kind === "memory" && hit.text.includes("SQLite")),
    "Combined search missed historical SQLite memory",
  );
  assert(
    mail.hits?.some((hit) => hit.kind === "knowledge" && /extension/i.test(hit.text)) &&
      mail.hits?.some((hit) => hit.kind === "memory" && hit.text.includes("default_account")),
    "Combined mail search did not include both knowledge and memory",
  );
  assert(
    response.results[10].result?.messages?.some((message) =>
      message.content?.includes("pi-mentis-evidence"),
    ),
    "Substantive Pi lifecycle prompt did not inject automatic recall",
  );
  assert(
    response.results[11].result === undefined,
    "Greeting unexpectedly triggered automatic recall",
  );
  scenario("C1-C2/C5 knowledge-first combined retrieval and Pi auto recall", started, {
    knowledgeStageMs: storage.diagnostics?.stages?.knowledge,
    memoryStageMs: storage.diagnostics?.stages?.memory,
    traceOrder: storage.diagnostics?.traceOrder,
    autoRecallInjected: true,
    greetingSkipped: true,
  });

  const authoritativeVersion = version.hits?.find(
    (hit) => hit.kind === "knowledge" && hit.text.includes("0.83.0"),
  );
  const historicalVersion = version.hits?.find(
    (hit) => hit.kind === "memory" && hit.text.includes("0.81.0"),
  );
  assert(authoritativeVersion !== undefined, "Current Pi 0.83.0 knowledge was not retrieved");
  assert(
    historicalVersion?.metadata?.status === "conflicted" &&
      historicalVersion.metadata.conflictsWithIds?.includes(authoritativeVersion.id),
    "Old Pi 0.81.0 memory was not persistently linked to conflicting knowledge",
  );
  assert(
    !versionAfterVerification.hits?.some(
      (hit) => hit.kind === "memory" && hit.text.includes("0.81.0"),
    ),
    "Conflicted Pi 0.81.0 memory remained active in the next default search",
  );
  assert(
    version.diagnostics?.traceOrder?.includes("knowledge-verification"),
    "Knowledge verification stage was not recorded",
  );
  scenario("C3 authoritative knowledge conflicts and retires old memory", started, {
    knowledgeId: authoritativeVersion.id,
    memoryId: historicalVersion.id,
    memoryStatus: historicalVersion.metadata.status,
    retainedEvidenceRefs: historicalVersion.metadata.evidenceRefs,
    traceOrder: version.diagnostics.traceOrder,
  });

  const rankings = reranked.diagnostics?.rankings;
  assert(rerankJob?.result?.chunkCount >= 20, "C4 fixture produced fewer than 20 chunks");
  assert(rankings?.rrf?.length >= 20, "RRF exposed fewer than 20 real candidates");
  assert(
    JSON.stringify(rankings.rrf) !== JSON.stringify(rankings.rerank),
    "Real Rerank request did not change the RRF candidate order",
  );
  assert(
    reranked.diagnostics?.traceOrder?.indexOf("rerank") <
      reranked.diagnostics?.traceOrder?.indexOf("mmr"),
    "MMR did not execute after Rerank",
  );
  assert(
    new Set(
      reranked.hits
        ?.map((hit) => hit.metadata?.headingPath?.[0])
        .filter((heading) => typeof heading === "string"),
    ).size >= 2,
    "MMR final results did not retain diverse document sections",
  );
  scenario("C4 real Rerank changes RRF order before MMR", started, {
    candidateChunks: rerankJob.result.chunkCount,
    rrf: rankings.rrf,
    rerank: rankings.rerank,
    mmr: rankings.mmr,
    traceOrder: reranked.diagnostics.traceOrder,
  });
}

async function runPerformance() {
  const started = performance.now();
  const { inference, provider, config } = await loadInferenceModules();
  const reranker = new provider.SiliconFlowRerankProvider(config.inference.siliconflow);
  const estimator = new inference.ConservativeUtf8TokenEstimator();
  const budgetPlan = inference.createRerankBudget(`性能测试 ${runId}`, undefined, estimator, {
    modelContextTokens: rerankMaxInputTokens,
  });
  const documents = Array.from({ length: 5 }, (_, index) => ({
    id: `perf-${index}`,
    text: `${runId} 文档 ${index}。${"Zvec persistent retrieval evidence. ".repeat(85)}`,
  }));
  const batches = inference.planRerankBatches(documents, budgetPlan, estimator);
  assert(batches.length > 1, `Over-limit candidate set planned only ${batches.length} batch`);
  const winners = [];
  for (const batch of batches) {
    const response = await reranker.rerank({
      query: `哪一段描述 ${runId} 的 Zvec 持久化？`,
      documents: batch.documents,
      topN: Math.min(2, batch.documents.length),
      maxInputTokens: rerankMaxInputTokens,
    });
    winners.push(...response.items);
  }
  const winnerDocuments = winners.map((winner) =>
    documents.find((item) => item.id === winner.documentId),
  );
  assert(winnerDocuments.every(Boolean), "Rerank batch winner index mapping failed");
  const final = await reranker.rerank({
    query: `哪一段描述 ${runId} 的 Zvec 持久化？`,
    documents: winnerDocuments,
    topN: winnerDocuments.length,
    maxInputTokens: rerankMaxInputTokens,
  });
  assert(final.items.length === winnerDocuments.length, "Final merged Rerank failed");
  scenario("R1 long-context planned multi-batch real Rerank", started, {
    modelContextTokens: rerankMaxInputTokens,
    availableDocumentTokens: budgetPlan.availableDocumentTokens,
    batches: batches.length,
    remoteRounds: batches.length + 1,
  });
}

async function runFormats() {
  const started = performance.now();
  const namespace = `e2e:${runId}:formats`;
  const fixtures = await createFormatFixtures();
  const operations = [
    ...fixtures.map((fixture, index) => ({
      kind: "tool",
      name: "commit_knowledge",
      parameters: {
        kind: fixture.kind,
        value: fixture.filename,
        namespace: `${namespace}:${index}`,
      },
      waitForKnowledgeJob: true,
    })),
    ...fixtures.map((fixture, index) => ({
      kind: "tool",
      name: "search_knowledge",
      parameters: {
        query: `${fixture.marker} ${fixture.query}`,
        namespace: `${namespace}:${index}`,
        limit: 100,
      },
    })),
  ];
  const response = await runPi("@galvinsan/pi-mentis-knowledge", operations);
  const searches = response.results.slice(fixtures.length);
  for (const [index, fixture] of fixtures.entries()) {
    const result = searchPayload(searches[index]);
    assert(
      result.hits?.some((hit) => hit.text.includes(fixture.marker)),
      `${fixture.name} did not complete parser → Embedding → Zvec → search`,
    );
  }
  scenario("F1-F22 real declared parser formats", started, {
    formatCount: fixtures.length,
    formats: fixtures.map((fixture) => fixture.name),
  });
}

async function runFaultRecovery() {
  const started = performance.now();
  const { provider, config } = await loadInferenceModules();
  const invalidKeyName = "PI_MENTIS_E2E_INVALID_SILICONFLOW_KEY";
  process.env[invalidKeyName] = `invalid-${runId}`;
  let authenticationError;
  try {
    const invalid = new provider.SiliconFlowEmbeddingProvider({
      ...config.inference.siliconflow,
      apiKeyEnv: invalidKeyName,
      retry: { ...config.inference.siliconflow.retry, maxAttempts: 1 },
    });
    await invalid.embed({
      inputs: [`invalid credential probe ${runId}`],
      inputKind: "query",
      dimensions,
    });
  } catch (error) {
    authenticationError = error;
  } finally {
    delete process.env[invalidKeyName];
  }
  assert(
    authenticationError?.name === "ProviderAuthenticationError",
    `Invalid key returned ${authenticationError?.name ?? "no error"}`,
  );
  let invalidModelError;
  try {
    new provider.SiliconFlowEmbeddingProvider({
      ...config.inference.siliconflow,
      embedding: {
        ...config.inference.siliconflow.embedding,
        model: `nonexistent/${runId}`,
      },
    });
  } catch (error) {
    invalidModelError = error;
  }
  assert(
    invalidModelError?.name === "ModelCapabilityMismatchError",
    `Invalid model returned ${invalidModelError?.name ?? "no error"}`,
  );
  const recoveredProvider = new provider.SiliconFlowEmbeddingProvider(config.inference.siliconflow);
  const recovered = await recoveredProvider.embed({
    inputs: [`credential recovery ${runId}`],
    inputKind: "query",
    dimensions,
  });
  assert(recovered.vectors[0]?.values.length === dimensions, "Credential recovery failed");

  const namespace = `e2e:${runId}`;
  const invalidRerank = await runPi(
    "@galvinsan/pi-mentis",
    [
      {
        kind: "tool",
        name: "search_memory",
        parameters: {
          query: `这个项目 ${runId} 使用什么数据库？`,
          namespace,
          limit: 20,
        },
      },
    ],
    {
      environment: {
        SILICONFLOW_RERANK_MODEL: `nonexistent/${runId}`,
      },
    },
  );
  const degraded = searchPayload(invalidRerank.results[0]);
  assert(degraded.hits?.length > 0, "Invalid Rerank model blocked retrieval");
  assert(
    degraded.diagnostics?.degraded?.includes("rerank:unavailable"),
    "Rerank fallback was not recorded",
  );
  const recoveredRerank = await runPi("@galvinsan/pi-mentis", [
    {
      kind: "tool",
      name: "search_memory",
      parameters: {
        query: `恢复后确认 ${runId} 的 Zvec 数据库规范`,
        namespace,
        limit: 20,
      },
    },
  ]);
  const recoveredSearch = searchPayload(recoveredRerank.results[0]);
  assert(
    recoveredSearch.hits?.some((hit) => hit.text.includes("Zvec")),
    "Restored Rerank configuration did not recover retrieval",
  );
  scenario("E1-E3 real credential/model failure and Rerank recovery", started, {
    invalidKeyError: authenticationError.name,
    invalidModelError: invalidModelError.name,
    rerankFallback: degraded.diagnostics.degraded,
    recoveryTrace: recovered.traceId ?? null,
  });
}

const selected =
  suite === "all"
    ? [
        "inference",
        "knowledge",
        "memory",
        "combined",
        "pi",
        "restart",
        "performance",
        "formats",
        "faults",
      ]
    : [suite];
try {
  for (const name of selected) {
    if (name === "inference") await runInference();
    if (name === "knowledge") await runKnowledge();
    if (name === "memory") await runMemory();
    if (name === "combined") await runCombined();
    if (name === "pi") await runPiSurfaces();
    if (name === "restart") await runRestart();
    if (name === "performance") await runPerformance();
    if (name === "formats") await runFormats();
    if (name === "faults") await runFaultRecovery();
    if (name === "migration") await runEmbeddingMigration();
  }
} catch (error) {
  report.scenarios.push({
    name: `${suite} unhandled failure`,
    status: "FAIL",
    error: error instanceof Error ? error.message : String(error),
  });
  report.failure = {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

async function diagnostics() {
  try {
    return (await readFile(diagnosticsFile, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

const inferenceDiagnostics = await diagnostics();
const usage = {
  embeddingRequestCount: inferenceDiagnostics.filter((item) => item.operation === "embedding")
    .length,
  embeddingInputCount: inferenceDiagnostics
    .filter((item) => item.operation === "embedding")
    .reduce((sum, item) => sum + (item.inputCount ?? 0), 0),
  rerankRequestCount: inferenceDiagnostics.filter((item) => item.operation === "rerank").length,
  rerankDocumentCount: inferenceDiagnostics
    .filter((item) => item.operation === "rerank")
    .reduce((sum, item) => sum + (item.documentCount ?? 0), 0),
  estimatedTokens: inferenceDiagnostics.reduce((sum, item) => sum + (item.estimatedTokens ?? 0), 0),
  cacheHits: inferenceDiagnostics.filter((item) => item.cacheHit === true).length,
  retries: inferenceDiagnostics.reduce((sum, item) => sum + (item.retryCount ?? 0), 0),
  traceIds: inferenceDiagnostics.filter((item) => typeof item.traceId === "string").length,
};
function percentile(values, fraction) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
}
const remoteDurations = inferenceDiagnostics
  .map((item) => item.durationMs)
  .filter((value) => typeof value === "number" && Number.isFinite(value));
report.performance = {
  p50Ms: percentile(remoteDurations, 0.5),
  p95Ms: percentile(remoteDurations, 0.95),
  p99Ms: percentile(remoteDurations, 0.99),
  embeddingP50Ms: percentile(
    inferenceDiagnostics
      .filter((item) => item.operation === "embedding")
      .map((item) => item.durationMs),
    0.5,
  ),
  rerankP50Ms: percentile(
    inferenceDiagnostics
      .filter((item) => item.operation === "rerank")
      .map((item) => item.durationMs),
    0.5,
  ),
};
report.usage = usage;
report.remoteEvidence = inferenceDiagnostics.map((item) => ({
  ...item,
  traceId:
    typeof item.traceId === "string" && item.traceId.length > 10
      ? `${item.traceId.slice(0, 4)}…${item.traceId.slice(-4)}`
      : (item.traceId ?? null),
}));
report.finishedAt = new Date().toISOString();
report.status = report.failure === undefined ? "PASS" : "FAIL";
for (const [key, maximum] of [
  ["embeddingRequestCount", budget.maxEmbeddingRequests],
  ["embeddingInputCount", budget.maxEmbeddingInputs],
  ["rerankRequestCount", budget.maxRerankRequests],
  ["rerankDocumentCount", budget.maxRerankDocuments],
  ["estimatedTokens", budget.maxEstimatedTokens],
]) {
  if (usage[key] > maximum) {
    report.status = "FAIL";
    report.failure = {
      name: "LiveE2EBudgetExceeded",
      message: `${key}=${usage[key]} exceeds ${maximum}`,
    };
  }
}
if (inferenceDiagnostics.length === 0 && suite !== "pi") {
  report.status = "FAIL";
  report.failure = {
    name: "MissingRemoteEvidence",
    message: "No real SiliconFlow diagnostics were recorded",
  };
}

const jsonReport = path.join(directories.reports, "live-e2e.json");
await writeFile(jsonReport, `${JSON.stringify(report, null, 2)}\n`);
const scenarioRows = report.scenarios
  .map((item) => `| ${item.name} | ${item.status} | ${Math.round(item.durationMs ?? 0)} |`)
  .join("\n");
const migrationCoverageNote =
  suite === "all" && report.scenarios.some((item) => item.status === "BLOCKED")
    ? "\nD1/G1 is blocked only for the production `BAAI/bge-m3` configuration because that model exposes a fixed 1024 dimensions. The same scenario is completed with real selectable dimensions in the [migration report](./live-migration-e2e-report.md).\n"
    : "";
const markdown = `# Pi Mentis Live${suite === "migration" ? " Embedding Migration" : ""} E2E Report

- Run ID: \`${runId}\`
- Suite: \`${suite}\`
- Status: **${report.status}**
- Artifact: \`${path.relative(root, artifactRoot)}\`

## Environment

| Item | Value |
| --- | --- |
| Node | ${report.environment.node} |
| Pi | ${report.environment.piVersion} / v0.83.0 / ${report.environment.piCommit} |
| OS / architecture | ${report.environment.os} / ${report.environment.architecture} |
| Zvec SDK | ${report.environment.zvecVersion} |
| SiliconFlow Base URL | ${report.environment.siliconFlowBaseUrl} |
| Embedding model / dimension | ${report.environment.embeddingModel} / ${dimensions} |
| Rerank model / context | ${report.environment.rerankModel} / ${rerankMaxInputTokens} |

No API key, Authorization header, request header, or input body is present in this report.

## Scenarios

| Scenario | Status | Duration ms |
| --- | --- | ---: |
${scenarioRows}
${migrationCoverageNote}

## Real remote requests

- Embedding requests: ${usage.embeddingRequestCount}
- Embedding inputs: ${usage.embeddingInputCount}
- Rerank requests: ${usage.rerankRequestCount}
- Rerank documents: ${usage.rerankDocumentCount}
- Estimated input units: ${usage.estimatedTokens}
- Trace IDs returned: ${usage.traceIds}
- Retries: ${usage.retries}

## Persistence

- Isolated Zvec root: \`${path.relative(root, directories.zvec)}\`
- Full process restarts: ${report.restarts.length}
- Restart recall successes: ${report.restarts.filter((item) => item.recalled).length}

## Performance

- Remote request P50 / P95 / P99: ${report.performance.p50Ms ?? "n/a"} / ${report.performance.p95Ms ?? "n/a"} / ${report.performance.p99Ms ?? "n/a"} ms
- Embedding P50: ${report.performance.embeddingP50Ms ?? "n/a"} ms
- Rerank P50: ${report.performance.rerankP50Ms ?? "n/a"} ms

The complete sanitized evidence is in \`${path.relative(root, jsonReport)}\`.
`;
if (suite === "all" || suite === "migration") {
  await writeFile(
    path.join(
      root,
      "docs",
      suite === "migration" ? "live-migration-e2e-report.md" : "live-e2e-report.md",
    ),
    markdown,
  );
}
console.log(JSON.stringify({ status: report.status, runId, artifactRoot, usage }, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
