import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { acceptanceBase, assertAcceptanceRoot } from "./common.mjs";

export async function cleanupAcceptance({ root, runId, directories, preserveBackup = true }) {
  assertAcceptanceRoot(root, runId);
  if (!root.startsWith(`${acceptanceBase}${path.sep}`)) throw new Error("Refusing unsafe cleanup");
  const removed = [];
  for (const name of ["repos", "general", "artifacts", "provider", "isolated-pi-home", "state"]) {
    const target = directories[name];
    if (target === undefined) continue;
    await rm(target, { recursive: true, force: true });
    removed.push(target);
  }
  if (!preserveBackup && directories.backup !== undefined) {
    await rm(directories.backup, { recursive: true, force: true });
    removed.push(directories.backup);
  }
  const report = `# Cleanup Report\n\n- Run ID: \`${runId}\`\n- Completed: ${new Date().toISOString()}\n- Removed only acceptance-root resources:\n${removed.map((item) => `  - \`${item}\``).join("\n")}\n- Preserved reports: \`${directories.reports}\`\n- Preserved backup: ${preserveBackup ? `\`${directories.backup}\`` : "no"}\n`;
  await writeFile(path.join(directories.reports, "cleanup-report.md"), report, { mode: 0o600 });
  return { removed, preserveBackup };
}
