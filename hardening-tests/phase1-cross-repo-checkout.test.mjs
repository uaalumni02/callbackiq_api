import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';

test('paired release checks out exact commits with a private read-only sibling token', () => {
  const workflow = yaml.safeLoad(fs.readFileSync('.github/workflows/browser-workflows.yml', 'utf8'));
  const steps = workflow.jobs.pair.steps;
  const checkouts = steps.filter(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(checkouts.length, 3);
  assert.equal(checkouts[1].with.ref, '${{ steps.release.outputs.apiSha }}');
  assert.equal(checkouts[2].with.ref, '${{ steps.release.outputs.frontendSha }}');
  assert.equal(checkouts[2].with.repository, 'uaalumni02/callbackiq_frontend');
  assert.equal(checkouts[2].with.token, '${{ secrets.CALLBACKIQ_CROSS_REPO_READ_TOKEN }}');
  assert.ok(checkouts.every(step => step.with['persist-credentials'] === false));
  assert.ok(steps.findIndex(step => step.id === 'release') < steps.indexOf(checkouts[2]));
  assert.match(steps.find(step => step.id === 'release').run, /exit 1/);
  const runner = fs.readFileSync('scripts/verify-release.mjs', 'utf8');
  assert.ok(runner.indexOf("'run', 'verify'") < runner.indexOf("'run', 'test:browser'"));
  assert.match(runner, /'scripts\/migrate-required-indexes\.mjs', '--check'/);
});
