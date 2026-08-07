import { describe, it, expect } from "vitest";

import { remotePolicy, DEFAULT_REMOTE_POLICY } from "../src/remote-policy.js";

describe("remotePolicy", () => {
  it("returns default foreground policy", () => {
    const policy = remotePolicy();
    expect(policy.foreground.timeoutMs).toBe(1500);
    expect(policy.foreground.maxRetries).toBe(1);
  });

  it("returns default background policy", () => {
    const policy = remotePolicy();
    expect(policy.background.timeoutMs).toBe(30_000);
    expect(policy.background.maxRetries).toBe(3);
  });

  it("merges partial foreground overrides", () => {
    const policy = remotePolicy({
      foreground: { timeoutMs: 800, maxRetries: 0 },
    });
    expect(policy.foreground.timeoutMs).toBe(800);
    expect(policy.foreground.maxRetries).toBe(0);
    // Background unchanged
    expect(policy.background.timeoutMs).toBe(30_000);
  });

  it("merges partial background overrides", () => {
    const policy = remotePolicy({
      background: { timeoutMs: 10_000 },
    });
    expect(policy.background.timeoutMs).toBe(10_000);
    // maxRetries keeps default
    expect(policy.background.maxRetries).toBe(3);
    // Foreground unchanged
    expect(policy.foreground.timeoutMs).toBe(1500);
  });

  it("merges both foreground and background overrides", () => {
    const policy = remotePolicy({
      foreground: { timeoutMs: 500, maxRetries: 0 },
      background: { timeoutMs: 15_000, maxRetries: 1 },
    });
    expect(policy.foreground.timeoutMs).toBe(500);
    expect(policy.foreground.maxRetries).toBe(0);
    expect(policy.background.timeoutMs).toBe(15_000);
    expect(policy.background.maxRetries).toBe(1);
  });

  it("foreground uses shorter timeout than background", () => {
    const policy = remotePolicy();
    expect(policy.foreground.timeoutMs).toBeLessThan(policy.background.timeoutMs);
  });

  it("foreground uses fewer retries than background", () => {
    const policy = remotePolicy();
    expect(policy.foreground.maxRetries).toBeLessThan(policy.background.maxRetries);
  });

  it("empty overrides produce default policy", () => {
    const policy = remotePolicy({});
    expect(policy.foreground).toEqual(DEFAULT_REMOTE_POLICY.foreground);
    expect(policy.background).toEqual(DEFAULT_REMOTE_POLICY.background);
  });
});
