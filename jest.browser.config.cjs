const base = require('./package.json').jest;
module.exports = { ...base, testMatch: ['<rootDir>/tests/browser/**/*.browser.js'], testTimeout: 30000,
  setupFiles: ['<rootDir>/tests/browser/setup.cjs'], maxWorkers: 1 };
