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
  if(/^\s*(?:import\s|(?:const|var)\s+\w+\s*=\s*require\()/m.test(file.code))errors.push(`extracted module has direct imports: ${module}; dependencies must remain injected`);
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
  'src/services/booking/inquiry/':'src/services/booking/bookingStateMachine.service.js',
  'src/features/conversations/':'src/pages/Conversations.js',
};
for(const r of cfg.records){const pair=Object.entries(owners).find(([prefix])=>r.module.startsWith(prefix));if(!pair)errors.push(`unknown architecture boundary ${r.module}`)}
if(errors.length){errors.forEach(e=>console.error('FAIL:',e));process.exitCode=1}
else console.log(`PASS: ${cfg.records.length} source-exact domain extractions checked across ${grouped.size} modules; no direct module imports`);
console.log('This checks source parity, not production workflow correctness.');
