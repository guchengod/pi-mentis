import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const alias = {
  "@pi-mentis/pi-mentis-core": path.join(root, "packages/core/src/index.ts"),
  "@pi-mentis/pi-mentis-inference": path.join(root, "packages/inference/src/index.ts"),
  "@pi-mentis/pi-mentis-siliconflow": path.join(root, "packages/siliconflow-provider/src/index.ts"),
  "@pi-mentis/pi-mentis-observability": path.join(root, "packages/observability/src/index.ts"),
  "@pi-mentis/pi-mentis-zvec": path.join(root, "packages/zvec-storage/src/index.ts"),
  "@pi-mentis/pi-mentis-file-parsers": path.join(root, "packages/file-parsers/src/index.ts"),
  "@pi-mentis/pi-mentis-knowledge-core": path.join(root, "packages/knowledge/src/index.ts"),
  "@pi-mentis/pi-mentis-memory-core": path.join(root, "packages/memory/src/index.ts"),
  "@pi-mentis/pi-mentis-retrieval": path.join(root, "packages/retrieval/src/index.ts"),
  "@pi-mentis/pi-mentis-pi-capabilities": path.join(root, "packages/pi-capabilities/src/index.ts"),
};

export default defineConfig({
  resolve: {
    alias,
  },
  test: {
    globals: false,
    environment: "node",
    restoreMocks: true,
    clearMocks: true,
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts", "**/*.live.test.ts"],
          environment: "node",
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          include: ["integration-tests/**/*.integration.test.ts"],
          environment: "node",
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "live",
          include: ["integration-tests/**/*.live.test.ts"],
          environment: "node",
          testTimeout: 60_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "benchmark",
          include: ["benchmarks/**/*.bench.test.ts"],
          environment: "node",
          testTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/index.ts", "packages/*/src/types.ts"],
    },
  },
});
