import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const audit=fileURLToPath(new URL('../scripts/security-repository-audit.mjs',import.meta.url));
for(const repository of ['callbackiq_api','callbackiq_frontend'])test(`security evidence identifies ${repository} from its manifest in a renamed checkout`,t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'unrelated-folder-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:repository}));
 execFileSync('git',['init','-q'],{cwd:root});execFileSync('git',['add','package.json'],{cwd:root});
 const result=spawnSync(process.execPath,[audit],{cwd:root,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout.split(/\nSecurity repository audit /)[0]).repository,repository);
});
