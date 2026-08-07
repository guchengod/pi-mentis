import { describe, it, expect, vi, beforeEach } from "vitest";

let mockIdentity: (cwd: string) => object;
let mockCalls: string[];

vi.mock("../src/project-identity.js", () => ({
  resolvePiProjectIdentity: vi.fn((cwd: string) => {
    mockCalls.push(cwd);
    return Promise.resolve(mockIdentity(cwd));
  }),
}));

import { ProjectIdentityCache } from "../src/project-identity-cache.js";

function fakeIdentity(cwd: string) {
  return {
    workspacePath: cwd,
    repositoryRoot: cwd,
    repositoryId: `repo:${cwd}`,
    projectId: `proj:${cwd}`,
    manifestTypes: [],
  };
}

beforeEach(() => {
  mockCalls = [];
  mockIdentity = fakeIdentity;
});

describe("ProjectIdentityCache", () => {
  it("resolves identity on first call (cache miss)", async () => {
    const cache = new ProjectIdentityCache({ ttlMs: 60_000 });
    const { identity, cacheHit } = await cache.getOrResolve("/tmp/project-a");
    expect(cacheHit).toBe(false);
    expect(identity.repositoryId).toBe("repo:/tmp/project-a");
    expect(mockCalls).toHaveLength(1);
  });

  it("returns cached identity on second call (cache hit)", async () => {
    const cache = new ProjectIdentityCache({ ttlMs: 60_000 });
    const first = await cache.getOrResolve("/tmp/project-a");
    expect(first.cacheHit).toBe(false);

    const second = await cache.getOrResolve("/tmp/project-a");
    expect(second.cacheHit).toBe(true);
    expect(second.identity.repositoryId).toBe("repo:/tmp/project-a");
    expect(mockCalls).toHaveLength(1);
  });

  it("different roots produce different cache entries", async () => {
    const cache = new ProjectIdentityCache({ ttlMs: 60_000 });
    const a = await cache.getOrResolve("/tmp/project-a");
    const b = await cache.getOrResolve("/tmp/project-b");
    expect(a.cacheHit).toBe(false);
    expect(b.cacheHit).toBe(false);
    expect(mockCalls).toHaveLength(2);
    expect(cache.size).toBe(2);
  });

  it("resolve() bypasses cache and sets entry", async () => {
    const cache = new ProjectIdentityCache({ ttlMs: 60_000 });
    const identity = await cache.resolve("/tmp/project-a");
    expect(identity.repositoryId).toBe("repo:/tmp/project-a");

    const cached = await cache.getOrResolve("/tmp/project-a");
    expect(cached.cacheHit).toBe(true);
  });

  it("invalidate removes a specific cache entry", async () => {
    const cache = new ProjectIdentityCache({ ttlMs: 60_000 });
    await cache.getOrResolve("/tmp/project-a");
    await cache.getOrResolve("/tmp/project-b");
    expect(cache.size).toBe(2);

    cache.invalidate("/tmp/project-a");
    expect(cache.size).toBe(1);

    const a = await cache.getOrResolve("/tmp/project-a");
    expect(a.cacheHit).toBe(false);
    expect(mockCalls).toHaveLength(3);
  });

  it("clear removes all cache entries", async () => {
    const cache = new ProjectIdentityCache({ ttlMs: 60_000 });
    await cache.getOrResolve("/tmp/project-a");
    await cache.getOrResolve("/tmp/project-b");
    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("re-resolves when TTL expires", async () => {
    let now = 0;
    const clock = { now: () => now };
    const cache = new ProjectIdentityCache({ ttlMs: 100, clock });

    now = 0;
    await cache.getOrResolve("/tmp/project-a");
    expect(mockCalls).toHaveLength(1);

    now = 50;
    const stillFresh = await cache.getOrResolve("/tmp/project-a");
    expect(stillFresh.cacheHit).toBe(true);
    expect(mockCalls).toHaveLength(1);

    now = 200;
    const expired = await cache.getOrResolve("/tmp/project-a");
    expect(expired.cacheHit).toBe(false);
    expect(mockCalls).toHaveLength(2);
  });

  it("canonicalizes cwd as cache key", async () => {
    const cache = new ProjectIdentityCache({ ttlMs: 60_000 });

    await cache.getOrResolve("/tmp/project-a");
    const hit = await cache.getOrResolve("/tmp/project-a/..//project-a/.");
    expect(hit.cacheHit).toBe(true);
    expect(mockCalls).toHaveLength(1);
  });

  it("handles resolve errors by propagating them", async () => {
    mockIdentity = () => {
      throw new Error("git not found");
    };
    const cache = new ProjectIdentityCache({ ttlMs: 60_000 });
    await expect(cache.getOrResolve("/tmp/nope")).rejects.toThrow("git not found");
  });
});
