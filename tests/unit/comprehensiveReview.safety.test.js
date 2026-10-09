import { evaluateDeterministicInboundGuardrails } from '../../src/helpers/ai/aiGuardrails.js';
import { classifyVoiceTurn } from '../../src/voice/voiceUnderstanding.service.js';
import { assessInboundSafety } from '../../src/services/safetyAssessmentService.js';
const savedKey = process.env.OPENAI_API_KEY;
beforeEach(() => { delete process.env.OPENAI_API_KEY; });
afterAll(() => { if (savedKey) process.env.OPENAI_API_KEY = savedKey; });
const danger = [
  ['electrical', 'The breaker panel smells like it is burning but I see no flames'],
  ['garage_door', 'My child is pinned under the garage door'],
  ['appliance_repair', 'My dryer smells like burning and is smoking'],
  ['hvac', 'The furnace is smoking'],
  ['roofing', 'The roof is collapsing'],
  ['restoration', 'Water is pouring through the ceiling'],
  ['locksmith', 'My baby is locked inside the car'],
  ['landscaping', 'A tree is touching the power line'],
  ['plumbing', 'The pipe burst and water is spreading everywhere'],
  ['other', 'Someone is trapped under the stairs'],
];
test.each(danger)('%s danger uses fixed safety in SMS preflight and voice without AI', async (_, customerMessage) => {
  const guard = evaluateDeterministicInboundGuardrails({ customerMessage });
  expect(await assessInboundSafety({ customerMessage })).toMatchObject({ isEmergency: true });
  expect(guard.hazardType).toBeTruthy(); expect(guard.reply).toMatch(/911/);
  expect(await classifyVoiceTurn({ customerMessage })).toMatchObject({ intent: 'emergency', safety: { isEmergency: true, shouldSendSafetyReply: true } });
});
test.each([
  'The breaker panel does not smell like it is burning and there is no smoke',
  'My child is not pinned under the garage door',
  'My dryer is not smoking and does not smell like burning',
  'The dryer was smoking last year but was fixed',
  'The roof leaked last year and has been repaired',
  'I am locked out of my house',
  'My sink is dripping',
])('ordinary or denied danger remains a negative control: %s', async customerMessage => {
  expect(evaluateDeterministicInboundGuardrails({ customerMessage }).hazardType).toBeFalsy();
  expect((await classifyVoiceTurn({ customerMessage })).safety.isEmergency).toBe(false);
});
test('unavailable voice classifier is explicit rather than implied model validation', async () => {
  expect(await classifyVoiceTurn({ customerMessage: 'I need an appliance inspection' })).toMatchObject({ classifierUnavailable: true, safety: { classifierUnavailable: true } });
});
