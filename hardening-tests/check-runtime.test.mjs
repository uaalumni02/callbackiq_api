import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validatePlan,verificationEnvironment} from '../scripts/check.mjs';

test('canonical API verification replaces inherited provider credentials with inert fixtures',()=>{
 const inherited={NODE_ENV:'production',STRIPE_SECRET_KEY:'fixture-live-key-sentinel',TWILIO_AUTH_TOKEN:'fixture-live-token-sentinel',
  MONGOMS_SYSTEM_BINARY:'/fixture/mongod'};
 const selected=verificationEnvironment('callbackiq_api',inherited);
 assert.equal(selected.NODE_ENV,'test');assert.equal(selected.STRIPE_SECRET_KEY,'sk_test_ci_placeholder');
 assert.equal(selected.TWILIO_AUTH_TOKEN,'ci-placeholder-token');assert.equal(selected.MONGOMS_SYSTEM_BINARY,'/fixture/mongod');
 assert.equal(selected.CALLBACKIQ_TEST_EXTERNAL_PROVIDER_NETWORK,'blocked');
 assert.equal(inherited.NODE_ENV,'production','Do not mutate the caller environment');
});

test('an npm lifecycle cannot shadow the selected Node with an ancestor/local binary',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'arbitrary-checkout-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const directory of ['scripts','config','node_modules/.bin'])fs.mkdirSync(path.join(root,directory),{recursive:true});
 fs.copyFileSync(fileURLToPath(new URL('../scripts/check.mjs',import.meta.url)),path.join(root,'scripts/check.mjs'));
 fs.writeFileSync(path.join(root,'node_modules/.bin/node'),'#!/bin/sh\necho SHADOWED_NODE_21 >&2\nexit 78\n',{mode:0o700});
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'callbackiq_frontend',scripts:{probe:'node -p process.version'}}));
 fs.writeFileSync(path.join(root,'config/legacy-check-aliases.json'),JSON.stringify({nested:'npm run probe'}));
 // Reproduce the unguarded shell even when this regression runs inside the repaired gate.
 const broken=spawnSync('npm',['run','probe'],{cwd:root,encoding:'utf8',env:{...process.env,npm_config_script_shell:'/bin/sh'}});
 assert.equal(broken.status,78);assert.match(broken.stderr,/SHADOWED_NODE_21/);
 const repaired=spawnSync(process.execPath,[path.join(root,'scripts/check.mjs'),'--legacy','nested'],{cwd:root,encoding:'utf8'});
 assert.equal(repaired.status,0,repaired.stderr);assert.match(repaired.stdout,/v24\.\d+\.\d+/);assert.doesNotMatch(repaired.stderr,/SHADOWED/);
 assert.equal(fs.existsSync(path.join(root,'.npmrc')),false);
});
test('release plans cannot silently omit coverage, imports, or hardening',()=>{
 const steps=['lint','audit:imports','test:ci','test:coverage','coverage:changed-risk','test:hardening:remediation',
  'build:certification','verify:built','audit:source-security','audit:runtime-security'];
 const aliases=Object.fromEntries(steps.map(step=>[step,'true']));
 for(const omitted of ['test:coverage','audit:imports','test:hardening:remediation','audit:source-security']){
  assert.throws(()=>validatePlan('callbackiq_frontend',{repository:'callbackiq_frontend',
   gates:[{name:'Required',steps:steps.filter(step=>step!==omitted)}],advisory:[omitted]},aliases),/omits required/);
 }
 assert.throws(()=>validatePlan('renamed-folder',{repository:'callbackiq_frontend',profiles:{}},aliases),/package.json identity/);
});
test('a dirty source tree cannot receive a release certificate',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dirty-certificate-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'scripts'));fs.mkdirSync(path.join(root,'config'));
 fs.copyFileSync(fileURLToPath(new URL('../scripts/check.mjs',import.meta.url)),path.join(root,'scripts/check.mjs'));
 const steps=['lint','audit:imports','test:ci','test:coverage','coverage:changed-risk','test:hardening:remediation','build:certification','verify:built','audit:source-security','audit:runtime-security'];
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'callbackiq_frontend'}));
 fs.writeFileSync(path.join(root,'.gitignore'),'.verification/\n');
 fs.writeFileSync(path.join(root,'config/check-plan.json'),JSON.stringify({repository:'callbackiq_frontend',gates:[{name:'Required',steps}],advisory:[]}));
 fs.writeFileSync(path.join(root,'config/legacy-check-aliases.json'),JSON.stringify(Object.fromEntries(steps.map(step=>[step,'true']))));
 const git=(...args)=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
 git('init','-q');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');git('add','.');git('commit','-qm','fixture');
 fs.writeFileSync(path.join(root,'unsafe.js'),'throw new Error("uncommitted");');
 const result=spawnSync(process.execPath,[path.join(root,'scripts/check.mjs') ],{encoding:'utf8'});
 assert.equal(result.status,1);assert.match(result.stderr,/committed, clean source tree/);
});

// macOS temp directories commonly resolve /var through /private/var.
test('the CLI executes through a symlinked checkout and still rejects dirty release source',t=>{
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'check-cli-link-'));
 t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 const real=path.join(parent,'real');fs.mkdirSync(real);fs.mkdirSync(path.join(real,'scripts'));
 fs.mkdirSync(path.join(real,'config'));
 fs.copyFileSync(fileURLToPath(new URL('../scripts/check.mjs',import.meta.url)),path.join(real,'scripts/check.mjs'));
 fs.writeFileSync(path.join(real,'package.json'),JSON.stringify({name:'callbackiq_frontend'}));
 const steps=['lint','audit:imports','test:ci','test:coverage','coverage:changed-risk','test:hardening:remediation','build:certification','verify:built','audit:source-security','audit:runtime-security'];
 fs.writeFileSync(path.join(real,'config/check-plan.json'),JSON.stringify({repository:'callbackiq_frontend',gates:[{name:'Required',steps}],advisory:[]}));
 fs.writeFileSync(path.join(real,'config/legacy-check-aliases.json'),JSON.stringify({...Object.fromEntries(steps.map(step=>[step,'true'])),probe:'node -p process.version'}));
 const alias=path.join(parent,'alias');fs.symlinkSync(real,alias,'dir');
 const probe=spawnSync(process.execPath,[path.join(alias,'scripts/check.mjs'),'--legacy','probe'],{encoding:'utf8'});
 assert.equal(probe.status,0,probe.stderr);assert.match(probe.stdout,/v24\.\d+\.\d+/);
 const release=spawnSync(process.execPath,[path.join(alias,'scripts/check.mjs') ],{encoding:'utf8'});
 assert.equal(release.status,1);assert.match(release.stderr,/committed, clean source tree/);
});
