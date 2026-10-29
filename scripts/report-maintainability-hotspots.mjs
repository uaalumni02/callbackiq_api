#!/usr/bin/env node
// Read-only structural signal report; no claims about correctness, performance, or 9/10 readiness.
import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd();
const role=fs.existsSync('src/services/booking/bookingStateMachine.service.js')?'api':'frontend';
const files=role==='api' ? [
 ['Booking state machine','src/services/booking/bookingStateMachine.service.js'],
 ['Appointment lifecycle','src/services/scheduling/appointment.service.js'],
 ['Database facade','src/db/db.js'],
 ['SMS processor','src/services/messaging/inboundSmsJobProcessor.service.js'],
] : [
 ['Appointments UI','src/pages/Appointments.js'],
 ['Billing UI','src/pages/Billing.js'],
 ['Conversations UI','src/pages/Conversations.js'],
];
const count=(text,regexp)=>(text.match(regexp)||[]).length;
const metrics=files.map(([name,file])=>{
  if(!fs.existsSync(file))throw Error(`Missing expected hotspot ${file}`);
  const s=fs.readFileSync(path.join(root,file),'utf8');
  return {name,file,bytes:Buffer.byteLength(s),lines:s.split('\n').length,
    importDeclarations:count(s,/^import\s/gm),awaitExpressions:count(s,/\bawait\s/g),
    reactStateHooks:count(s,/\buseState\(/g),reactEffectHooks:count(s,/\buseEffect\(/g),
    reactApiCalls:count(s,/\bapiFetch\(/g),mongooseSaveCalls:count(s,/\.save\(/g)};
});
if(process.argv.includes('--json'))console.log(JSON.stringify({role,generatedFor:'working-tree',metrics},null,2));
else {
 console.log(`# MeekCall maintainability hotspots: ${role}`);
 console.log('Measurements are only structural signals, NOT quality scores or proof of behavior.');
 console.log('| Component | KiB | Lines | Imports | await | useState | apiFetch | save |');
 console.log('|---|---:|---:|---:|---:|---:|---:|---:|');
 for(const m of metrics)console.log(`| ${m.name} | ${(m.bytes/1024).toFixed(1)} | ${m.lines} | ${m.importDeclarations} | ${m.awaitExpressions} | ${m.reactStateHooks} | ${m.reactApiCalls} | ${m.mongooseSaveCalls} |`);
 console.log('\nRisk: shared transaction boundaries, implicit side effects, cross-layer imports and state ownership require manual review.');
}
