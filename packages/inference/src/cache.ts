import { stableHash } from "@pi-mentis/pi-mentis-core";

import type { EmbeddingInputKind, RerankItem } from "./contracts.js";

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

export class BoundedTtlCache<T> {
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  readonly #entries = new Map<string, CacheEntry<T>>();

  constructor(maxEntries: number, ttlMs: number) {
    this.#maxEntries = Math.max(1, maxEntries);
    this.#ttlMs = Math.max(1, ttlMs);
  }

  get(key: string, now = Date.now()): T | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now) {
      this.#entries.delete(key);
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, now = Date.now()): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: now + this.#ttlMs });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  clear(): void {
    this.#entries.clear();
  }
}

export interface EmbeddingCacheIdentity {
  readonly providerId: string;
  readonly modelId: string;
  readonly dimensions: number;
  readonly normalization: "none" | "l2";
  readonly preprocessingVersion: string;
  readonly inputKind: EmbeddingInputKind;
  readonly contentHash: string;
}

export function embeddingCacheKey(identity: EmbeddingCacheIdentity): string {
  return stableHash(
    "embedding-cache:v1",
    identity.providerId,
    identity.modelId,
    String(identity.dimensions),
    identity.normalization,
    identity.preprocessingVersion,
    identity.inputKind,
    identity.contentHash,
  );
}

export interface RerankCacheIdentity {
  readonly providerId: string;
  readonly modelId: string;
  readonly queryHash: string;
  readonly orderedDocumentContentHashes: readonly string[];
  readonly instructionHash: string;
  readonly topN: number;
  readonly modelCapabilityVersion: string;
}

export function rerankCacheKey(identity: RerankCacheIdentity): string {
  return stableHash(
    "rerank-cache:v1",
    identity.providerId,
    identity.modelId,
    identity.queryHash,
    ...identity.orderedDocumentContentHashes,
    identity.instructionHash,
    String(identity.topN),
    identity.modelCapabilityVersion,
  );
}

export type RerankCacheValue = readonly Pick<
  RerankItem,
  "documentId" | "originalIndex" | "relevanceScore"
>[];
