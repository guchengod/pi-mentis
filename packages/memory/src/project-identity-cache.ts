import { stat } from "node:fs/promises";
import nodePath from "node:path";

import { systemClock, type Clock } from "@pi-mentis/pi-mentis-core";

import { resolvePiProjectIdentity, type PiProjectIdentity } from "./project-identity.js";

interface CacheEntry {
  readonly identity: PiProjectIdentity;
  readonly gitConfigMtime: number | undefined;
  readonly headMtime: number | undefined;
  readonly resolvedAt: number;
  readonly canonicalRoot: string;
}

export interface ProjectIdentityCacheOptions {
  readonly ttlMs?: number;
  readonly clock?: Clock;
}

export class ProjectIdentityCache {
  readonly #cache = new Map<string, CacheEntry>();
  readonly #ttlMs: number;
  readonly #clock: Clock;

  constructor(options: ProjectIdentityCacheOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 30_000;
    this.#clock = options.clock ?? systemClock;
  }

  async resolve(cwd: string): Promise<PiProjectIdentity> {
    const identity = await resolvePiProjectIdentity(cwd);
    this.#set(cwd, identity);
    return identity;
  }

  async getOrResolve(cwd: string): Promise<{ identity: PiProjectIdentity; cacheHit: boolean }> {
    const canonicalRoot = nodePath.resolve(cwd);

    const entry = this.#cache.get(canonicalRoot);
    if (entry !== undefined) {
      const age = this.#clock.now() - entry.resolvedAt;
      if (age < this.#ttlMs) {
        const fresh = await this.#checkFresh(entry);
        if (fresh) return { identity: entry.identity, cacheHit: true };
      }
    }

    const identity = await resolvePiProjectIdentity(cwd);
    this.#set(canonicalRoot, identity);
    return { identity, cacheHit: false };
  }

  invalidate(cwd: string): void {
    this.#cache.delete(nodePath.resolve(cwd));
  }

  clear(): void {
    this.#cache.clear();
  }

  get size(): number {
    return this.#cache.size;
  }

  #set(canonicalRoot: string, identity: PiProjectIdentity): void {
    const now = this.#clock.now();
    const gitDir =
      identity.repositoryRoot !== undefined
        ? nodePath.join(identity.repositoryRoot, ".git")
        : undefined;
    this.#cache.set(canonicalRoot, {
      identity,
      canonicalRoot,
      gitConfigMtime: undefined,
      headMtime: undefined,
      resolvedAt: now,
      ...(gitDir !== undefined
        ? {
            gitConfigMtime: now,
            headMtime: now,
          }
        : {}),
    });
  }

  async #checkFresh(entry: CacheEntry): Promise<boolean> {
    const root = entry.identity.repositoryRoot ?? entry.canonicalRoot;
    const gitDir = nodePath.join(root, ".git");
    try {
      const configStat = await stat(nodePath.join(gitDir, "config")).catch(() => undefined);
      const headStat = await stat(nodePath.join(gitDir, "HEAD")).catch(() => undefined);

      const configChanged =
        configStat !== undefined && entry.gitConfigMtime !== undefined
          ? configStat.mtimeMs !== entry.gitConfigMtime
          : false;
      const headChanged =
        headStat !== undefined && entry.headMtime !== undefined
          ? headStat.mtimeMs !== entry.headMtime
          : false;

      return !configChanged && !headChanged;
    } catch {
      return false;
    }
  }
}

let globalCache: ProjectIdentityCache | undefined;

export function getProjectIdentityCache(options?: ProjectIdentityCacheOptions): ProjectIdentityCache {
  if (globalCache === undefined) {
    globalCache = new ProjectIdentityCache(options);
  }
  return globalCache;
}
