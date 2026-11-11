#!/usr/bin/env node
// Read-only static import graph audit. Covers relative ESM imports and CommonJS requires;
// dynamic imports, computed requires and resolver aliases require separate manual review.
import fs from 'node:fs';
import path from 'node:path';
import "node:child_process";
const walk=d=>fs.existsSync(d)?fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):/\.(?:js|jsx|mjs|cjs)$/.test(e.name)?[path.join(d,e.name)]:[]):[];
const files=walk('src').map(x=>x.replaceAll('\\','/'));
const available=new Set(files);
const graph=new Map();
const dependencies=/(?:\bimport\s+(?:[\s\S]{0,200}?\bfrom\s*)?|\bexport\s+[^;\n]{0,200}?\bfrom\s*|\brequire\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g;
for(const file of files){
 const content=fs.readFileSync(file,'utf8');
 const deps=[];
 for(const m of content.matchAll(dependencies)){
  const rel=m[1]; const raw=path.posix.normalize(path.posix.join(path.posix.dirname(file),rel));
  const target=[raw,raw+'.js',raw+'.jsx',raw+'.mjs',raw+'/index.js',raw+'/index.jsx'].find(x=>available.has(x));
  if(target) deps.push(target);
 }
 graph.set(file,[...new Set(deps)].sort());
}
// The included extracted modules must not create an import cycle, even when the
// preexisting repository contains legacy cycles. We do not hide legacy cycles.
const required = process.cwd().endsWith('callbackiq_api') ? [
 'src/services/booking/bookingClassification.policy.js',
 'src/services/booking/bookingConversation.repository.js',
 'src/db/repositories/userIdentityRepository.js'
] : [
 'src/features/billing/createBillingSubscriptionActions.js',
 'src/features/billing/createSupportTicketActions.js',
 'src/features/appointments/createSchedulingLeadPrefillEffect.js',
 'src/features/conversations/createManualReplyAction.js'
];
const pathBack=(start,target,visited=new Set())=>{
 if(start===target) return [target];
 if(visited.has(start)) return null;
 visited.add(start);
 for(const next of graph.get(start)||[]){const hit=pathBack(next,target,visited);if(hit)return [start,...hit]}
 return null;
};
for(const file of required){
 if(!available.has(file)) throw Error('Missing extracted module '+file);
 for(const dep of graph.get(file)||[]){const cycle=pathBack(dep,file);if(cycle)throw Error('New module participates in dependency cycle: '+[file,...cycle].join(' -> '));}
}
const data={files:files.length,localImportEdges:[...graph.values()].reduce((n,arr)=>n+arr.length,0),hotspots:{}};
for(const file of ['src/services/booking/bookingStateMachine.service.js','src/services/scheduling/appointment.service.js','src/db/db.js','src/pages/Billing.js','src/pages/Conversations.js','src/pages/Appointments.js']){
 if(!available.has(file))continue;
 const s=fs.readFileSync(file,'utf8');
 data.hotspots[file]={lines:s.split('\n').length,bytes:Buffer.byteLength(s),directLocalImports:(graph.get(file)||[]).length,awaits:(s.match(/\bawait\b/g)||[]).length,reactStateHooks:(s.match(/\buseState\s*\(/g)||[]).length};
}
console.log(JSON.stringify(data,null,2));
console.log('PASS: extracted modules introduce no relative-import cycles');
