import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../scripts/complexity-budget.cjs',import.meta.url));
function fixture(t,lines,budget){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'owned-complexity-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'src'));fs.mkdirSync(path.join(root,'config'));
 fs.writeFileSync(path.join(root,'src/file.js'),Array.from({length:lines},(_,i)=>`export const value${i}=1;`).join('\n')+'\n');
 fs.writeFileSync(path.join(root,'config/complexity-budget.json'),JSON.stringify({fileLimit:400,functionLimit:60,files:budget,functions:{}}));
 return root;
}
const run=(root,...args)=>{
 // These isolated files have no relationship to the enclosing PR's Git history.
 const env={...process.env};delete env.DIFF_COVERAGE_BASE;
 return spawnSync(process.execPath,[script,'--root',root,...args],{encoding:'utf8',env});
};
test('a now-small file cannot retain a historical exception',t=>{
 const root=fixture(t,20,{'src/file.js':450});const result=run(root);
 assert.equal(result.status,1);assert.match(result.stderr,/stale exception/);
});
test('a remaining exception must name an owner and machine-checked expiry condition',t=>{
 const root=fixture(t,410,{'src/file.js':450});const result=run(root);
 assert.equal(result.status,1);assert.match(result.stderr,/owner.*expiry/);
});
test('tightening removes obsolete exceptions and pins remaining ones to measured size',t=>{
 const root=fixture(t,410,{'src/file.js':450,'src/deleted.js':500});
 const result=run(root,'--tighten','--owner','@uaalumni02');assert.equal(result.status,0,result.stderr);
 const budget=JSON.parse(fs.readFileSync(path.join(root,'config/complexity-budget.json')));
 assert.deepEqual(Object.keys(budget.files),['src/file.js']);assert.equal(budget.files['src/file.js'].maxLines,410);
 assert.equal(budget.files['src/file.js'].owner,'@uaalumni02');assert.equal(budget.files['src/file.js'].expiresAtOrBelow,400);
 assert.equal(run(root).status,0);
});
test('tightening cannot approve growth or a new large-file exception',t=>{
 const root=fixture(t,451,{'src/file.js':450});const result=run(root,'--tighten','--owner','@uaalumni02');
 assert.equal(result.status,1);assert.match(result.stderr,/unapproved growth/);
});
test('a smaller anonymous callback cannot grow behind a larger callback allowance',t=>{
 const root=fixture(t,1,{});
 const callback=lines=>'[1].map(()=>{\n'+Array.from({length:lines-2},(_,i)=>`const item${i}=1;`).join('\n')+'\n});\n';
 fs.writeFileSync(path.join(root,'src/file.js'),callback(100)+callback(70));
 const budget={fileLimit:400,functionLimit:60,files:{},functions:{'src/file.js#<callback>':100}};
 fs.writeFileSync(path.join(root,'config/complexity-budget.json'),JSON.stringify(budget));
 const initial=run(root,'--tighten','--owner','@uaalumni02');assert.equal(initial.status,0,initial.stderr);
 fs.writeFileSync(path.join(root,'src/file.js'),callback(100)+callback(71));
 const result=run(root);assert.equal(result.status,1);assert.match(result.stderr,/allowance must equal|exceeds/);
});
