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
  ],
  coverageThreshold: {
    global: {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
};
