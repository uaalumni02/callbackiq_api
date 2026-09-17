import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const run = extra => spawnSync(process.execPath, ['perf/voice-relay-transport-load.mjs'], {
 env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', OPENAI_API_KEY: 'sk-offline', JWT_SECRET: 'offline',
  VOICE_TRANSPORT_CLIENTS: '6', VOICE_TRANSPORT_CONCURRENCY: '6', VOICE_TRANSPORT_TURNS: '2', VOICE_TRANSPORT_AGENT_DELAY_MS: '10',
  VOICE_TRANSPORT_TIMEOUT_MS: '1000', ...extra }, encoding: 'utf8', timeout: 15000,
});
const report = result => JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
test('transport runs without MongoDB and validates all identities and cleanup', () => {
 const result=run({});assert.equal(result.status,0,result.stderr);const r=report(result);
 assert.equal(r.businessesExercised,6);assert.equal(r.completedTurns,12);assert.equal(r.productionCertified,false);
 assert.equal(r.queueWaitMs.count,12);assert.equal(r.finalAdmission.sessions,0);assert.equal(r.finalAdmission.turns,0);
});
test('rejected handshakes fail promptly without leaked sockets or a hanging process',()=>{
 const result=run({VOICE_TRANSPORT_SESSION_LIMIT:'1'});assert.equal(result.status,1,result.stderr);assert.equal(result.signal,null);
 const r=report(result);assert.ok(r.failures>0);assert.equal(r.finalAdmission.sessions,0);
});

test('paced connections retain the full active cohort before sending any turns', () => {
 const result=run({VOICE_TRANSPORT_CONNECT_CONCURRENCY:'1'});assert.equal(result.status,0,result.stderr);
 const r=report(result);assert.equal(r.connectConcurrency,1);assert.equal(r.peakSessions,6);
 assert.deepEqual(r.cohorts,[{requested:6,connected:6,activeAtStart:6,minimumActiveDuringTurns:6}]);
});
test('multiple cohorts fully drain and cover every requested client', () => {
 const result=run({VOICE_TRANSPORT_CLIENTS:'13',VOICE_TRANSPORT_CONNECT_CONCURRENCY:'2'});assert.equal(result.status,0,result.stderr);
 const r=report(result);assert.deepEqual(r.cohorts.map(x=>x.activeAtStart),[6,6,1]);
 assert.equal(r.businessesExercised,13);assert.equal(r.completedTurns,26);assert.equal(r.finalAdmission.sessions,0);
});
