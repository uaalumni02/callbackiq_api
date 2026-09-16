import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { capacityFixture } from './capacityFixtures.mjs';
import { validateCapacityPlan } from '../src/config/scaleCapacityPlan.js';
import { validateOperationalEvidence } from '../perf/operational-evidence.mjs';
import { verifyScaleCertificate, REQUIRED_OBSERVATIONS } from '../perf/certificate.mjs';
import { OWNER_READ_ROUTES } from '../perf/owner-read-workload.mjs';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const image = `example/app@sha256:${'b'.repeat(64)}`;
const operational = (start = Date.now() - 310000) => ({ startedAt: new Date(start).toISOString(), endedAt: new Date(start + 300000).toISOString(), durationMs: 300000,
  apiSha: 'a'.repeat(40), uiSha: 'c'.repeat(40), providerMode: 'live', capacityPlanSha256: 'd'.repeat(64), imageDigest: image,
  failures: 0, sms: { failures: 0 }, fleetSampleFailures: 0,
  outcomes: {missing:0,incomplete:0,wrongTenant:0,duplicateReplies:0,uncertain:0}, voice: {harnessFailures:0,aiTurnFailures:0,unexpectedEnds:0},
  fleetSamples: Array.from({length:61}, (_, i) => ({ observedAt: new Date(start + i * 5000).toISOString(), timestamp: new Date(start + i * 5000).toISOString(),
    healthy: true, releases: ['a'.repeat(40)], capacityPlans: ['d'.repeat(64)], images: [image], smsOldestAgeMs: 1000, recoveryOldestAgeMs: 0, failedPages: 0, uncertainEmail: 0 })) });
test('capacity plan combines voice and SMS demand and sizes the worst measured scenario', () => {
  const plan = capacityFixture();
  assert.deepEqual(validateCapacityPlan(plan).errors, []);
  assert.equal(validateCapacityPlan(plan).requiredReplicas, 26);
  plan.smsSamples[1].processingP95Ms = 4000;
  assert.equal(validateCapacityPlan(plan).requiredReplicas, 51);
  plan.providerQuota.aiRequestsPerMinute = 13000; // SMS alone fits at 100%; combined demand does not.
  assert.ok(validateCapacityPlan(plan).errors.includes('combined provider budget: aiRequestsPerMinute'));
});
test('missing, stale, mismatched and zero measurements cannot render a valid plan', () => {
  for (const mutate of [p => {p.smsSamples=[];}, p => {p.observedAt='2000-01-01';}, p => {p.providerMode='';}, p => {p.providerDemand.aiTokensPerSms=0;}, p => {p.utilization=1;}]) {
    const p = capacityFixture(); mutate(p); assert.ok(validateCapacityPlan(p).errors.length);
  }
  assert.ok(validateCapacityPlan(capacityFixture(), {apiSha:'f'.repeat(40)}).errors.length);
});
test('fleet samples enforce queue age, immutable identity, coverage and freshness', () => {
  assert.deepEqual(validateOperationalEvidence(operational()), []);
  for (const mutate of [r => {r.fleetSamples=[];}, r => {r.fleetSamples[3].smsOldestAgeMs=10001;}, r => {delete r.fleetSampleFailures;},
    r => {r.fleetSamples[3].capacityPlans=['e'.repeat(64)];}, r => {r.fleetSamples.splice(2,4);}, r => {r.startedAt='2000-01-01';}]) {
    const r=operational(); mutate(r); assert.ok(validateOperationalEvidence(r).length);
  }
});
test('renderer rejects missing measurements, insufficient replicas and connection budgets', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capacity-render-'));
  try {
    const plan=path.join(dir,'plan.json'); await fs.writeFile(plan,JSON.stringify(capacityFixture()));
    const env={...process.env, RELEASE_SHA:'a'.repeat(40), SCALE_IMAGE:image, SCALE_INGRESS_HOST:'test.example.com', SCALE_TLS_SECRET:'test-tls',
      SCALE_DEPLOYMENT_FILE:path.join(dir,'deployment.json'), SCALE_CAPACITY_PLAN:plan, SCALE_MONGO_CONNECTION_BUDGET:'2000'};
    const run = extra => spawnSync(process.execPath,['deploy/scale/render.mjs'],{env:{...env,...extra}});
    assert.notEqual(run({SCALE_CAPACITY_PLAN:''}).status,0);
    assert.notEqual(run({SCALE_REPLICAS_WORKER_SMS:'12'}).status,0);
    assert.notEqual(run({SCALE_MONGO_CONNECTION_BUDGET:'100'}).status,0);
    const ok=run({}); assert.equal(ok.status,0,ok.stderr.toString());
    const d=JSON.parse(await fs.readFile(env.SCALE_DEPLOYMENT_FILE));
    assert.equal(d.items.find(x=>x.metadata.name==='callbackiq-worker-sms'&&x.kind==='Deployment').spec.replicas,26);
    assert.equal(d.items.find(x=>x.kind==='ConfigMap').data.SCALE_MONGO_DECLARED_CONNECTIONS,'1380');
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
async function fixture(root) {
  const write = async (name, value) => {const bytes=JSON.stringify(value); await fs.writeFile(path.join(root,name),bytes); return {path:name,sha256:hash(bytes)};};
  const plan=await write('plan.json',capacityFixture());
  const attachment=await write('observation.json',{synthetic:true});
  const e={schemaVersion:2,apiSha:'a'.repeat(40),uiSha:'c'.repeat(40),capacityPlan:plan,mixedReports:[],queryReports:[],
    infrastructure:{imageDigest:image,topology:attachment},checks:{}};
  for(const name of REQUIRED_OBSERVATIONS)e.checks[name]={passed:true,observedAt:new Date().toISOString(),observedBy:'unit-test',apiSha:e.apiSha,uiSha:e.uiSha,attachment};
  const start=Date.now()-3700000;
  for(let i=0;i<12;i++){
    const r={...operational(start+i*300000),schemaVersion:2,runId:`test-${i}`,tenants:1001,minimumDashboards:1001,childExitCodes:[0,0,0,0],dashboardP95Ms:500,
      voice:{harnessFailures:0,aiTurnFailures:0,unexpectedEnds:0,accepted:350,activeAtTurnStart:350,minimumActiveDuringWork:350,completedAiTurns:7000,workDurationMs:300000,aiTurnLatencyMs:{p95:2000,p99:3000},aiTurnsPerAcceptedClient:20,acceptanceErrors:[]},
      sms:{requests:60000,requestsPerSecond:200,failures:0,latencyMs:{p95:100,p99:200}},
      outcomes:{checked:60000,missing:0,incomplete:0,wrongTenant:0,duplicateReplies:0,uncertain:0,providerAcceptanceP95Ms:1000},
      ownerReads:Object.fromEntries(OWNER_READ_ROUTES.map(k=>[k,{count:1001,failures:0,p95Ms:500,p99Ms:1000}]))};
    r.capacityPlanSha256=plan.sha256;r.fleetSamples.forEach(s=>s.capacityPlans=[plan.sha256]);
    e.mixedReports.push(await write(`mixed-${i}.json`,r));
  }
  for(let i=0;i<2;i++)e.queryReports.push(await write(`query-${i}.json`,{release:e.apiSha,observedAt:new Date().toISOString(),counts:{leads:i?100000:1000},queries:
    ['owner-workflow-summary','owner-status-summary','owner-page','lead-search-miss','customer-messages'].map(name=>({name,measured:true,elapsedMs:100,plans:[{stage:'IXSCAN'}]}))}));
  await fs.writeFile(path.join(root,'acceptance.json'),JSON.stringify(e));
  return {e,write,save:()=>fs.writeFile(path.join(root,'acceptance.json'),JSON.stringify(e))};
}
test('certificate binds reports and observations; rejects tampering, overlap, and missing proof',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'certificate-'));
 try{
   const {e,write,save}=await fixture(root);
   let result=await verifyScaleCertificate(root);assert.equal(result.passed,true,JSON.stringify(result.errors));
   e.checks.noisySmsTenant.passed=false;await save();assert.equal((await verifyScaleCertificate(root)).passed,false);
   e.checks.noisySmsTenant.passed=true;await save();
   const original=await fs.readFile(path.join(root,'mixed-0.json'),'utf8');
   await fs.writeFile(path.join(root,'mixed-0.json'),original+' ');assert.equal((await verifyScaleCertificate(root)).passed,false);
   await fs.writeFile(path.join(root,'mixed-0.json'),original);
   const second=JSON.parse(await fs.readFile(path.join(root,'mixed-1.json')));const first=JSON.parse(original);
   second.startedAt=first.startedAt;second.endedAt=first.endedAt;second.fleetSamples=first.fleetSamples;
   e.mixedReports[1]=await write('mixed-1.json',second);await save();
   assert.ok((await verifyScaleCertificate(root)).errors.some(x=>x.includes('overlap')));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
