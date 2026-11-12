import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url), results = new Map();
export function behavioralContract(suites) {
  const key = [...suites].sort().join('\n');
  if (!results.has(key)) results.set(key, execute(suites));
  return results.get(key);
}
async function execute(suites) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'meekcall-contract-')), report = path.join(directory, 'results.json');
  try {
    const outcome = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath,
        [require.resolve('jest/bin/jest'), '--runInBand', '--json', '--outputFile', report, '--runTestsByPath', ...suites],
        { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', data => { output = (output + data).slice(-30000); });
      child.stderr.on('data', data => { output = (output + data).slice(-30000); });
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Contract timeout: ${suites.join(', ')}`)); }, 240000);
      child.once('error', reject);
      child.once('close', status => { clearTimeout(timer); resolve({ status, output }); });
    });
    assert.equal(outcome.status, 0, outcome.output);
    const result = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(result.numTotalTestSuites, suites.length, 'Every named suite must execute');
    assert.ok(result.numPassedTests > 0, 'No empty contract run');
    assert.equal(result.numFailedTests, 0);
    assert.equal(result.numPendingTests, 0, 'No skipped contracts');
    assert.equal(result.numTodoTests, 0, 'No placeholder contracts');
    return result;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
