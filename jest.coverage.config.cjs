module.exports = {
  rootDir: ".",
  watchman: false,
  testEnvironment: "node",
  transform: {
    "^.+\\.js$": "babel-jest",
  },
  setupFiles: ["<rootDir>/jest.setup.js"],
  clearMocks: true,
  restoreMocks: true,
  collectCoverage: true,
  coverageProvider: "v8",
  coverageDirectory: "coverage",
  coverageReporters: ["text", "text-summary", "json-summary", "lcov", "html"],
  collectCoverageFrom: [
    "src/**/*.js",
    "!src/server.js",
    "!src/worker.js",
    "!src/**/__mocks__/**",
  ],
  testPathIgnorePatterns: [
    "/node_modules/",
    "<rootDir>/tools/api_overlay/",
    "<rootDir>/hardening-tests/",
    "<rootDir>/tools/",
    "<rootDir>/.callbackiq-",
    "<rootDir>/callbackiq[^/]*_update/",
    "<rootDir>/CallBackIQ[^/]*(?:Update|Bundle)/",
    "\\.bak$",
    "\\.backup",
    "/tests/integration/trialRedemptionReplicaSet\\.concurrency\\.test\\.js$",
  ],
  coverageThreshold: {
    global: {
      branches: 45,
      functions: 50,
      lines: 60,
      statements: 60,
    },
  },
};

// Ignore installer rollback backups
for (const key of ["testPathIgnorePatterns","modulePathIgnorePatterns","watchPathIgnorePatterns"]) {
  module.exports[key] = [...new Set([
    ...(module.exports[key] || []),
    "<rootDir>/[.]callbackiq-[^/]*backup[^/]*/"
  ])];
}
