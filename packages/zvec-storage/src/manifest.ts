import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  EmbeddingMigrationError,
  operationId,
  type EmbeddingSpaceIdentity,
} from "@pi-mentis/pi-mentis-core";

import type { GenerationKind } from "./schema.js";

export type GenerationState =
  "preparing" | "backfilling" | "validating" | "active" | "superseded" | "failed";

export interface EmbeddingIndexGeneration {
  readonly generationId: string;
  readonly kind: GenerationKind;
  readonly embeddingSpace: EmbeddingSpaceIdentity;
  readonly state: GenerationState;
  readonly createdAt: number;
  readonly activatedAt?: number;
  readonly supersededAt?: number;
  readonly failure?: string;
}

export interface ActiveIndexManifest {
  readonly schemaVersion: 1;
  readonly knowledgeGeneration: string;
  readonly memoryGeneration: string;
  readonly capabilityGeneration: string;
  readonly generations: readonly EmbeddingIndexGeneration[];
  readonly updatedAt: number;
}

const manifestFilename = "active-index-manifest.json";

export async function readActiveManifest(
  rootDir: string,
): Promise<ActiveIndexManifest | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(rootDir, manifestFilename), "utf8"),
    ) as ActiveIndexManifest;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.knowledgeGeneration !== "string" ||
      typeof parsed.memoryGeneration !== "string" ||
      typeof parsed.capabilityGeneration !== "string" ||
      !Array.isArray(parsed.generations)
    ) {
      throw new EmbeddingMigrationError("Active index manifest is invalid", {
        operation: "manifest-read",
        retryable: false,
      });
    }
    return parsed;
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeActiveManifest(
  rootDir: string,
  manifest: ActiveIndexManifest,
): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  const target = path.join(rootDir, manifestFilename);
  const temporary = path.join(rootDir, `${manifestFilename}.${operationId("operation")}.tmp`);
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
}

export function activeGenerationFor(manifest: ActiveIndexManifest, kind: GenerationKind): string {
  if (kind === "knowledge") return manifest.knowledgeGeneration;
  if (kind === "memory") return manifest.memoryGeneration;
  return manifest.capabilityGeneration;
}

export function replaceActiveGeneration(
  manifest: ActiveIndexManifest,
  kind: GenerationKind,
  generationId: string,
  now = Date.now(),
): ActiveIndexManifest {
  const target = manifest.generations.find(
    (generation) => generation.generationId === generationId && generation.kind === kind,
  );
  if (target === undefined || target.state !== "validating") {
    throw new EmbeddingMigrationError(
      `Generation ${generationId} must be validating before activation`,
      { operation: "generation-activate", retryable: false },
    );
  }
  const previousId = activeGenerationFor(manifest, kind);
  const generations = manifest.generations.map((generation) => {
    if (generation.generationId === generationId) {
      return { ...generation, state: "active" as const, activatedAt: now };
    }
    if (generation.generationId === previousId) {
      return { ...generation, state: "superseded" as const, supersededAt: now };
    }
    return generation;
  });
  return {
    ...manifest,
    ...(kind === "knowledge" ? { knowledgeGeneration: generationId } : {}),
    ...(kind === "memory" ? { memoryGeneration: generationId } : {}),
    ...(kind === "capability" ? { capabilityGeneration: generationId } : {}),
    generations,
    updatedAt: now,
  };
}
