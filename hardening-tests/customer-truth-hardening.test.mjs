import test from 'node:test';
import assert from 'node:assert/strict';

import { detectSafetyHazardType } from '../src/helpers/ai/aiGuardrails.js';
import {
  findDateRange,
  formatTimePreferenceLabel,
  parseTimePreference,
} from '../src/services/booking/appointmentPreferenceParser.service.js';
import { captureTurnFacts } from '../src/services/booking/turnFactCapture.service.js';
import { classifySmsIntent } from '../src/services/messaging/smsIntentClassifier.service.js';
import { isCallbackRequest } from '../src/voice/voiceInput.service.js';

const now = new Date('2026-09-29T16:00:00-04:00');
const business = { timezone: 'America/New_York' };

test('specific weekday evidence wins over generic relative-week ranges', () => {
  const cases = [
    ['Friday next week at 10 am', '2026-10-09'],
    ['Friday of next week at 10 am', '2026-10-09'],
    ['the Friday after next at 10 am', '2026-10-16'],
    ['next Tuesday after 3', '2026-10-06'],
  ];
  for (const [text, expected] of cases) {
    assert.deepEqual(findDateRange(text, business.timezone, now), {
      startDate: expected,
      endDate: expected,
    }, text);
  }
});

test('callback decline polarity cannot become callback, service, correction, or human takeover', () => {
  const cases = [
    "Don't call me",
    'Do not call me',
    'No need to call me',
    "Please don't phone me",
    "I don't want a callback",
    'Text me instead',
    'Stop calling me',
  ];
  for (const text of cases) {
    const result = classifySmsIntent({ customerMessage: text, business, now });
    assert.equal(result.intents.callbackDeclined, true, text);
    assert.equal(result.intents.callback, false, text);
    assert.equal(result.intents.human, false, text);
    assert.equal(result.intents.service, false, text);
    assert.equal(result.intents.correction, false, text);
    assert.equal(isCallbackRequest(text), false, `voice parity: ${text}`);
  }
  assert.equal(isCallbackRequest('Please call me back'), true);
  assert.equal(isCallbackRequest('Returning your call'), false);
});

test('an explicit human request survives a declined phone callback', () => {
  const result = classifySmsIntent({
    customerMessage: "Don't call me, but connect me with a human here.",
    business,
    now,
  });
  assert.equal(result.intents.callbackDeclined, true);
  assert.equal(result.intents.callback, false);
  assert.equal(result.intents.human, true);
});

test('safety negation is scoped to its clause, not the whole message', () => {
  const cases = [
    ['No fire, just a burning smell.', 'fire'],
    ['No flooding, just water pouring across the kitchen floor.', 'flood'],
    ['There is no flooding.', ''],
    ["I don't smell gas.", ''],
    ['There was smoke earlier but there is none now.', ''],
    ['There was smoke earlier but now it is worse.', 'fire'],
    ['There was no flooding earlier, but now it is.', 'flood'],
    ['I smelled gas earlier but I still smell it now.', 'gas'],
    ['I smelled gas earlier but there is none now.', ''],
    ['No sparks, but the outlet smells burned.', 'fire'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(detectSafetyHazardType(text), expected, text);
  }
});

test('compound intake persists only normalized appointment-preference evidence', () => {
  const text = 'It is my bathroom sink at 123 Pine Street Atlanta GA 30324 and Tuesday after 4 would be great.';
  const facts = captureTurnFacts({ customerMessage: text, business, lead: {}, now });
  assert.match(facts.address, /123 Pine Street/i);
  assert.equal(facts.preferredAppointmentTime, '2026-10-06 at after 4:00 PM');
  assert.doesNotMatch(facts.preferredAppointmentTime, /bathroom|sink|pine|atlanta/i);
});

test('stored time labels are canonical rather than raw customer messages', () => {
  const cases = [
    ['Tuesday after 4', 'after 4:00 PM'],
    ['Tuesday before 10 am', 'before 10:00 AM'],
    ['Tuesday around 3', 'around 3:00 PM'],
    ['Tuesday late afternoon', 'afternoon'],
  ];
  for (const [text, expected] of cases) {
    const parsed = parseTimePreference(text, business.timezone, now);
    assert.equal(formatTimePreferenceLabel(parsed), expected, text);
  }
});
