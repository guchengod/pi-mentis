import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const workspace = JSON.parse(await readFile(path.join(root, "mentis.workspace.json"), "utf8"));
const packageDirs = await readdir(path.join(root, "packages"), { withFileTypes: true });
const failures = [];
const publishedExtensions = new Set([
  "pi-context-extension",
  "pi-knowledge-extension",
  "pi-memory-extension",
]);
const piCorePackages = new Set([
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
]);
const requiredExtensionPeers = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "typebox",
];

for (const entry of packageDirs) {
  if (!entry.isDirectory()) continue;
  const manifestPath = path.join(root, "packages", entry.name, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const expectedScope = publishedExtensions.has(entry.name)
    ? workspace.publishScope
    : workspace.packageScope;
  if (!manifest.name.startsWith(`${expectedScope}/`)) {
    failures.push(`${entry.name}: package name is outside ${expectedScope}`);
  }
  for (const section of ["dependencies", "peerDependencies", "devDependencies"]) {
    const dependencies = manifest[section] ?? {};
    for (const [name, version] of Object.entries(dependencies)) {
      if (section === "peerDependencies" && piCorePackages.has(name) && version !== "*") {
        failures.push(`${entry.name}: ${section}.${name} must equal *`);
      } else if (
        section !== "peerDependencies" &&
        name.startsWith("@earendil-works/pi-") &&
        version !== "0.83.0"
      ) {
        failures.push(`${entry.name}: ${section}.${name} must equal 0.83.0`);
      }
    }
  }
  if (publishedExtensions.has(entry.name)) {
    if (!manifest.keywords?.includes("pi-package")) {
      failures.push(`${entry.name}: keywords must include pi-package`);
    }
    if (!Array.isArray(manifest.pi?.extensions) || manifest.pi.extensions.length === 0) {
      failures.push(`${entry.name}: pi.extensions must declare at least one entry`);
    }
    for (const name of requiredExtensionPeers) {
      if (manifest.peerDependencies?.[name] !== "*") {
        failures.push(`${entry.name}: peerDependencies.${name} must equal *`);
      }
      if (!manifest.scripts?.build?.includes(`--external ${name}`)) {
        failures.push(`${entry.name}: build must externalize ${name}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
