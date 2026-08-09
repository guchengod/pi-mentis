import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const packagePaths = [
  "packages/pi-context-extension/package.json",
  "packages/pi-memory-extension/package.json",
  "packages/pi-knowledge-extension/package.json",
];

export async function readExtensionVersions() {
  const entries = await Promise.all(
    packagePaths.map(async (relativePath) => {
      const packageJson = JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
      return { name: packageJson.name, version: packageJson.version };
    }),
  );
  return entries;
}

export async function assertExtensionVersions() {
  const entries = await readExtensionVersions();
  const versions = new Set(entries.map(({ version }) => version));
  if (versions.size !== 1) {
    const details = entries.map(({ name, version }) => `${name}=${version}`).join(", ");
    throw new Error(`Extension package versions must match: ${details}`);
  }
  const [version] = versions;
  console.log(`Extension package versions aligned: ${version}`);
  return version;
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await assertExtensionVersions();
