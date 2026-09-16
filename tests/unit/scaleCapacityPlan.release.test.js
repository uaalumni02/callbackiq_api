import {validateCapacityPlan,freshObservation} from '../../src/config/scaleCapacityPlan.js';
const plan=()=>({schemaVersion:1,apiSha:'a'.repeat(40),providerMode:'live',observedAt:new Date().toISOString(),observedBy:'test',evidenceRef:'fixture',target:{businesses:1001,voiceSessions:350,smsPerSecond:200},utilization:.65,
 smsSamples:['normal','slow-provider'].map(scenario=>({scenario,completedJobs:1000,durationMs:300000,processingP95Ms:2000,evidenceRef:'fixture'})),
 providerDemand:{aiRequestsPerSms:1,aiTokensPerSms:1000,voiceTurnsPerSecond:35,aiRequestsPerVoiceTurn:1,aiTokensPerVoiceTurn:1000,smsSegmentsPerJob:1,otherAiRequestsPerMinute:0,otherAiTokensPerMinute:0,otherAiConcurrent:0},
 providerQuota:{aiRequestsPerMinute:100000,aiTokensPerMinute:100000000,smsSegmentsPerSecond:1000,voiceSessions:450,aiConcurrent:2000,evidenceRef:'fixture',observedAt:new Date().toISOString()}});
test('measured target budgets combine SMS and voice load with one spare SMS worker',()=>{
 expect(validateCapacityPlan(plan(),{apiSha:'a'.repeat(40)})).toMatchObject({errors:[],requiredReplicas:26});
 const p=plan();p.smsSamples[1].processingP95Ms=4000;expect(validateCapacityPlan(p).requiredReplicas).toBe(51);
});
test.each(['schemaVersion','apiSha','providerMode','observedAt','observedBy','evidenceRef','target','smsSamples','providerDemand','providerQuota','utilization'])('missing %s blocks approval',key=>{
 const p=plan();delete p[key];expect(validateCapacityPlan(p).errors.length).toBeGreaterThan(0);
});
test('quota shortages and stale observations remain errors',()=>{
 const p=plan();p.providerQuota={aiRequestsPerMinute:1,aiTokensPerMinute:1,smsSegmentsPerSecond:1,voiceSessions:1,aiConcurrent:1,observedAt:'2000-01-01'};
 expect(validateCapacityPlan(p,{apiSha:'b'.repeat(40)}).errors.length).toBeGreaterThan(4);
 expect(freshObservation('invalid')).toBe(false);expect(freshObservation(new Date(Date.now()+600000).toISOString())).toBe(false);
 expect(validateCapacityPlan(undefined).errors.length).toBeGreaterThan(0);
});
