/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  plugins: ["@stryker-mutator/vitest-runner"],
  mutate: [
    "packages/memory/src/safety.ts",
    "packages/retrieval/src/algorithms.ts",
    "packages/retrieval/src/gates.ts",
  ],
  testRunner: "vitest",
  vitest: {
    configFile: "vitest.stryker.config.ts",
    related: true,
  },
  coverageAnalysis: "perTest",
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: {
    fileName: ".artifacts/test-reports/mutation.json",
  },
  thresholds: {
    high: 90,
    low: 80,
    break: 80,
  },
  timeoutMS: 5_000,
  concurrency: 8,
  tempDirName: ".stryker-tmp",
};
