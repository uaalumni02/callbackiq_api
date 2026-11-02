import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveDiffCoverageBase, assertNoUntrackedSources } from './diff-coverage-base.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meekcall-diff-base-'));
try {
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'ci@example.invalid');
  git(root, 'config', 'user.name', 'CI Test');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'existing.js'), 'export const a=1;\n');
  git(root, 'add', 'src/existing.js');
  git(root, 'commit', '-qm', 'baseline');
  const baseline = git(root, 'rev-parse', 'HEAD');
  git(root, 'update-ref', 'refs/remotes/origin/development', baseline);
  git(root, 'checkout', '-qb', 'architecture/test');
  fs.writeFileSync(path.join(root, 'src', 'existing.js'), 'export const a=2;\n');
  git(root, 'add', 'src/existing.js');
  git(root, 'commit', '-qm', 'architecture change');
  test('architecture branch compares against the development merge-base', () => {
    assert.equal(resolveDiffCoverageBase({cwd:root,env:{}}), baseline);
  });
  test('explicit valid base is shared and preserved', () => {
    assert.equal(resolveDiffCoverageBase({cwd:root,env:{DIFF_COVERAGE_BASE:baseline}}), baseline);
  });
  test('invalid explicit CI base fails closed instead of falling back to HEAD^', () => {
    assert.throws(()=>resolveDiffCoverageBase({cwd:root,env:{DIFF_COVERAGE_BASE:'0000000000000000000000000000000000000000'}}), /Invalid DIFF_COVERAGE_BASE/);
  });
  test('untracked production files block a misleading pass', () => {
    fs.writeFileSync(path.join(root,'src','new-module.js'),'export default 1;\n');
    assert.throws(()=>assertNoUntrackedSources({cwd:root}), /Untracked production files/);
    fs.rmSync(path.join(root,'src','new-module.js'));
    assert.doesNotThrow(()=>assertNoUntrackedSources({cwd:root}));
  });
} finally {
  process.on('exit',()=>fs.rmSync(root,{recursive:true,force:true}));
}
