import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    extends: "./vitest.config.ts",
    test: {
      name: "unit",
      include: ["packages/*/test/**/*.test.ts"],
      exclude: ["**/*.integration.test.ts", "**/*.live.test.ts"],
    },
  },
  {
    extends: "./vitest.config.ts",
    test: {
      name: "integration",
      include: ["integration-tests/**/*.test.ts"],
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  },
  {
    extends: "./vitest.config.ts",
    test: {
      name: "live",
      include: ["integration-tests/**/*.live.test.ts"],
      testTimeout: 60_000,
    },
  },
]);
