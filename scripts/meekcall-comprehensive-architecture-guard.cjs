#!/usr/bin/env node
'use strict';
/** Long-term architecture ratchet for the extracted modules.
 * This is a SOURCE parity and dependency check, not runtime certification.
 */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const parser=require('@babel/parser');
const traverse=require('@babel/traverse').default;
const root=path.resolve(__dirname,'..');
const cfg=JSON.parse(fs.readFileSync(path.join(root,'config/meekcall-comprehensive-architecture.json'),'utf8'));
const errors=[];
const tenantContracts=cfg.tenantCapabilityContracts;
const tenantModules=new Set((tenantContracts?.reviewedChanges || []).map(row=>row.module));
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');

// The two reviewed business-deletion methods were moved deeper
// in the directory tree. Normalize only their required import path
// for source-parity hashing; do not modify executable code or hashes.
const relocatedDeletionMethods = new Set([
  'deleteBusinessByOwner',
  'deleteBusiness',
]);
function bodyForParityHash(row, body) {
  if (
    row.module !== 'src/db/repositories/extracted/business-1.js' ||
    row.kind !== 'method' ||
    !relocatedDeletionMethods.has(row.name)
  ) return body;

  const relocated = 'await import(\n        "../../../services/businessDeletion.service.js"\n      )';
  const original = 'await import(\n        "../services/businessDeletion.service.js"\n      )';

  if (body.split(relocated).length !== 2) {
    errors.push(
      `invalid reviewed relocation: ${row.module}:${row.name}`
    );
    return body;
  }

  return body.replace(relocated, original);
}
const cache=new Map();
function read(rel){if(!cache.has(rel)){
  const p=path.join(root,rel);if(!fs.existsSync(p)){errors.push(`missing module ${rel}`);return null}
  const code=fs.readFileSync(p,'utf8');
  try{const ast=parser.parse(code,{sourceType:'unambiguous',plugins:['jsx','classProperties','classPrivateProperties','classPrivateMethods','dynamicImport']});cache.set(rel,{code,ast});}
  catch(e){errors.push(`${rel}: ${e.message}`);return null}
}return cache.get(rel)}
const grouped=new Map();for(const r of cfg.records){const a=grouped.get(r.module)||[];a.push(r);grouped.set(r.module,a)}
for(const [module,rows] of grouped){
  const file=read(module);if(!file)continue;
  if(Buffer.byteLength(file.code)>30000)errors.push(`oversized extracted module ${module}`);
  if(!tenantModules.has(module) && !cfg.reviewedModuleImports?.[module] && /^\s*(?:import\s|(?:const|var)\s+\w+\s*=\s*require\()/m.test(file.code))errors.push(`extracted module has direct imports: ${module}; dependencies must remain injected`);
  if(cfg.reviewedModuleImports?.[module])traverse(file.ast,{ImportDeclaration(p){
    if(!cfg.reviewedModuleImports[module].includes(p.node.source.value))errors.push(`unreviewed dependency: ${module}:${p.node.source.value}`);
  }});
  const found=[];
  traverse(file.ast,{
    ObjectMethod(p){if(!p.parentPath?.isObjectExpression()||!p.parentPath?.parentPath?.isReturnStatement())return;const key=p.node.key?.name;if(key)found.push({name:key,kind:'method',text:file.code.slice(p.node.body.start,p.node.body.end)})},
    VariableDeclaration(p){if(p.node.declarations.length===1&&p.node.declarations[0].id.type==='Identifier')found.push({name:p.node.declarations[0].id.name,kind:'declaration',text:file.code.slice(p.node.start,p.node.end)})},
    VariableDeclarator(p){if(p.node.id.type==='Identifier'&&p.node.init?.type==='ArrowFunctionExpression')found.push({name:p.node.id.name,kind:'callback',text:file.code.slice(p.node.init.start,p.node.init.end)})}
  });
  for(const row of rows){const hits=found.filter(f=>f.name===row.name&&f.kind===row.kind);
    if(hits.length!==1)errors.push(`${module}: ${row.kind}:${row.name} expected once, found ${hits.length}`);
    else if(hash(bodyForParityHash(row,hits[0].text))!==row.sha)errors.push(`extracted body changed: ${module}:${row.name}. Rebaseline only after behavioral review.`);
  }
}
const owners={
  'src/db/repositories/extracted/':'src/db/db.js',
  'src/services/scheduling/commands/':'src/services/scheduling/appointment.service.js',
  'src/services/scheduling/reschedule/':'src/services/scheduling/appointment.service.js',
  'src/services/booking/inquiry/':'src/services/booking/bookingStateMachine.service.js',
  'src/features/conversations/':'src/pages/Conversations.js',
};
for(const r of cfg.records){const pair=Object.entries(owners).find(([prefix])=>r.module.startsWith(prefix));if(!pair)errors.push(`unknown architecture boundary ${r.module}`)}
if(tenantContracts){
 for(const module of tenantModules){
  const file=read(module);if(!file)continue;
  traverse(file.ast,{ImportDeclaration(p){if(!tenantContracts.allowedImports.includes(p.node.source.value))errors.push(`unreviewed tenant dependency: ${module}:${p.node.source.value}`);}});
  for(const row of tenantContracts.reviewedChanges.filter(row=>row.module===module&&row.retired)){
   traverse(file.ast,{ObjectMethod(p){if(p.node.key.name===row.name)errors.push(`retired ID-only owner capability restored: ${module}:${row.name}`);}});
  }
 }
 if(!errors.length){
  const {spawnSync}=require('node:child_process'),os=require('node:os');
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'tenant-contracts-'));
  try{
   const output=path.join(folder,'results.json');
   const run=spawnSync(process.execPath,[path.join(root,'node_modules/jest/bin/jest.js'),'--runInBand','--runTestsByPath',...tenantContracts.tests,'--json',`--outputFile=${output}`],{cwd:root,env:process.env,encoding:'utf8',timeout:600000,maxBuffer:16*1024*1024});
   if(run.error||run.status!==0)errors.push('tenant behavioral contracts failed: '+(run.error?.message||run.stderr));
   else{
    const result=JSON.parse(fs.readFileSync(output));
    if(!result.success||result.numPendingTests||result.numTodoTests||result.numPendingTestSuites||!result.numPassedTests)errors.push('tenant contracts must pass with no skipped or todo tests');
    else console.log(`PASS: ${result.numPassedTests} tenant behavioral contracts across ${result.numPassedTestSuites} suites`);
   }
  }finally{fs.rmSync(folder,{recursive:true,force:true});}
 }
}
if(errors.length){errors.forEach(e=>console.error('FAIL:',e));process.exitCode=1}
else console.log(`PASS: ${cfg.records.length} unchanged source-parity contracts across ${grouped.size} modules; reviewed tenant changes require executable contracts`);
console.log('Source parity alone does not certify production workflow correctness.');
