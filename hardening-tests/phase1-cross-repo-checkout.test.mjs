import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const workflow = readFileSync('.github/workflows/browser-workflows.yml', 'utf8');

test('API browser checkout supports public partner with read-only fallback and runs E2E', () => {
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /repository: uaalumni02\/callbackiq_frontend/);
  assert.match(workflow, /token: \$\{\{ secrets\.CALLBACKIQ_CROSS_REPO_READ_TOKEN \|\| github\.token \}\}/);
  assert.doesNotMatch(workflow, /name: Verify cross-repository checkout credential/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /path: api/);
  assert.match(workflow, /path: frontend/);
  assert.match(workflow, /Record exact API and frontend revisions/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /npm run test:browser/);
});
