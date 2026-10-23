import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const auditScript = path.resolve('scripts/audit-repository-hygiene.mjs');
function runFixture(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meekcall-hygiene-test-'));
  try {
    function git(...args) {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 8000 });
      assert.equal(r.status, 0, r.stderr);
    }
    git('init', '-q');
    fs.writeFileSync(path.join(dir, 'example.mjs'), contents);
    git('add', 'example.mjs');
    const result = spawnSync(process.execPath, [auditScript, '--strict'], { cwd: dir, encoding: 'utf8', timeout: 10000 });
    return { code: result.status, report: JSON.parse(result.stdout), stderr: result.stderr };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('repository hygiene allows a local credential-free MongoDB test fixture', () => {
  const result = runFixture("const url = 'mongodb://127.0.0.1:27017/example_ci';\n");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.report.clean, true);
});

test('repository hygiene rejects credential-bearing MongoDB URI, including reserved hosts', () => {
  const scheme = 'mongodb' + '+srv://';
  const result = runFixture(`const url = '${scheme}notreal:notreal@cluster.test.invalid/test';\n`);
  assert.equal(result.code, 2);
  assert.ok(result.report.findings.some(x => x.credential === 'MONGODB_URI'));
});

test('repository hygiene rejects a non-placeholder direct credential assignment', () => {
  const key = ['OPENAI', 'API', 'KEY'].join('_');
  const result = runFixture(`const ${key} = 'nonplaceholder-secret-value';\n`);
  // The scanner intentionally recognizes assignment form regardless of declaration.
  assert.equal(result.code, 2);
  assert.ok(result.report.findings.some(x => x.credential === key));
});
