import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  UnsupportedPiVersionError,
  assertPiCompatibility,
  resetGlobalRuntime,
} from "@pi-mentis/pi-mentis-core";

interface PiLoader {
  loadExtensions(
    paths: string[],
    cwd: string,
  ): Promise<{
    readonly extensions: readonly { readonly path: string }[];
    readonly errors: readonly { readonly path: string; readonly error: string }[];
  }>;
}

afterEach(() => resetGlobalRuntime());

describe("Pi v0.83.0 actual extension loader", () => {
  it.each(["pi-knowledge-extension", "pi-memory-extension", "pi-context-extension"])(
    "loads %s through Pi's real loader",
    async (packageDirectory) => {
      const loaderPath = path.resolve(
        "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js",
      );
      const loader = (await import(pathToFileURL(loaderPath).href)) as PiLoader;
      const extension = path.resolve("packages", packageDirectory, "dist/index.js");
      const result = await loader.loadExtensions([extension], process.cwd());
      expect(result.errors).toEqual([]);
      expect(result.extensions).toHaveLength(1);
    },
  );

  it("rejects non-0.83.0 before any extension work", () => {
    expect(() => assertPiCompatibility("0.83.1")).toThrow(UnsupportedPiVersionError);
  });
});
