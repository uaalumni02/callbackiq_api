#!/usr/bin/env node
/** Offline, read-only verification of MeekCall certification repair wiring. */
import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd();
const checks=[
  ['tests/browser/customerStaff.browser.js', [
    "import { MongoMemoryReplSet } from 'mongodb-memory-server';",
    "MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })",
    "serviceNeeded: 'HVAC repair - air conditioner not cooling'"
  ], ["MongoMemoryServer.create()"]],
  ['.github/workflows/browser-workflows.yml', ["vars.CALLBACKIQ_FRONTEND_REF || 'main'"],['998a89366203f183e7a0a0bb41912c46ac6a668d']],
  ['src/services/serviceEligibility/serviceEligibility.service.js', ['REQUEST_QUALIFICATION_REQUIRED'],[]],
  ['src/services/businessRequestWorkflow.service.js', ['withRequestStateTransaction'],[]],
  ['src/services/booking/requestStateTransaction.service.js', ['mongoose.connection.transaction', 'transactions.run'],[]],
];
let failures=0;
for(const [file,required,forbidden] of checks){
 const pathname=path.join(root,file);
 let src='';try{src=fs.readFileSync(pathname,'utf8')}catch(e){console.error(`FAIL ${file}: missing file`);failures++;continue;}
 const missing=required.filter(s=>!src.includes(s)),present=forbidden.filter(s=>src.includes(s));
 if(missing.length||present.length){console.error(`FAIL ${file}: missing ${missing.length}, forbidden ${present.length}`);failures++;}
 else console.log(`PASS ${file}`);
}
if(failures){process.exitCode=1;console.error(`${failures} certification checks failed.`);}
else console.log('Read-only certification structure checks passed. This does not certify runtime behavior.');
