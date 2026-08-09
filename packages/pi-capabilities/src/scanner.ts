import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  assertPiCompatibility,
  contentHash,
  stableHash,
  PI_VERSION,
} from "@pi-mentis/pi-mentis-core";
import { glob } from "glob";

import type { CapabilityRecord } from "./types.js";

interface PackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly pi?: {
    readonly extensions?: unknown;
    readonly skills?: unknown;
    readonly prompts?: unknown;
  };
}

export interface ScanPiInstallationOptions {
  readonly piPackageRoot: string;
  readonly resourceRoots?: readonly string[];
}

export interface CapabilityScanResult {
  readonly fingerprint: string;
  readonly records: readonly CapabilityRecord[];
}

function record(
  kind: CapabilityRecord["kind"],
  name: string,
  description: string,
  packageName: string,
  packageVersion: string,
  uri: string,
): CapabilityRecord {
  return {
    id: stableHash("capability:v1", kind, packageName, name),
    kind,
    name,
    qualifiedName: `${packageName}:${name}`,
    description,
    requirements: [],
    constraints: [`Pi ${PI_VERSION}`],
    examples: [],
    packageName,
    packageVersion,
    installed: true,
    sourceRefs: [{ uri }],
  };
}

async function scanTypeScriptApi(
  root: string,
  packageName: string,
  packageVersion: string,
): Promise<CapabilityRecord[]> {
  const files = await glob(["dist/**/*.d.ts", "src/**/*.ts"], {
    cwd: root,
    absolute: true,
    nodir: true,
    ignore: ["**/node_modules/**", "**/*.test.ts"],
  });
  const records: CapabilityRecord[] = [];
  const names = new Set<string>();
  for (const filename of files) {
    const source = await readFile(filename, "utf8");
    for (const match of source.matchAll(
      /(?:export\s+)?(?:interface|type|class|function)\s+([A-Za-z_$][\w$]*)/g,
    )) {
      const name = match[1];
      if (name === undefined || names.has(name)) continue;
      names.add(name);
      records.push(
        record("pi-api", name, `Installed Pi API ${name}`, packageName, packageVersion, filename),
      );
    }
    for (const match of source.matchAll(/(?:type:\s*|event:\s*)["']([a-z][a-z0-9_:-]+)["']/g)) {
      const name = match[1];
      if (name === undefined || names.has(`event:${name}`)) continue;
      names.add(`event:${name}`);
      records.push(
        record("event", name, `Installed Pi event ${name}`, packageName, packageVersion, filename),
      );
    }
  }
  return records;
}

async function scanResourceRoot(root: string): Promise<CapabilityRecord[]> {
  try {
    if (!(await stat(root)).isDirectory()) return [];
  } catch {
    return [];
  }
  const records: CapabilityRecord[] = [];
  const files = await glob(
    ["**/package.json", "**/SKILL.md", "**/*.prompt.md", "**/mcp*.json", "**/settings.json"],
    {
      cwd: root,
      absolute: true,
      nodir: true,
      ignore: ["**/node_modules/**", "**/.git/**"],
    },
  );
  for (const filename of files) {
    const basename = path.basename(filename);
    if (basename === "package.json") {
      const manifest = JSON.parse(await readFile(filename, "utf8")) as PackageManifest;
      if (typeof manifest.name !== "string" || manifest.pi === undefined) continue;
      const version = typeof manifest.version === "string" ? manifest.version : "unknown";
      for (const extension of Array.isArray(manifest.pi.extensions) ? manifest.pi.extensions : []) {
        if (typeof extension === "string") {
          records.push(
            record(
              "extension",
              extension,
              `Installed Pi extension from ${manifest.name}`,
              manifest.name,
              version,
              filename,
            ),
          );
        }
      }
      continue;
    }
    if (basename === "SKILL.md") {
      const text = await readFile(filename, "utf8");
      const name =
        /^name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? path.basename(path.dirname(filename));
      records.push(
        record("skill", name, `Installed Pi skill ${name}`, "local-resource", "local", filename),
      );
      continue;
    }
    if (basename.endsWith(".prompt.md")) {
      records.push(
        record(
          "prompt-template",
          path.basename(basename, ".prompt.md"),
          `Installed prompt template ${basename}`,
          "local-resource",
          "local",
          filename,
        ),
      );
      continue;
    }
    const parsed = JSON.parse(await readFile(filename, "utf8")) as Record<string, unknown>;
    const mcp = parsed["mcpServers"];
    if (typeof mcp === "object" && mcp !== null && !Array.isArray(mcp)) {
      for (const name of Object.keys(mcp)) {
        records.push(
          record(
            "mcp-tool",
            name,
            `Configured MCP server ${name}; credentials and command arguments are not indexed`,
            "local-resource",
            "local",
            filename,
          ),
        );
      }
    }
  }
  return records;
}

export async function scanPiInstallation(
  options: ScanPiInstallationOptions,
): Promise<CapabilityScanResult> {
  const manifestPath = path.join(options.piPackageRoot, "package.json");
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText) as PackageManifest;
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new Error(`Invalid Pi package manifest at ${manifestPath}`);
  }
  assertPiCompatibility(manifest.version);
  const api = await scanTypeScriptApi(options.piPackageRoot, manifest.name, manifest.version);
  const resources = (await Promise.all((options.resourceRoots ?? []).map(scanResourceRoot))).flat();
  const records = [...api, ...resources];
  const fingerprint = contentHash(
    [
      manifestText,
      ...records
        .map((capability) => `${capability.id}:${capability.sourceRefs[0]?.uri ?? ""}`)
        .sort(),
    ].join("\n"),
  );
  return { fingerprint, records };
}
