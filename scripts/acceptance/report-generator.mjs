import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { writeJson, xmlEscape } from "./common.mjs";

function count(results, status) {
  return results.filter((result) => result.status === status).length;
}

function table(results) {
  return [
    "| ID | Scenario | Status | Duration ms | Evidence |",
    "| --- | --- | --- | ---: | --- |",
    ...results.map(
      (result) =>
        `| ${result.id} | ${result.name} | ${result.status} | ${Math.round(result.durationMs ?? 0)} | ${result.evidence ?? ""} |`,
    ),
  ].join("\n");
}

export async function generateReports(context) {
  const { reports, environment, runId, startedAt, endedAt, results, defects, fixes, artifacts } =
    context;
  await mkdir(path.join(reports, "evidence"), { recursive: true, mode: 0o700 });
  const failed = count(results, "FAIL");
  const blocked = count(results, "BLOCKED");
  const skipped = count(results, "SKIP");
  const passed = count(results, "PASS");
  const nonPerformanceFailures = results.filter(
    (result) => result.status === "FAIL" && result.stage !== "Performance",
  ).length;
  // The formal acceptance contract explicitly classifies an unmet performance
  // budget as PARTIAL when functional correctness remains intact.
  const finalStatus =
    nonPerformanceFailures > 0
      ? "FAIL"
      : failed > 0 || blocked > 0 || skipped > 0
        ? "PARTIAL"
        : "PASS";
  const summary = {
    finalStatus,
    runId,
    startedAt,
    endedAt,
    piVersion: environment.piVersion,
    piMentisCommit: environment.gitCommit,
    buildArtifactHashes: artifacts,
    provider: environment.provider,
    zvecPath: context.zvecPath,
    total: results.length,
    passed,
    failed,
    blocked,
    skipped,
    fixedDefects: fixes.length,
    remainingDefects: defects.filter((defect) => defect.status !== "fixed").length,
    results,
  };
  await writeJson(path.join(reports, "acceptance-results.json"), summary);
  await writeJson(path.join(reports, "environment.json"), environment);
  const stageGroups = Object.groupBy(results, (result) => result.stage ?? "Other");
  const stageLines = Object.entries(stageGroups).map(([stage, items]) => {
    const statuses = new Set(items.map((item) => item.status));
    const status = statuses.has("FAIL")
      ? "FAIL"
      : statuses.has("BLOCKED") || statuses.has("SKIP")
        ? "PARTIAL"
        : "PASS";
    return `- ${stage}: ${status} (${items.filter((item) => item.status === "PASS").length}/${items.length})`;
  });
  const summaryMarkdown = `# Pi Mentis Acceptance Summary

- Final status: **${finalStatus}**
- Run ID: \`${runId}\`
- Started: ${startedAt}
- Ended: ${endedAt}
- Pi: ${environment.piVersion}
- Pi Mentis commit: \`${environment.gitCommit}\`
- Provider: ${environment.provider.piDefault}/${environment.provider.piModel}
- Embedding/Rerank: ${environment.provider.embeddingModel} / ${environment.provider.rerankModel}
- Zvec: \`${context.zvecPath}\`
- Total / Passed / Failed / Blocked / Skipped: ${results.length} / ${passed} / ${failed} / ${blocked} / ${skipped}
- Fixed defects / Remaining defects: ${fixes.length} / ${summary.remainingDefects}

## Stage conclusions

${stageLines.join("\n")}

## Scenario results

${table(results)}
`;
  await writeFile(path.join(reports, "acceptance-summary.md"), summaryMarkdown, { mode: 0o600 });
  const suites = results
    .map(
      (result) =>
        `  <testcase classname="${xmlEscape(result.stage ?? "acceptance")}" name="${xmlEscape(result.id)} ${xmlEscape(result.name)}" time="${((result.durationMs ?? 0) / 1_000).toFixed(3)}">${
          result.status === "FAIL"
            ? `<failure message="${xmlEscape(result.error ?? "failed")}"/>`
            : result.status === "BLOCKED" || result.status === "SKIP"
              ? `<skipped message="${xmlEscape(result.reason ?? result.status)}"/>`
              : ""
        }</testcase>`,
    )
    .join("\n");
  await writeFile(
    path.join(reports, "junit.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="pi-mentis-acceptance" tests="${results.length}" failures="${failed}" skipped="${blocked + skipped}">\n${suites}\n</testsuite>\n`,
    { mode: 0o600 },
  );
  const categoryFiles = {
    "build-install-report.md": ["Preflight", "Build", "Install"],
    "functional-report.md": ["P0-P6", "Tencent", "P8", "P11"],
    "temporal-report.md": ["P9"],
    "retrieval-report.md": ["P10", "P12", "P13"],
    "security-report.md": ["Security"],
    "performance-report.md": ["Performance", "Soak"],
    "recovery-report.md": ["Recovery", "Concurrency"],
    "provider-report.md": ["Provider"],
  };
  for (const [filename, stages] of Object.entries(categoryFiles)) {
    const selected = results.filter((result) => stages.includes(result.stage));
    await writeFile(
      path.join(reports, filename),
      `# ${filename.replace(".md", "").replaceAll("-", " ")}\n\n${selected.length === 0 ? "No scenario result was produced.\n" : `${table(selected)}\n`}`,
      { mode: 0o600 },
    );
  }
  await writeFile(
    path.join(reports, "defects.md"),
    `# Defects\n\n${defects.length === 0 ? "No product defect was recorded.\n" : defects.map((defect) => `## ${defect.id}: ${defect.name}\n\n- Status: ${defect.status}\n- Root cause: ${defect.rootCause ?? "unresolved"}\n- Evidence: ${defect.evidence ?? "n/a"}\n`).join("\n")}`,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(reports, "fixes.md"),
    `# Fixes\n\n${fixes.length === 0 ? "No in-run source fix was required.\n" : fixes.map((fix) => `- ${fix.id}: ${fix.summary} (${fix.regression})`).join("\n")}\n`,
    { mode: 0o600 },
  );
  return summary;
}
