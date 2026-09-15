import test from 'node:test';
import assert from 'node:assert/strict';
import { validateVoiceReport, validateMixedReport } from '../perf/acceptance.mjs';
import { validateScaleProfile } from '../src/config/scaleProfile.js';
const voice = { accepted: 350, activeAtTurnStart: 350, minimumActiveDuringWork: 350, completedAiTurns: 7000, workDurationMs: 300000, aiTurnLatencyMs: { p95: 2000, p99: 3000 } };
const limits = { expected: 350, turns: 20, ai: true, minDurationMs: 300000 };
test('voice acceptance rejects early end, missing turns, brief disconnects, latency and short runs', () => {
  assert.deepEqual(validateVoiceReport(voice, limits), []);
  for (const change of [{ unexpectedEnds: 1 }, { completedAiTurns: 6999 }, { minimumActiveDuringWork: 349 }, { workDurationMs: 299999 }, { aiTurnLatencyMs: { p95: 6000, p99: 12000 } }]) assert.ok(validateVoiceReport({ ...voice, ...change }, limits).length);
});
test('mixed acceptance rejects 200 ACKs with no business outcomes', () => {
  const report = { schemaVersion: 2, tenants: 1001, minimumDashboards: 1001, durationMs: 300000, childExitCodes: [0,0,0,0], dashboardP95Ms: 500,
    voice: { ...voice, aiTurnsPerAcceptedClient: 20, acceptanceErrors: [] }, sms: { requests: 60000, requestsPerSecond: 200, failures: 0, latencyMs: { p95: 100, p99: 200 } },
    outcomes: { checked: 60000, missing: 0, incomplete: 0, wrongTenant: 0, duplicateReplies: 0, uncertain: 0, providerAcceptanceP95Ms: 5000 } };
  assert.deepEqual(validateMixedReport(report), []);
  for (const change of [{ outcomes: undefined }, { outcomes: { ...report.outcomes, wrongTenant: 1 } }, { outcomes: { ...report.outcomes, checked: 100 } }, { minimumDashboards: 1000 }, { voice: null }]) assert.ok(validateMixedReport({ ...report, ...change }).length);
});
test('profile is opt-in and rejects missing dependencies and single-instance capacity', () => {
  assert.deepEqual(validateScaleProfile({}), { enabled: false, errors: [] });
  assert.ok(validateScaleProfile({ SCALE_PROFILE: 'business-1000-voice-350', PROCESS_ROLE: 'all' }).errors.length > 5);
});
