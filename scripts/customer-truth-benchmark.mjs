import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectSafetyHazardType } from '../src/helpers/ai/aiGuardrails.js';
import {
  findDateRange,
  formatTimePreferenceLabel,
  parseTimePreference,
} from '../src/services/booking/appointmentPreferenceParser.service.js';
import { captureTurnFacts } from '../src/services/booking/turnFactCapture.service.js';
import { classifySmsIntent } from '../src/services/messaging/smsIntentClassifier.service.js';
import { isCallbackRequest } from '../src/voice/voiceInput.service.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/customerTruthAdversarial.json'), 'utf8'));
const now = new Date(fixture.anchorNow);
const business = { timezone: fixture.timezone };
const results = [];

const record = (group, name, fn) => {
  try {
    const details = fn();
    results.push({ group, name, pass: true, details });
  } catch (error) {
    results.push({ group, name, pass: false, error: error?.message || String(error) });
  }
};
const equal = (actual, expected, label) => {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
};

for (const testCase of fixture.scheduling) record('scheduling', testCase.text, () => {
  const range = findDateRange(testCase.text, business.timezone, now);
  equal(range?.startDate, testCase.date, 'date');
  equal(range?.endDate, testCase.date, 'date range');
  const label = formatTimePreferenceLabel(parseTimePreference(testCase.text, business.timezone, now));
  equal(label, testCase.time, 'time');
  return { range, time: label };
});

for (const testCase of fixture.callback) record('callback', testCase.text, () => {
  const classification = classifySmsIntent({ customerMessage: testCase.text, business, now });
  equal(classification.intents.callback, testCase.requested, 'SMS callback requested');
  equal(classification.intents.callbackDeclined, testCase.declined, 'SMS callback declined');
  equal(classification.intents.human, testCase.human, 'human handoff');
  if (testCase.declined) {
    equal(classification.intents.service, false, 'declined callback must not become service');
    equal(classification.intents.correction, false, 'declined callback must not become correction');
  }
  equal(isCallbackRequest(testCase.text), testCase.requested, 'Voice callback requested');
  return { intents: classification.intents };
});

for (const testCase of fixture.safety) record('safety', testCase.text, () => {
  const hazard = detectSafetyHazardType(testCase.text);
  equal(hazard, testCase.hazard, 'hazard');
  return { hazard };
});

for (const testCase of fixture.compound) record('compound', testCase.text, () => {
  const facts = captureTurnFacts({ customerMessage: testCase.text, business, lead: {}, now });
  if (!new RegExp(testCase.addressIncludes, 'i').test(facts.address || '')) throw new Error(`address missing ${testCase.addressIncludes}`);
  equal(facts.preferredAppointmentTime, testCase.preference, 'preference');
  if (new RegExp(testCase.preferenceMustNotMatch, 'i').test(facts.preferredAppointmentTime || '')) throw new Error('preference contains unrelated customer facts');
  return facts;
});

const byGroup = Object.fromEntries([...new Set(results.map((item) => item.group))].map((group) => {
  const groupResults = results.filter((item) => item.group === group);
  return [group, { total: groupResults.length, passed: groupResults.filter((item) => item.pass).length, failed: groupResults.filter((item) => !item.pass).length }];
}));
const report = {
  benchmarkVersion: 1,
  anchorNow: fixture.anchorNow,
  timezone: fixture.timezone,
  total: results.length,
  passed: results.filter((item) => item.pass).length,
  failed: results.filter((item) => !item.pass).length,
  byGroup,
  failures: results.filter((item) => !item.pass),
};
console.log(JSON.stringify(report, null, 2));
if (report.failed) process.exitCode = 1;
