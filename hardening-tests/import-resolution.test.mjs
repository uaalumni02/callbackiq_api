import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditImports } from '../scripts/import-graph-audit.mjs';

function fixture(source,repository='callbackiq_api') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'renamed-repository-'));
  const protectedFiles=repository==='callbackiq_api' ? ['src/services/booking/bookingClassification.policy.js',
    'src/services/booking/bookingConversation.repository.js','src/db/repositories/userIdentityRepository.js'] :
    ['src/features/billing/createBillingSubscriptionActions.js','src/features/billing/createSupportTicketActions.js',
    'src/features/appointments/createSchedulingLeadPrefillEffect.js','src/features/conversations/createManualReplyAction.js'];
  for (const name of protectedFiles) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), 'export const valid = true;');
  }
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: repository }));
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

test('literal dynamic imports in engineering scripts fail when their local targets are missing',()=>{
 const root=fixture('export const valid=true;');
 try {mkdirSync(path.join(root,'scripts'));writeFileSync(path.join(root,'scripts/check.mjs'),"export const load=()=>import('./missing-gate.mjs');");
  assert.throws(()=>auditImports(root),/scripts.check.mjs:1: missing target/);
 }finally{rmSync(root,{recursive:true,force:true})}
});
for(const source of ["export const load=()=>import('./Panel');","const panel=require('./Panel');"]){
 test(`frontend resolution supports JSX without an extension: ${source}`,()=>{
  const root=fixture(source,'callbackiq_frontend');
  try {writeFileSync(path.join(root,'src/Panel.jsx'),'export default ()=> <span/>;');assert.equal(auditImports(root).repository,'callbackiq_frontend');}
  finally{rmSync(root,{recursive:true,force:true})}
 });
}
