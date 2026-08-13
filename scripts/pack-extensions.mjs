import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

import { assertExtensionVersions } from "./check-extension-versions.mjs";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "dist", "extensions");
const extensionDirs = ["pi-memory-extension", "pi-knowledge-extension", "pi-context-extension"];

await assertExtensionVersions();
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const sidecarBundle = await readFile(
  path.join(root, "packages/pi-context-extension/dist/sidecar.js"),
  "utf8",
);
if (/(?:from\s+|import\()["']@earendil-works\/pi-coding-agent["']/u.test(sidecarBundle)) {
  throw new Error(
    "Integrated Sidecar bundle has a runtime Pi host import and will fail in an isolated npm install",
  );
}

for (const directory of extensionDirs) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      ["--filter", `./packages/${directory}`, "pack", "--pack-destination", output],
      { cwd: root, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pnpm pack failed for ${directory} with exit code ${code}`));
    });
  });
}

const artifacts = (await readdir(output)).filter((name) => name.endsWith(".tgz"));
if (artifacts.length !== extensionDirs.length) {
  throw new Error(`Expected ${extensionDirs.length} extension archives, found ${artifacts.length}`);
}
console.log(artifacts.sort().join("\n"));
