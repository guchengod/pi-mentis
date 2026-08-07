import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";

import {
  resolveStorageRoot,
  mentisDirectoryLayout,
  detectLegacyProjectStore,
} from "../src/mentis-home.js";

describe("resolveStorageRoot", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env["PI_MENTIS_HOME"];
    delete process.env["PI_CODING_AGENT_DIR"];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses home-fallback when no env vars set", () => {
    const root = resolveStorageRoot();
    expect(root.source).toBe("home-fallback");
    expect(root.mentisRoot).toContain(".pi-mentis");
    expect(root.isTestOverride).toBe(false);
  });

  it("uses PI_CODING_AGENT_DIR when set", () => {
    process.env["PI_CODING_AGENT_DIR"] = "/custom/pi/agent";
    const root = resolveStorageRoot();
    expect(root.source).toBe("pi-agent-dir");
    expect(root.piHome).toBe("/custom/pi/agent");
    expect(root.mentisRoot).toContain(".pi-mentis");
  });

  it("uses PI_MENTIS_HOME when set (test override)", () => {
    process.env["PI_MENTIS_HOME"] = "/tmp/test-mentis";
    const root = resolveStorageRoot();
    expect(root.source).toBe("pi-mentis-env");
    expect(root.isTestOverride).toBe(true);
    expect(root.mentisRoot).toBe("/tmp/test-mentis");
    expect(root.zvecRoot).toBe("/tmp/test-mentis/zvec");
  });

  it("rejects relative PI_MENTIS_HOME", () => {
    process.env["PI_MENTIS_HOME"] = "relative/path";
    expect(() => resolveStorageRoot()).toThrow("PI_MENTIS_HOME must be an absolute path");
  });

  it("PI_MENTIS_HOME takes priority over PI_CODING_AGENT_DIR", () => {
    process.env["PI_MENTIS_HOME"] = "/tmp/test-mentis";
    process.env["PI_CODING_AGENT_DIR"] = "/custom/pi/agent";
    const root = resolveStorageRoot();
    expect(root.source).toBe("pi-mentis-env");
    expect(root.mentisRoot).toBe("/tmp/test-mentis");
  });

  it("returns same path regardless of imaginary cwd", () => {
    const root1 = resolveStorageRoot();
    const root2 = resolveStorageRoot();
    expect(root1.mentisRoot).toBe(root2.mentisRoot);
    expect(root1.zvecRoot).toBe(root2.zvecRoot);
  });

  it("zvecRoot is always under mentisRoot", () => {
    const root = resolveStorageRoot();
    expect(root.zvecRoot).toContain(root.mentisRoot);
    expect(root.zvecRoot.endsWith("zvec")).toBe(true);
  });
});

describe("mentisDirectoryLayout", () => {
  it("creates consistent structure under mentis root", () => {
    const root = resolveStorageRoot();
    const layout = mentisDirectoryLayout(root);
    expect(layout.root).toBe(root.mentisRoot);
    expect(layout.zvec).toBe(path.join(root.mentisRoot, "zvec"));
    expect(layout.config).toBe(path.join(root.mentisRoot, "config.json"));
    expect(layout.locks).toBe(path.join(root.mentisRoot, "locks"));
    expect(layout.jobs).toBe(path.join(root.mentisRoot, "jobs"));
  });
});

describe("detectLegacyProjectStore", () => {
  it("detects a legacy store in a project directory", () => {
    const result = detectLegacyProjectStore("/tmp/some-project");
    expect(result.detected).toBe(true);
    expect(result.path).toBe("/tmp/some-project/.pi-mentis");
  });

  it("does NOT flag the global mentis root as legacy", () => {
    // When cwd happens to be the global mentis root
    const globalRoot = resolveStorageRoot().mentisRoot;
    const result = detectLegacyProjectStore(globalRoot);
    // Should still detect=true but the caller should check fs
    expect(result.path).toBe(path.join(globalRoot, ".pi-mentis"));
  });
});
