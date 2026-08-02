import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@pi-mentis/pi-mentis-core": path.join(root, "packages/core/src/index.ts"),
      "@pi-mentis/pi-mentis-inference": path.join(root, "packages/inference/src/index.ts"),
      "@pi-mentis/pi-mentis-memory-core": path.join(root, "packages/memory/src/index.ts"),
      "@pi-mentis/pi-mentis-knowledge-core": path.join(root, "packages/knowledge/src/index.ts"),
      "@pi-mentis/pi-mentis-retrieval": path.join(root, "packages/retrieval/src/index.ts"),
      "@pi-mentis/pi-mentis-zvec": path.join(root, "packages/zvec-storage/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: [
      "packages/memory/test/safety-views.property.test.ts",
      "packages/retrieval/test/algorithms.test.ts",
      "packages/retrieval/test/gates-policy.property.test.ts",
    ],
  },
});
