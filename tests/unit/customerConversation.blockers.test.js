import { classifyInboundSmsCommand } from '../../src/services/messaging/contactPreference.service.js';
import { isSoftOptOutPhrase } from '../../src/services/messaging/smsCompliance.service.js';
import { parseTimePreference, formatTimePreferenceLabel, filterSlotsByTimePreference } from '../../src/services/booking/appointmentPreferenceParser.service.js';

test.each(['Yes', 'YES', 'yes!', 'Yes please'])('ordinary affirmation reaches conversation: %s', text => {
  expect(classifyInboundSmsCommand(text).handled).toBe(false);
});
test('provider-confirmed resubscription remains authoritative', () => {
  expect(classifyInboundSmsCommand('YES', { twilioOptOutType: 'START' })).toMatchObject({ handled: true, action: 'opt_in' });
});
test.each(['stop please', 'Stop, please.', 'please stop', 'stop texting me'])('honors opt-out: %s', text => {
  expect(isSoftOptOutPhrase(text)).toBe(true);
  expect(classifyInboundSmsCommand(text)).toMatchObject({ handled: true, action: 'opt_out' });
});
test.each(['how do I stop the leak?', 'stop leaking please', 'do not stop texting me', 'cancel my appointment'])('does not invent opt-out: %s', text => {
  expect(isSoftOptOutPhrase(text)).toBe(false);
});
test.each(['ASAP', 'as soon as possible', 'soonest', 'first available', '2026-10-06 through 2026-10-20 at as soon as possible', 'tomorrow ASAP'])('urgency is not midnight: %s', text => {
  const preference = parseTimePreference(text);
  expect(preference.exactMinutes).toBeNull();
  expect(preference.targetMinutes).toBeNull();
  expect(formatTimePreferenceLabel(preference)).toBe('as soon as possible');
  const slots = [{ startAt: '2026-10-06T14:00:00Z' }, { startAt: '2026-10-06T18:00:00Z' }];
  expect(filterSlotsByTimePreference(slots, preference, 'America/New_York')).toEqual(slots);
});

import { detectSafetyHazardType } from '../../src/helpers/ai/aiGuardrails.js';
import { voiceSafetyAssessment } from '../../src/services/voiceSafetyReview.service.js';
import { assessInboundSafety } from '../../src/services/safetyAssessmentService.js';
import { classifyOperationalUrgency } from '../../src/services/scheduling/customerSchedulingIntent.service.js';

test.each(['My toilet is overflowing', 'The pipe burst', 'pipe burst', 'burst pipe'])('urgent repair continues through voice preflight: %s', async text => {
  expect(detectSafetyHazardType(text)).toBe('');
  expect(voiceSafetyAssessment(text)).toBeNull();
  expect(classifyOperationalUrgency(text)).toBe('high');
  expect((await assessInboundSafety({ customerMessage: text })).isEmergency).toBe(false);
});
test.each(['My toilet is overflowing and water is near electrical equipment', 'The pipe burst and my kitchen is flooding', 'Water is pouring through the ceiling', 'I smell gas', 'Someone is trapped'])('danger retains safety escalation: %s', text => {
  expect(voiceSafetyAssessment(text)?.category).toBe('emergency');
});
