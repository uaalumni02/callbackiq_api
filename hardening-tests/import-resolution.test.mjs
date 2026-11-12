import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditImports } from '../scripts/import-graph-audit.mjs';

function fixture(source) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'renamed-repository-'));
  for (const name of ['src/services/booking/bookingClassification.policy.js',
    'src/services/booking/bookingConversation.repository.js', 'src/db/repositories/userIdentityRepository.js']) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), 'export const valid = true;');
  }
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'callbackiq_api' }));
  writeFileSync(path.join(root, 'src/entry.js'), source);
  return root;
}
for (const [kind, source] of Object.entries({
  static: "import './missing.js';", reexport: "export * from './missing.js';",
  dynamic: "export const load = () => import('./missing.js');",
  template: 'export const load = () => import(`./missing.js`);', require: "const load = require('./missing.js');",
})) test(`a broken ${kind} target fails without executing the import`, () => {
  const root = fixture(source);
  try { assert.throws(() => auditImports(root), /entry.js:1: missing target/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
test('package identity works in an arbitrarily named checkout; comments are not imports', () => {
  const root = fixture("// import './missing.js'\nexport const load = () => import('./services/booking/bookingConversation.repository.js');");
  try { assert.equal(auditImports(root).literalDynamicImports, 1); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
