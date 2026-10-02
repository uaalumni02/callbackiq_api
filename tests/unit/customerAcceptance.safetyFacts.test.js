import { detectSafetyHazardType, evaluateDeterministicInboundGuardrails } from '../../src/helpers/ai/aiGuardrails.js';
import { extractCustomerAddress } from '../../src/services/booking/customerAddress.service.js';
import { captureTurnFacts } from '../../src/services/booking/turnFactCapture.service.js';
import { classifySmsIntent } from '../../src/services/messaging/smsIntentClassifier.service.js';
import VoiceUnderstanding from '../../src/voice/voiceUnderstanding.service.js';
import AlertService from '../../src/services/alert.service.js';

const affirmative = [
 ['There is no fire, the kitchen is flooded', 'flood'],
 ['There is no flooding, I smell gas', 'gas'],
 ['There is no flooding, we smell gas', 'gas'],
 ['There is no gas smell, smoke is coming from the outlet', 'fire'],
 ['My kitchen has no power, water is pouring across the floor', 'flood'],
 ['My basement is not flooded and my kitchen is flooded', 'flood'],
 ['My kitchen is not flooded, my basement is flooded', 'flood'],
 ['My kitchen sink is clogged there is no leaking or flooding but the panel is sparking', 'electrical'],
 ["We have no heat and my newborn is in the house and it's freezing", 'temperature'],
 ['There is a heat wave and we have no AC, my elderly mother lives here', 'temperature'],
 ['The roof is not leaking but the ceiling is collapsing', 'structural'],
 ['The tree is touching the power lines', 'electrical'],
 ['My baby is locked inside the car', 'trapped'],
 ['Sewage is backing up into the shower', 'sewage'],
 ["I smell gas and my wife can't breathe", 'medical'],
];
const negative = [
 'My kitchen sink is clogged there is no leaking or flooding',
 'There is no smoke, fire or sparking',
 'My bathroom has neither leaking nor flooding',
 'The kitchen is not flooded and the basement is not flooded',
 'No the kitchen is not flooding',
 'I need a smoke detector installed',
 'My fireplace needs cleaning',
 'The gas leak was repaired last week',
];
afterEach(() => jest.restoreAllMocks());
test.each(affirmative)('affirmed hazard remains visible: %s', (text, hazard) => {
 expect(detectSafetyHazardType(text)).toBe(hazard);
 expect(evaluateDeterministicInboundGuardrails({ customerMessage: text }).category).toBe('emergency');
});
test.each(negative)('denied or routine hazards do not become emergencies: %s', text => {
 expect(detectSafetyHazardType(text)).toBe('');
});
test.each(affirmative)('voice uses the same deterministic safety decision: %s', async (customerMessage, hazard) => {
 const oldKey = process.env.OPENAI_API_KEY;
 delete process.env.OPENAI_API_KEY;
 try {
  const result = await VoiceUnderstanding.classifyVoiceTurn({ customerMessage });
  expect(result.safety.isEmergency).toBe(true);
  expect(result.safety.hazardType).toBe(hazard);
 } finally { if (oldKey !== undefined) process.env.OPENAI_API_KEY = oldKey; }
});
test.each([
 ['123 Main St Atlanta GA 30303 Apt 4. Can someone come Tuesday?', '123 Main St Atlanta GA 30303 Apt 4'],
 ['123 Main St Atlanta GA 30303 # 4', '123 Main St Atlanta GA 30303 # 4'],
 ['123 Main St Atlanta GA 30303-1234 Apt 4', '123 Main St Atlanta GA 30303-1234 Apt 4'],
 ['Water is pouring through the ceiling! 12 Oak Ln Atlanta GA 30301', '12 Oak Ln Atlanta GA 30301'],
 ['56566 Road Way Atlanta GA 30323. Can someone come next Tuesday?', '56566 Road Way Atlanta GA 30323'],
])('captures a bounded address: %s', (text, address) => expect(extractCustomerAddress(text)).toBe(address));
test.each([
 ["It's the bathroom sink, not the kitchen sink", 'My bathroom sink is clogged'],
 ['not the kitchen sink, the bathroom sink', 'My bathroom sink is clogged'],
])('correction is classified as a correction as well as extracted: %s', (text, expected) => {
 const c = classifySmsIntent({ customerMessage: text, lead: { serviceNeeded: 'My kitchen sink is clogged' } });
 expect(c.entities.serviceNeeded).toBe(expected);
 expect(c.intents.correction).toBe(true);
});
test('a date-only correction preserves the previously supplied clock time', () => {
 const facts = captureTurnFacts({ customerMessage: 'Actually next Wednesday instead', business: { timezone: 'America/New_York' },
  lead: { preferredAppointmentTime: '2026-09-22 at 14:00' }, now: new Date('2026-09-17T21:00:00-04:00') });
 expect(facts.preferredAppointmentTime).toBe('2026-09-23 at 2:00 PM');
});
test('a time-only correction preserves the previously supplied day', () => {
 const facts = captureTurnFacts({ customerMessage: 'Actually 4 pm instead', business: { timezone: 'America/New_York' },
  lead: { preferredAppointmentTime: '2026-09-22 at 14:00' }, now: new Date('2026-09-17T21:00:00-04:00') });
 expect(facts.preferredAppointmentTime).toBe('2026-09-22 at 4:00 PM');
});
test('handoff refuses to report success when no durable alert is returned', async () => {
 jest.spyOn(AlertService, 'create').mockResolvedValue({ alert: null, created: false });
 await expect(AlertService.createHumanHandoffAlert({ businessId: 'b', conversationId: 'c' }))
  .rejects.toMatchObject({ code: 'STAFF_ACTION_NOT_SAVED' });
});
test('an existing durable deduplicated alert is a successful handoff', async () => {
 jest.spyOn(AlertService, 'create').mockResolvedValue({ alert: { _id: 'saved' }, created: false });
 await expect(AlertService.createHumanHandoffAlert({ businessId: 'b', conversationId: 'c' }))
  .resolves.toMatchObject({ alert: { _id: 'saved' } });
});

test.each([
 ['56566 Road Way Atlanta GA 30323', '30323'],
 ['56566 Road Way', ''],
 ['123 Main St Atlanta GA 30303-1234 Apt 4', '30303'],
 ['30323', '30323'],
])('postal extraction never uses the street number: %s', (text, zip) => {
 const { extractCustomerPostalCode } = require('../../src/services/booking/customerAddress.service.js');
 expect(extractCustomerPostalCode(text)).toBe(zip);
});
test('a ZIP correction preserves the five-digit street number', () => {
 const { addressFromTurn, withoutCustomerPostalCode } = require('../../src/services/booking/customerAddress.service.js');
 expect(addressFromTurn({ customerMessage: 'Actually ZIP 30324', knownAddress: '56566 Road Way Atlanta GA 30323' }))
  .toBe('56566 Road Way Atlanta GA 30324');
 expect(withoutCustomerPostalCode('56566 Road Way Atlanta GA 30323')).toBe('56566 Road Way Atlanta GA');
});
