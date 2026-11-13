#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const filename=fileURLToPath(import.meta.url);
const root=path.dirname(path.dirname(filename));
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const quote=value=>`'${String(value).replaceAll("'","'\\''")}'`;
const requirements={
 callbackiq_frontend:['lint','audit:imports','test:ci','test:coverage','coverage:changed-risk',
  'test:hardening:remediation','build:certification','verify:built','audit:source-security','audit:runtime-security'],
 callbackiq_api:['lint','audit:imports','test:ordinary','test:coverage','verify:coverage-ratchet',
  'verify:diff-coverage','test:hardening','release:gate','test:replica-set',
  'test:production-certification','test:voice-concurrency','build:certification','audit:source-security','audit:runtime-security'],
};
const buildArtifacts={callbackiq_frontend:['build/index.html'],
 callbackiq_api:['build/server.js','build/app.js','build/worker.js']};

export function verificationEnvironment(packageName,base=process.env){
 if(packageName!=='callbackiq_api')return base;
 return {...base,NODE_ENV:'test',NODE_OPTIONS:base.NODE_OPTIONS || '--max-old-space-size=4096',
  MONGO_URL:'mongodb://127.0.0.1:27017/meekcall_isolated_verification',
  MONGO_URI:'mongodb://127.0.0.1:27017/meekcall_isolated_verification',
  MONGODB_URI:'mongodb://127.0.0.1:27017/meekcall_isolated_verification',
  JWT_SECRET:'synthetic-baseline-only-jwt-secret-1234567890',
  STRIPE_SECRET_KEY:'sk_test_ci_placeholder',STRIPE_WEBHOOK_SECRET:'whsec_ci_placeholder',
  TWILIO_ACCOUNT_SID:'AC00000000000000000000000000000000',TWILIO_AUTH_TOKEN:'ci-placeholder-token',
  TWILIO_API_KEY:'SK00000000000000000000000000000000',TWILIO_API_SECRET:'ci-placeholder-secret',
  TWILIO_MESSAGING_SERVICE_SID:'MG00000000000000000000000000000000',
  OPENAI_API_KEY:'inert-openai-test-certification-only',RESEND_API_KEY:'re_test_callbackiq_certification_only',
  GOOGLE_CLIENT_ID:'callbackiq-certification.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'callbackiq-certification-secret',
  TWILIO_WEBHOOK_BASE_URL:'https://ci-api.callbackiq.com',PUBLIC_API_URL:'https://ci-api.callbackiq.com',
  CLIENT_URL:'http://localhost:3001',A2P_EVENT_STREAM_USERNAME:'ci-a2p-user',A2P_EVENT_STREAM_PASSWORD:'ci-a2p-pass',
  CALLBACKIQ_CERTIFICATION_MODE:'deterministic',CALLBACKIQ_DISABLE_EXTERNAL_WRITES:'1',
  CALLBACKIQ_TEST_EXTERNAL_PROVIDER_NETWORK:'blocked'};
}

export function selectNodeRuntime(env=process.env) {
 const candidates=[env.MEEKCALL_VERIFY_NODE,env.MEEKCALL_CHECK_NODE,env.npm_node_execpath,process.execPath,
  '/opt/homebrew/opt/node@24/bin/node','/usr/local/opt/node@24/bin/node'];
 for(const candidate of [...new Set(candidates.filter(Boolean))]) {
  try {
   const version=execFileSync(candidate,['--version'],{encoding:'utf8',timeout:2000}).trim();
   const match=/^v(\d+)\.(\d+)\.(\d+)$/.exec(version);
   if(match && Number(match[1])===24 && Number(match[2])>=19)return fs.realpathSync(candidate);
  }catch{/* Try the next known runtime; never install or change shell configuration. */}
 }
 throw new Error('Checks require Node 24.19+ within Node 24 LTS. Select node@24 or set MEEKCALL_VERIFY_NODE.');
}
export function pinnedEnvironment(node,base=process.env) {
 if(process.platform==='win32')throw new Error('The check runner currently supports macOS and Linux.');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'meekcall-check-'));
 const shell=path.join(directory,'npm-shell');
 fs.writeFileSync(shell,'#!/bin/sh\n: "${MEEKCALL_CHECK_NODE:?Missing selected Node}"\nPATH="${MEEKCALL_CHECK_NODE%/*}:$PATH"\nexport PATH\nexec /bin/sh "$@"\n',{mode:0o700});
 const {FORCE_COLOR:unusedColor,...environment}=base;void unusedColor;
 return {env:{...environment,PATH:`${path.dirname(node)}${path.delimiter}${base.PATH || ''}`,
  MEEKCALL_CHECK_NODE:node,MEEKCALL_VERIFY_NODE:node,npm_config_script_shell:shell,NO_COLOR:'1'},
  dispose:()=>fs.rmSync(directory,{recursive:true,force:true})};
}
export function validatePlan(packageName,plan,aliases) {
 if(!requirements[packageName] || plan.repository!==packageName)throw new Error('Check plan does not match package.json identity.');
 for(const profile of ['check','check:release']) {
  if(!Array.isArray(plan.profiles?.[profile]) || !plan.profiles[profile].length)throw new Error(`Empty ${profile} profile`);
  for(const step of plan.profiles[profile])if(typeof aliases[step]!=='string')throw new Error(`Unknown check step: ${step}`);
 }
 for(const required of requirements[packageName])if(!plan.profiles['check:release'].includes(required))throw new Error(`Release profile omits required ${required}`);
 return plan;
}
function identity(directory) {
 try {
  const head=execFileSync('git',['rev-parse','HEAD'],{cwd:directory,encoding:'utf8'}).trim();
  const status=execFileSync('git',['status','--porcelain'],{cwd:directory,encoding:'utf8'});
  const diff=execFileSync('git',['diff','--binary','HEAD'],{cwd:directory,maxBuffer:20*1024*1024});
  const hash=crypto.createHash('sha256').update(diff);
  const untracked=execFileSync('git',['ls-files','--others','--exclude-standard','-z'],{cwd:directory,encoding:'utf8'}).split('\0').filter(Boolean).sort();
  for(const file of untracked){hash.update(file+'\0');hash.update(fs.readFileSync(path.join(directory,file)));}
  return {head,dirty:Boolean(status),diffSha256:hash.digest('hex')};
 }catch{return {head:null,dirty:true};}
}
async function execute(command,{directory,env,logfile,extra=[]}) {
 const text=command+(extra.length?' '+extra.map(quote).join(' '):'');
 const log=logfile?fs.createWriteStream(logfile):null;
 const child=spawn('/bin/sh',['-c',text],{cwd:directory,env,stdio:['inherit','pipe','pipe']});
 let tail='';
 const output=(stream,target)=>stream.on('data',chunk=>{target.write(chunk);log?.write(chunk);tail=(tail+String(chunk)).slice(-30000);});
 output(child.stdout,process.stdout);output(child.stderr,process.stderr);
 const interrupt=()=>child.kill('SIGINT');process.once('SIGINT',interrupt);
 try {return await new Promise((resolve,reject)=>{
  child.once('error',reject);child.once('close',(code,signal)=>resolve({exitCode:code ?? (signal?130:1),tail}));
 });}finally{process.removeListener('SIGINT',interrupt);if(log)await new Promise(resolve=>log.end(resolve));}
}
function verifyJest(report) {
 const result=readJson(report);
 if(!result.numTotalTests || result.numFailedTests || result.numPendingTests || result.numTodoTests ||
  result.numFailedTestSuites || result.numPendingTestSuites)throw new Error('Jest must execute tests with no failed, skipped, pending or todo cases.');
 return {suites:result.numTotalTestSuites,tests:result.numTotalTests};
}
function verifyFresh(file,started) {
 if(!fs.existsSync(file) || fs.statSync(file).mtimeMs<started-1000)throw new Error(`Missing fresh check artifact: ${file}`);
}
async function runProfile(profile,{directory,packageName,aliases,plan,env,output,base}) {
 validatePlan(packageName,plan,aliases);
 env=verificationEnvironment(packageName,env);
 if(!['check','check:release'].includes(profile))throw new Error(`Unknown profile: ${profile}`);
 fs.mkdirSync(output,{recursive:true});
 const source=identity(directory),rows=[];
 if(profile==='check:release' && (!source.head || source.dirty))throw new Error('Release checks require a committed, clean source tree so their evidence identifies an exact commit. Use check while editing.');
 const report={repository:packageName,profile,scope:'local',source,node:process.version,steps:rows,passed:false};
 for(const step of plan.profiles[profile]) {
  const started=Date.now(),name=step.replaceAll(':','-'),jestReport=path.join(output,`${name}.jest.json`);
  const jestStep=['test:ci','test:coverage','test:ordinary'].includes(step);
  const extra=jestStep?['--json','--outputFile',jestReport]:[];
  if(step==='test:coverage')for(const artifact of ['coverage-final.json','coverage-summary.json']){
   fs.rmSync(path.join(directory,'coverage',artifact),{force:true});
  }
  if(step==='build:certification')for(const artifact of buildArtifacts[packageName]){
   fs.rmSync(path.join(directory,artifact),{force:true});
  }
  console.log(`\n[${profile}] ${step}`);
  let result;
  try {
   result=await execute(aliases[step],{directory,env:{...env,...(base?{DIFF_COVERAGE_BASE:base}:{})},extra,
    logfile:path.join(output,`${name}.log`)});
   if(result.exitCode===0 && jestStep)result.jest=verifyJest(jestReport);
   if(result.exitCode===0 && step==='test:coverage'){
    verifyFresh(path.join(directory,'coverage/coverage-final.json'),started);
    verifyFresh(path.join(directory,'coverage/coverage-summary.json'),started);
   }
   if(result.exitCode===0 && step==='build:certification')for(const artifact of buildArtifacts[packageName])verifyFresh(path.join(directory,artifact),started);
   if(/(?:ℹ|#)\s*(?:skipped|todo)\s+[1-9]\d*/.test(result.tail))throw new Error('Skipped/todo Node contracts are forbidden in a release profile.');
  }catch(error){result={exitCode:1,error:error.message};console.error(error.message);}
  rows.push({step,exitCode:result.exitCode,seconds:(Date.now()-started)/1000,...(result.jest?{jest:result.jest}:{}),...(result.error?{error:result.error}:{})});
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2)+'\n');
 }
 report.passed=rows.every(row=>row.exitCode===0);
 report.finishedSource=identity(directory);
 if(JSON.stringify(source)!==JSON.stringify(report.finishedSource)){report.passed=false;report.error='Source changed while checks ran.';}
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2)+'\n');
 console.log(`${report.passed?'PASS':'FAIL'} ${profile}; results: ${path.join(output,'results.json')}`);
 return report.passed?0:1;
}
async function main() {
 const node=selectNodeRuntime();
 if(fs.realpathSync(process.execPath)!==node){
  const result=spawnSync(node,[filename,...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,MEEKCALL_CHECK_NODE:node}});
  if(result.error)throw result.error;return result.status ?? 1;
 }
 const runtime=pinnedEnvironment(node);
 try {
  const pkg=readJson(path.join(root,'package.json'));
  if(!requirements[pkg.name])throw new Error(`Unknown repository package: ${pkg.name}`);
  const aliases=readJson(path.join(root,'config/legacy-check-aliases.json'));
  const args=process.argv.slice(2);
  let profileOverride;
  if(args[0]==='--legacy'){
   const name=args[1];if(!aliases[name])throw new Error(`Unknown legacy alias ${name}`);
   console.log(`Legacy alias (${typeof aliases[name]==='string'?'subset':'full profile'}): ${name}. Authoritative profiles: npm run check / npm run check:release.`);
   if(typeof aliases[name]==='string')return (await execute(aliases[name],{directory:root,env:runtime.env,extra:args.slice(2)})).exitCode;
   profileOverride=aliases[name].profile;args.splice(0,2,profileOverride);
  }
  const profile=args[0] || 'check';let output,base;
  for(let i=1;i<args.length;i++){
   if(args[i]==='--output' && args[i+1])output=path.resolve(args[++i]);
   else if(args[i]==='--base' && args[i+1])base=args[++i];
   else throw new Error(`Unknown check option ${args[i]}`);
  }
  const stamp=new Date().toISOString().replaceAll(/[:.]/g,'-');
  output ||=path.join(root,'.verification',stamp);
  return await runProfile(profile,{directory:root,packageName:pkg.name,aliases,
   plan:readJson(path.join(root,'config/check-plan.json')),env:runtime.env,output,base});
 }finally{runtime.dispose();}
}
if(process.argv[1] && fs.realpathSync(process.argv[1])===fs.realpathSync(filename)){
 main().then(code=>{process.exitCode=code}).catch(error=>{console.error(error.message);process.exitCode=1});
}
