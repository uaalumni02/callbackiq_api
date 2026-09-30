import { findDateRange, parseTimePreference, formatTimePreferenceLabel } from '../../src/services/booking/appointmentPreferenceParser.service.js';
import { captureTurnFacts } from '../../src/services/booking/turnFactCapture.service.js';
import { classifySmsIntent } from '../../src/services/messaging/smsIntentClassifier.service.js';
import { detectSafetyHazardType } from '../../src/helpers/ai/aiGuardrails.js';
import { isCallbackRequest } from '../../src/voice/voiceInput.service.js';
import { buildHumanHandoffAcknowledgement, ensureHumanHandoffResult } from '../../src/services/messaging/smsHandoff.service.js';

const now = new Date('2026-09-29T16:00:00-04:00');
const business = { timezone: 'America/New_York' };

describe('customer truth hardening', () => {
  test.each([
    ['Friday next week at 10 am', '2026-10-09'],
    ['Friday of next week at 10 am', '2026-10-09'],
    ['the Friday after next at 10 am', '2026-10-16'],
    ['next Tuesday after 3', '2026-10-06'],
  ])('resolves named weekdays before generic week ranges: %s', (text, expected) => {
    expect(findDateRange(text, business.timezone, now)).toEqual({ startDate: expected, endDate: expected });
  });

  test.each([
    "Don't call me",
    'Do not call me',
    'No need to call me',
    "Please don't phone me",
    "I don't want a callback",
    'Text me instead',
    'Stop calling me',
  ])('does not invert declined callback intent: %s', (text) => {
    const result = classifySmsIntent({ customerMessage: text, business, now });
    expect(result.intents.callbackDeclined).toBe(true);
    expect(result.intents.callback).toBe(false);
    expect(result.intents.human).toBe(false);
    expect(result.intents.service).toBe(false);
    expect(result.intents.correction).toBe(false);
    expect(isCallbackRequest(text)).toBe(false);
  });

  test('keeps explicit human request while callback is declined', () => {
    const result = classifySmsIntent({ customerMessage: "Don't call me, but connect me with a human here.", business, now });
    expect(result.intents.callback).toBe(false);
    expect(result.intents.human).toBe(true);
  });



  test('declined callback language cannot be restored by handoff presentation', () => {
    const text = "Don't call me";
    const result = { messageCategory: 'human_requested', reply: '' };
    const acknowledgement = buildHumanHandoffAcknowledgement({
      business: { ...business, businessName: 'Atlanta Pro Plumbing & Drain' },
      lead: { serviceNeeded: 'faucet repair' },
      conversation: {},
      result,
      customerMessage: text,
    });
    expect(acknowledgement).not.toMatch(/callback request/i);
    const hardened = ensureHumanHandoffResult({
      business: { ...business, businessName: 'Atlanta Pro Plumbing & Drain' },
      lead: { serviceNeeded: 'faucet repair' },
      conversation: { customerPhone: '+14045551212' },
      result,
      customerMessage: text,
    });
    expect(hardened.handoff.callbackRequested).toBe(false);
  });

  test.each([
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
  ])('uses clause-aware safety negation: %s', (text, expected) => {
    expect(detectSafetyHazardType(text)).toBe(expected);
  });

  test('stores a canonical time preference without service/address contamination', () => {
    const text = 'It is my bathroom sink at 123 Pine Street Atlanta GA 30324 and Tuesday after 4 would be great.';
    const facts = captureTurnFacts({ customerMessage: text, business, lead: {}, now });
    expect(facts.address).toMatch(/123 Pine Street/i);
    expect(facts.preferredAppointmentTime).toBe('2026-10-06 at after 4:00 PM');
    expect(facts.preferredAppointmentTime).not.toMatch(/bathroom|sink|pine|atlanta/i);
  });

  test.each([
    ['Tuesday after 4', 'after 4:00 PM'],
    ['Tuesday before 10 am', 'before 10:00 AM'],
    ['Tuesday around 3', 'around 3:00 PM'],
    ['Tuesday late afternoon', 'afternoon'],
  ])('formats normalized time evidence: %s', (text, expected) => {
    expect(formatTimePreferenceLabel(parseTimePreference(text, business.timezone, now))).toBe(expected);
  });
});
