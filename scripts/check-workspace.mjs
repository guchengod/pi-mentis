import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const workspace = JSON.parse(await readFile(path.join(root, "mentis.workspace.json"), "utf8"));
const packageDirs = await readdir(path.join(root, "packages"), { withFileTypes: true });
const failures = [];

for (const entry of packageDirs) {
  if (!entry.isDirectory()) continue;
  const manifestPath = path.join(root, "packages", entry.name, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!manifest.name.startsWith(`${workspace.packageScope}/`)) {
    failures.push(`${entry.name}: package name is outside ${workspace.packageScope}`);
  }
  for (const section of ["dependencies", "peerDependencies", "devDependencies"]) {
    const dependencies = manifest[section] ?? {};
    for (const [name, version] of Object.entries(dependencies)) {
      if (name.startsWith("@earendil-works/pi-") && version !== "0.83.0") {
        failures.push(`${entry.name}: ${section}.${name} must equal 0.83.0`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
