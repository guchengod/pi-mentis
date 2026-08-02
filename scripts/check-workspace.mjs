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
const manifests = new Map();

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(target)));
    else if (entry.isFile() && /\.[cm]?[jt]sx?$/u.test(entry.name)) files.push(target);
  }
  return files;
}

for (const entry of packageDirs) {
  if (!entry.isDirectory()) continue;
  const manifestPath = path.join(root, "packages", entry.name, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifests.set(manifest.name, { directory: entry.name, manifest });
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

// Production layers depend on contracts, not Pi extension implementations or the native
// Zvec driver. This keeps the retrieval/state core independently testable and prevents
// extensions from bypassing the centrally budgeted inference services.
const architectureRules = [
  {
    directory: "core",
    forbidden: [
      "@zvec/zvec",
      "pi-mentis-siliconflow",
      "pi-memory-extension",
      "pi-context-extension",
      "pi-knowledge-extension",
    ],
  },
  {
    directory: "memory",
    forbidden: [
      "@zvec/zvec",
      "pi-mentis-siliconflow",
      "pi-memory-extension",
      "pi-context-extension",
      "pi-knowledge-extension",
    ],
  },
  {
    directory: "retrieval",
    forbidden: [
      "@zvec/zvec",
      "pi-mentis-siliconflow",
      "pi-memory-extension",
      "pi-context-extension",
      "pi-knowledge-extension",
    ],
  },
];
for (const rule of architectureRules) {
  const directory = path.join(root, "packages", rule.directory, "src");
  for (const file of await sourceFiles(directory)) {
    const source = await readFile(file, "utf8");
    for (const forbidden of rule.forbidden) {
      if (source.includes(forbidden)) {
        failures.push(
          `${path.relative(root, file)}: forbidden architecture dependency ${forbidden}`,
        );
      }
    }
  }
}

for (const extension of publishedExtensions) {
  const directory = path.join(root, "packages", extension, "src");
  for (const file of await sourceFiles(directory)) {
    const source = await readFile(file, "utf8");
    if (/\.(?:embed|rerank)\s*\(/u.test(source)) {
      failures.push(
        `${path.relative(root, file)}: extensions must not call embedding or rerank providers directly`,
      );
    }
  }
}

// Detect runtime dependency cycles among workspace packages. Development-only relationships
// are excluded because they are not present in the published runtime graph.
const visiting = new Set();
const visited = new Set();
function visitPackage(name, trail = []) {
  if (visiting.has(name)) {
    failures.push(`runtime dependency cycle: ${[...trail, name].join(" -> ")}`);
    return;
  }
  if (visited.has(name)) return;
  const entry = manifests.get(name);
  if (entry === undefined) return;
  visiting.add(name);
  const dependencies = {
    ...(entry.manifest.dependencies ?? {}),
    ...(entry.manifest.optionalDependencies ?? {}),
  };
  for (const dependency of Object.keys(dependencies)) {
    if (manifests.has(dependency)) visitPackage(dependency, [...trail, name]);
  }
  visiting.delete(name);
  visited.add(name);
}
for (const name of manifests.keys()) visitPackage(name);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
