#!/usr/bin/env node
// MeekCall maintainability release gate. Uses only Node built-ins.
// Conservative static module graph: catches standard ESM imports/exports, dynamic
// import strings and literal CommonJS requires. It is NOT a complete JS parser.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.cwd();
const mode = process.argv[2] || '--check';
const src = path.join(root, 'src');
const baselinePath = path.join(root, 'config/meekcall-release9-architecture-baseline.json');
const clean = p => p.split(path.sep).join('/');
function walk(dir, all=[]) {
  if (!fs.existsSync(dir)) throw Error(`Missing source folder ${dir}`);
  for (const e of fs.readdirSync(dir, {withFileTypes:true})) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, all);
    else if (e.isFile() && /\.(?:js|jsx|mjs|cjs)$/.test(p) && !/\.(?:test|spec)\./.test(p) && !p.includes(`${path.sep}__tests__${path.sep}`)) all.push(clean(path.relative(root,p)));
  }
  return all;
}
const names = walk(src).sort();
const files = new Map(names.map(p=>[p,fs.readFileSync(path.join(root,p),'utf8')]));
function resolveRelative(file, specifier) {
  const base=path.posix.normalize(path.posix.join(path.posix.dirname(file),specifier));
  for(const p of [base,`${base}.js`,`${base}.jsx`,`${base}.mjs`,`${base}.cjs`,`${base}/index.js`,`${base}/index.jsx`]) if(files.has(p)) return p;
  return null;
}
function specs(s) {
  const out=[];
  // Matches complete import/export clauses, including multiline named imports.
  for (const re of [/(?:^|[;\n])\s*(?:import\s+(?:[\s\S]{0,700}?\s+from\s+)?|export\s+(?:\*|\{[\s\S]{0,700}?\})\s+from\s+)["']([^"'\n]+)["']/gm,
    /\b(?:require|import)\s*\(\s*["']([^"'\n]+)["']\s*\)/g]) {
    for (const m of s.matchAll(re)) out.push(m[1]);
  }
  return [...new Set(out)];
}
const imports=new Map();
const unresolved=[];
for(const [name,s] of files) {
  const deps=[];
  for(const literal of specs(s)) {
    if(!literal.startsWith('.')) continue;
    const d=resolveRelative(name,literal);
    if(d) deps.push(d); else unresolved.push(`${name} -> ${literal}`);
  }
  imports.set(name,[...new Set(deps)].sort());
}
const warnings=[];
// Unresolved links can legitimately be assets and mocks, so report without treating
// the regex alone as a correctness proof.
if(unresolved.length) warnings.push(`${unresolved.length} local imports could not be resolved (review separately)`);
let nextIndex=0;
const stack=[], indices=new Map(), lows=new Map(), onStack=new Set(),cycles=[];
function visit(node) {
  indices.set(node,nextIndex); lows.set(node,nextIndex++); stack.push(node); onStack.add(node);
  for(const dep of imports.get(node)||[]) {
    if(!indices.has(dep)){visit(dep);lows.set(node,Math.min(lows.get(node),lows.get(dep)))}
    else if(onStack.has(dep)) lows.set(node,Math.min(lows.get(node),indices.get(dep)));
  }
  if(lows.get(node)===indices.get(node)) {
    const scc=[];let p;
    do{p=stack.pop();onStack.delete(p);scc.push(p)}while(p!==node);
    scc.sort(); if(scc.length>1 || (imports.get(node)||[]).includes(node)) cycles.push(scc);
  }
}
for(const name of names) if(!indices.has(name)) visit(name);
cycles.sort((a,b)=>a.join('|').localeCompare(b.join('|')));
const watched = [
  'src/services/booking/bookingStateMachine.service.js',
  'src/services/booking/recoveryIntake.service.js',
  'src/services/scheduling/appointment.service.js',
  'src/services/messaging/inboundSmsJobProcessor.service.js',
  'src/services/recoveryCoordinator/recoveryCoordinator.service.js',
  'src/db/db.js',
  'src/pages/Appointments.js', 'src/pages/Conversations.js','src/pages/Billing.js',
];
const isInfrastructure=p=>/(?:^|\/)(?:models|db|controllers|workers|routes)\//.test(p);
const riskyEdges={};
for(const node of watched.filter(n=>files.has(n))) riskyEdges[node]=(imports.get(node)||[]).filter(isInfrastructure);
const pureModules=names.filter(n=>/\.(?:policy|contract)\.js$/.test(n)||n.endsWith('appointmentStatePolicy.service.js'));
const pureExceptions={};
for(const node of pureModules) {
  const edges=(imports.get(node)||[]).filter(isInfrastructure);
  if(edges.length) pureExceptions[node]=edges;
}
const sizes={};
for(const node of watched.filter(n=>files.has(n))) sizes[node]=Buffer.byteLength(files.get(node));
const current={schema:1,protectedEdges:riskyEdges,existingCycles:cycles,pureExceptions,sizes};
if(mode==='--snapshot') {
  if(fs.existsSync(baselinePath)) throw Error('Baseline already exists. Never silently rebaseline an architecture change.');
  fs.mkdirSync(path.dirname(baselinePath),{recursive:true});
  fs.writeFileSync(baselinePath,JSON.stringify({...current,approvedAtCommit:process.env.MEEKCALL_BASE_COMMIT||'installer',note:'Snapshot only; CI checks for new coupling and cycles.'},null,2)+'\n');
  console.log(`Architecture snapshot created: ${names.length} source files, ${cycles.length} existing cycles`);
  if(warnings.length) console.log('NOTE:', warnings.join('; '));
  process.exit(0);
}
if(mode!=='--check') throw Error(`Unknown mode: ${mode}`);
if(!fs.existsSync(baselinePath)) throw Error('Missing reviewed architecture baseline');
const previous=JSON.parse(fs.readFileSync(baselinePath,'utf8'));
const errors=[];
for(const [node,edges] of Object.entries(current.protectedEdges)) {
  const allowed=new Set(previous.protectedEdges?.[node]||[]);
  for(const edge of edges) if(!allowed.has(edge)) errors.push(`New cross-layer dependency ${node} -> ${edge}`);
}
const known=new Set((previous.existingCycles||[]).map(c=>c.join('|')));
for(const cycle of current.existingCycles) if(!known.has(cycle.join('|'))) errors.push(`New dependency cycle: ${cycle.join(' -> ')}`);
for(const [node,edges] of Object.entries(current.pureExceptions)) {
  const allowed=new Set(previous.pureExceptions?.[node]||[]);
  for(const edge of edges) if(!allowed.has(edge)) errors.push(`New infrastructure import in pure module: ${node} -> ${edge}`);
}
for(const [node,oldSize] of Object.entries(previous.sizes||{})) {
  if(!(node in current.sizes)) {errors.push(`Missing watched module: ${node}`);continue;}
  const growthAllowance=Math.min(512,Math.max(128,Math.ceil(oldSize*0.005)));
  if(current.sizes[node]>oldSize+growthAllowance) errors.push(`Hotspot grew ${node}: ${current.sizes[node]} > ${oldSize}+${growthAllowance}`);
}
if(errors.length) {for(const error of errors) console.error(`FAIL ${error}`);process.exitCode=1;}
else console.log(`PASS architecture regression gate: ${names.length} files, ${cycles.length} grandfathered cycles, ${Object.keys(riskyEdges).length} protected module interfaces`);
if(warnings.length) console.log('NOTE:',warnings.join('; '));
console.log('Static graph protection is not a substitute for code review, integration tests or browser certification.');
