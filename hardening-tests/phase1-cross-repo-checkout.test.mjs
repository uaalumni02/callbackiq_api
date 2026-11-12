import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
test('the actual cross-repository checkout boundary is read-only, pins both trees, and builds before E2E',()=>{
 const workflow=yaml.safeLoad(fs.readFileSync('.github/workflows/browser-workflows.yml','utf8'));
 assert.equal(workflow.permissions.contents,'read');
 const steps=workflow.jobs.browser.steps,checkouts=steps.filter(step=>step.uses?.startsWith('actions/checkout@'));
 assert.equal(checkouts.length,2);
 assert.equal(checkouts[0].with.path,'api');assert.equal(checkouts[0].with['persist-credentials'],false);
 assert.equal(checkouts[1].with.repository,'uaalumni02/callbackiq_frontend');assert.equal(checkouts[1].with.path,'frontend');
 assert.equal(checkouts[1].with['persist-credentials'],false);
 assert.equal(checkouts[1].with.token,'${{ secrets.CALLBACKIQ_CROSS_REPO_READ_TOKEN || github.token }}');
 const record=steps.find(step=>step.name==='Record exact API and frontend revisions');assert.ok(record);
 assert.match(record.run,/git -C api rev-parse HEAD/);assert.match(record.run,/git -C frontend rev-parse HEAD/);
 const build=steps.findIndex(step=>step.run==='npm run build'),e2e=steps.findIndex(step=>step.run==='npm run test:browser');
 assert.ok(build>=0 && e2e>build);assert.equal(steps[build]['working-directory'],'frontend');assert.equal(steps[e2e]['working-directory'],'api');
});
