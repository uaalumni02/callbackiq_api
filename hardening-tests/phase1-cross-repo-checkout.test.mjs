import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const workflow = readFileSync('.github/workflows/browser-workflows.yml','utf8');
test('API browser checkout uses explicit credential and preserves both checkout directories', () => {
  assert.match(workflow, /name: Verify cross-repository checkout credential/);
  assert.match(workflow, /secrets\.MEEKCALL_CROSS_REPO_TOKEN/);
  assert.doesNotMatch(workflow, /CALLBACKIQ_CROSS_REPO_READ_TOKEN|\|\| github\.token/);
  assert.match(workflow, /repository: uaalumni02\/callbackiq_frontend/);
  assert.match(workflow, /path: api/);
  assert.match(workflow, /path: frontend/);
  assert.match(workflow, /npm run test:browser/);
});
