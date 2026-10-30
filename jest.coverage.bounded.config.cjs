// Jest coverage process isolation: keep original coverage contract unchanged.
// Run with --maxWorkers=1 WITHOUT --runInBand so Jest can recycle workers.
// Requires Jest 29.4.3+ for single-worker recycle support.
'use strict';
const baseline = require('./jest.coverage.config.cjs');
if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
  throw new Error('Expected an object export from jest.coverage.config.cjs');
}
module.exports = {
  ...baseline,
  maxWorkers: 1,
  workerIdleMemoryLimit: '768MB',
};
