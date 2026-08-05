/**
 * Resource Reference Resolver — deterministic ID-to-resource-type routing.
 *
 * For a given ID, queries MemoryService, PiEvidenceStore (artifacts + events)
 * within the current security scope to determine the resource type.
 *
 * Rules:
 *   - Prefixed IDs (mem_/art_/ev_) → direct routing (future-proof).
 *   - Unprefixed 64-char hex IDs → probe all stores; ambiguous if multiple hit.
 *   - None hit → not_found.
 *   - Scope gate applied before type confirmation.
 *
 * Caching: resolved references are cached with a security-namespace-aware key
 * (tenant + user + app + agent + repo + project + id) to prevent cross-tenant
 * or cross-project cache poisoning.
 */

import type {
  MemoryService,
  PiEvidenceStore,
  PiScopeContext,
  MemoryGetOptions,
  EvidenceReadOptions,
} from "@pi-mentis/pi-mentis-memory-core";

export type MentisResourceType =
  | "memory"
  | "artifact"
  | "evidence"
  | "search"
  | "unknown";

export interface ResolvedMentisReference {
  readonly id: string;
  readonly type: MentisResourceType;

  readonly readable: boolean;
  readonly queryable: boolean;

  readonly scopeAllowed: boolean;

  readonly reason:
    | "resolved"
    | "not_found"
    | "scope_denied"
    | "not_ready"
    | "expired"
    | "failed"
    | "ambiguous";
}

export interface ResourceReferenceResolverContext {
  readonly scopeContext: PiScopeContext;
  readonly signal?: AbortSignal;
}

export interface MentisResourceReferenceResolver {
  resolve(
    id: string,
    context: ResourceReferenceResolverContext,
  ): Promise<ResolvedMentisReference>;
}

const PREFIX_MAP: Readonly<Record<string, MentisResourceType>> = {
  mem_: "memory",
  art_: "artifact",
  ev_: "evidence",
};

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 256;

interface CacheEntry {
  readonly ref: ResolvedMentisReference;
  readonly timestamp: number;
}

function resolvePrefix(id: string): MentisResourceType | undefined {
  for (const [prefix, type] of Object.entries(PREFIX_MAP)) {
    if (id.startsWith(prefix)) return type;
  }
  return undefined;
}

function memoryGetOptions(
  scopeContext: PiScopeContext,
  signal?: AbortSignal,
): MemoryGetOptions {
  if (signal === undefined) return { scopeContext };
  return { scopeContext, signal };
}

function evidenceReadOptions(
  scopeContext: PiScopeContext,
  signal?: AbortSignal,
): EvidenceReadOptions {
  if (signal === undefined) return { scopeContext };
  return { scopeContext, signal };
}

function buildCacheKey(id: string, scopeContext: PiScopeContext): string {
  return [
    scopeContext.tenantId,
    scopeContext.userId,
    scopeContext.appId,
    scopeContext.agentId,
    scopeContext.repositoryId ?? "",
    scopeContext.projectId ?? "",
    id,
  ].join(":");
}

function isAlive(state: string, expiresAt?: number): boolean {
  if (state !== "ready") return false;
  if (expiresAt !== undefined && expiresAt <= Date.now()) return false;
  return true;
}

function expiredReason(expiresAt?: number): boolean {
  return expiresAt !== undefined && expiresAt <= Date.now();
}

const UNRESOLVED = {
  readable: false as const,
  queryable: false as const,
  scopeAllowed: false as const,
} as const;

/**
 * Public-facing reason: never expose scope_denied if the store returns
 * undefined for both "doesn't exist" and "exists but no permission".
 * Use not_found to avoid existence side-channel.
 */
function publicReason(
  reason: ResolvedMentisReference["reason"],
  scopeAllowed: boolean,
): ResolvedMentisReference["reason"] {
  if (reason === "scope_denied" && !scopeAllowed) return "not_found";
  return reason;
}

export class DefaultMentisResourceReferenceResolver implements MentisResourceReferenceResolver {
  readonly #memory: MemoryService;
  readonly #evidence: PiEvidenceStore;
  readonly #cache = new Map<string, CacheEntry>();

  constructor(memory: MemoryService, evidence: PiEvidenceStore) {
    this.#memory = memory;
    this.#evidence = evidence;
  }

  async resolve(
    id: string,
    context: ResourceReferenceResolverContext,
  ): Promise<ResolvedMentisReference> {
    const { scopeContext, signal } = context;
    const cacheKey = buildCacheKey(id, scopeContext);
    const cached = this.#cache.get(cacheKey);
    if (cached !== undefined && cached.timestamp + CACHE_TTL_MS > Date.now()) {
      // Return cached result with public-facing reason adjustment
      return {
        ...cached.ref,
        reason: publicReason(cached.ref.reason, cached.ref.scopeAllowed),
      };
    }
    if (this.#cache.size >= CACHE_MAX) {
      this.#evictStale();
    }

    const ref = await this.#resolveUncached(id, scopeContext, signal);
    this.#cache.set(cacheKey, { ref, timestamp: Date.now() });
    return {
      ...ref,
      reason: publicReason(ref.reason, ref.scopeAllowed),
    };
  }

  async #resolveUncached(
    id: string,
    scopeContext: PiScopeContext,
    signal?: AbortSignal,
  ): Promise<ResolvedMentisReference> {
    const memOpts = memoryGetOptions(scopeContext, signal);
    const evOpts = evidenceReadOptions(scopeContext, signal);

    const prefixType = resolvePrefix(id);
    const unprefixed = id.replace(/^(?:mem_|art_|ev_)/, "");

    if (prefixType === "memory") {
      const record = await this.#memory.get(unprefixed, memOpts).catch(() => undefined);
      if (record !== undefined) {
        return {
          id, type: "memory", readable: true, queryable: true, scopeAllowed: true, reason: "resolved",
        };
      }
      return { id, type: "memory", ...UNRESOLVED, reason: "not_found" };
    }

    if (prefixType === "artifact") {
      const artifact = await this.#evidence.getArtifact(unprefixed, evOpts).catch(() => undefined);
      if (artifact !== undefined) {
        if (!isAlive(artifact.state, artifact.expiresAt)) {
          const reason = expiredReason(artifact.expiresAt) ? "expired" : "not_ready";
          return { id, type: "artifact", readable: false, queryable: false, scopeAllowed: true, reason };
        }
        return {
          id, type: "artifact", readable: true, queryable: true, scopeAllowed: true, reason: "resolved",
        };
      }
      return { id, type: "artifact", ...UNRESOLVED, reason: "not_found" };
    }

    if (prefixType === "evidence") {
      const event = await this.#evidence.getEvent(unprefixed, evOpts).catch(() => undefined);
      if (event !== undefined) {
        return {
          id, type: "evidence", readable: true, queryable: false, scopeAllowed: true, reason: "resolved",
        };
      }
      return { id, type: "evidence", ...UNRESOLVED, reason: "not_found" };
    }

    // Unprefixed ID → probe all stores in parallel
    const [memoryResult, artifactResult, eventResult] = await Promise.all([
      this.#memory.get(id, memOpts).catch(() => undefined),
      this.#evidence.getArtifact(id, evOpts).catch(() => undefined),
      this.#evidence.getEvent(id, evOpts).catch(() => undefined),
    ]);

    const hits: MentisResourceType[] = [];
    if (memoryResult !== undefined) hits.push("memory");
    if (artifactResult !== undefined && isAlive(artifactResult.state, artifactResult.expiresAt)) {
      hits.push("artifact");
    }
    if (eventResult !== undefined) hits.push("evidence");

    if (hits.length === 0) {
      return { id, type: "unknown", ...UNRESOLVED, reason: "not_found" };
    }

    if (hits.length > 1) {
      return { id, type: "unknown", ...UNRESOLVED, scopeAllowed: true, reason: "ambiguous" };
    }

    const type = hits[0];
    if (type === "memory" && memoryResult !== undefined) {
      return {
        id, type: "memory", readable: true, queryable: true, scopeAllowed: true, reason: "resolved",
      };
    }

    if (type === "artifact" && artifactResult !== undefined) {
      if (!isAlive(artifactResult.state, artifactResult.expiresAt)) {
        const reason = expiredReason(artifactResult.expiresAt) ? "expired" : "not_ready";
        return { id, type: "artifact", readable: false, queryable: false, scopeAllowed: true, reason };
      }
      return {
        id, type: "artifact", readable: true, queryable: true, scopeAllowed: true, reason: "resolved",
      };
    }

    if (type === "evidence" && eventResult !== undefined) {
      return {
        id, type: "evidence", readable: true, queryable: false, scopeAllowed: true, reason: "resolved",
      };
    }

    return { id, type: "unknown", ...UNRESOLVED, reason: "not_found" };
  }

  #evictStale(): void {
    const cutoff = Date.now() - CACHE_TTL_MS;
    for (const [key, entry] of this.#cache) {
      if (entry.timestamp < cutoff) {
        this.#cache.delete(key);
      }
    }
  }
}
