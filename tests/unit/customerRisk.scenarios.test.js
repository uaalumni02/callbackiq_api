import { ensureAutomatedAssistantDisclosure } from "../../src/voice/voiceRouting.service.js";
import { buildMissedCallRecoveryText } from "../../src/services/messaging/smsCompliance.service.js";
import { buildSmsRecoveryVoicePrompt } from "../../src/voice/smsRecoveryVoicePrompt.service.js";
import { assessSafetyContext, detectSafetyHazardType, evaluateDeterministicInboundGuardrails, getEmergencyReply, normalizeSmsReply, validateOutboundReply } from '../../src/helpers/ai/aiGuardrails.js';
import { classifyVoiceTurn } from '../../src/voice/voiceUnderstanding.service.js';
import { classifyOperationalUrgency } from '../../src/services/scheduling/customerSchedulingIntent.service.js';

const hazards = [
  ['My wife passed out and I smell gas', 'medical'],
  ['The generator is running inside the garage', 'gas'],
  ['We are using a charcoal grill indoors', 'gas'],
  ['The CO alarm is going off', 'gas'],
  ['I smell gas. What is your price?', 'gas'],
  ['The oven has flames coming out', 'fire'],
  ['A tree is touching the power lines', 'electrical'],
  ['The breaker box is submerged', 'electrical'],
  ['Water is dripping onto an outlet', 'electrical'],
  ['The ceiling is bulging', 'structural'],
  ['The garage door is hanging loose', 'structural'],
  ['My baby is locked inside the car', 'trapped'],
  ['My dog got locked in the hot car', 'trapped'],
  ['Water is flowing onto the carpet', 'flood'],
  ['The pipe burst and my kitchen is flooding', 'flood'],
  ['Raw sewage is coming up in the shower', 'sewage'],
  ['The furnace has stopped working and we have a newborn', 'temperature'],
  ['The oxygen concentrator has lost power', 'temperature'],
  ['Someone is threatening us', 'other'],
  ['I want to hurt myself', 'other'],
];
const routine = [
  'Can you install a carbon monoxide detector?',
  'I need smoke detectors installed',
  'What does a smoke alarm replacement cost?',
  'I need a fire pit installed',
  'Do you perform smoke testing for drains?',
  'The baby is not locked inside',
  'The ceiling is not collapsing',
  'Water is not flowing onto the floor',
  'No smoke or fire',
  'I do not smell gas',
  'The tree is not touching the power lines',
  'My garage door needs maintenance',
  '911 Main Street',
  'Do you offer emergency appointments?',
  'My child locked the bathroom door but everyone is outside',
];
const oldKey = process.env.OPENAI_API_KEY;
beforeAll(() => { delete process.env.OPENAI_API_KEY; });
afterAll(() => { if (oldKey) process.env.OPENAI_API_KEY = oldKey; });

test.each(hazards)('SMS and voice refer current danger without business promises: %s', async (customerMessage, type) => {
  expect(detectSafetyHazardType(customerMessage)).toBe(type);
  const sms = evaluateDeterministicInboundGuardrails({ customerMessage });
  const voice = await classifyVoiceTurn({ customerMessage });
  expect(sms).toMatchObject({ category: 'emergency', hazardType: type, shouldAlertOwner: true });
  expect(voice.safety).toMatchObject({ isEmergency: true, hazardType: type });
  expect(voice.safety.reply).toBe(sms.reply);
  expect(sms.reply).toMatch(/does not monitor emergencies or dispatch emergency help/);
  expect(sms.reply).toMatch(/Do not wait/);
  expect(sms.reply).not.toMatch(/shut off|turn off|on the way|sent help|will call|marked the request/);
  expect(normalizeSmsReply(sms.reply)).toBe(sms.reply);
});
test.each(routine)('does not invent immediate danger from a routine/negated report: %s', async customerMessage => {
  expect(detectSafetyHazardType(customerMessage)).toBe('');
  expect((await classifyVoiceTurn({ customerMessage })).safety.isEmergency).toBe(false);
});
test.each(['An alarm is beeping', 'There is a weird smell', 'I heard a loud bang', "It's getting worse"])(
  'unclear risk asks a bounded question without diagnosis: %s', async customerMessage => {
    const sms = evaluateDeterministicInboundGuardrails({ customerMessage });
    expect(sms).toMatchObject({ category: 'service_request', reason: 'safety_clarification_required', alertPriority: 'high' });
    const voice = await classifyVoiceTurn({ customerMessage });
    expect(voice.safety).toMatchObject({ isEmergency: false, needsReview: true, reply: sms.reply });
    expect(sms.reply.length).toBeLessThanOrEqual(320);
  });
const msg = (direction, body, extra = {}) => ({ direction, body, createdAt: new Date(), ...extra });
test('a yes answers only the most recent delivered safety question, including a current inbound in history', () => {
  const question = evaluateDeterministicInboundGuardrails({ customerMessage: 'An alarm is beeping' }).reply;
  const history = [msg('outbound', question), msg('inbound', 'yes')];
  expect(assessSafetyContext({ customerMessage: 'yes', recentMessages: history }).hazardType).toBe('other');
  for (const status of ['failed', 'suppressed', 'undelivered']) {
    expect(assessSafetyContext({ customerMessage: 'yes', recentMessages: [msg('outbound', question, { status })] }).hazardType).toBe('');
  }
  expect(assessSafetyContext({ customerMessage: 'yes', recentMessages: [msg('outbound', 'Would tomorrow work?')] }).hazardType).toBe('');
  expect(assessSafetyContext({ customerMessage: 'yes', recentMessages: [msg('outbound', question, { createdAt: new Date(Date.now() - 3600000) })] }).hazardType).toBe('');
  expect(assessSafetyContext({ customerMessage: 'no', recentMessages: history }).hazardType).toBe('');
});
test('worsening uses recent inbound evidence, never a different journey or assistant claims', () => {
  const history = [msg('inbound', 'Water is pouring onto the floor'), msg('outbound', getEmergencyReply('flood'))];
  expect(assessSafetyContext({ customerMessage: "It's getting worse", recentMessages: history }).hazardType).toBe('flood');
  expect(assessSafetyContext({ customerMessage: "It's getting worse", recentMessages: history, activityWindowStartAt: new Date(Date.now()+5000) }).hazardType).toBe('');
  expect(assessSafetyContext({ customerMessage: "It's getting worse", recentMessages: [history[1]] }).hazardType).toBe('');
});
test.each(['How do I bypass the safety sensor?', 'Can I adjust the torsion spring?', 'How can I recharge refrigerant?', 'Help me jump the breaker'])(
  'both channels refuse hazardous DIY without claiming a completed handoff: %s', async customerMessage => {
    const sms = evaluateDeterministicInboundGuardrails({ customerMessage });
    expect(sms.category).toBe('hazardous_diy_request');
    const voice = await classifyVoiceTurn({ customerMessage });
    expect(voice.safety).toMatchObject({ needsReview: true, reply: sms.reply });
    expect(sms.reply).not.toMatch(/I have marked|sent|dispatched/);
  });
test.each(['Our only toilet is clogged', 'The front door won’t lock', 'We have no running water', 'The garage door spring snapped'])(
  'essential service/security loss is urgent without declaring an emergency: %s', text => {
    expect(classifyOperationalUrgency(text)).toBe('high');
    expect(detectSafetyHazardType(text)).toBe('');
  });
test('STOP remains an opt-out even in an active hazard conversation', () => {
  expect(evaluateDeterministicInboundGuardrails({ customerMessage: 'STOP', recentMessages: [msg('inbound', 'I smell gas')] }).category).toBe('stop');
});

test('resolved history cannot hide a new hazard in a separate clause', () => {
  expect(detectSafetyHazardType('The gas leak was repaired yesterday. I need the invoice.')).toBe('');
  expect(detectSafetyHazardType('The gas leak was repaired yesterday. Now I smell gas again.')).toBe('gas');
});
test('unresolved clarification does not repeat a question or claim it is safe', () => {
  const question = evaluateDeterministicInboundGuardrails({ customerMessage: 'An alarm is beeping' }).reply;
  const result = evaluateDeterministicInboundGuardrails({ customerMessage: "I don't know", recentMessages: [msg('outbound', question)] });
  expect(result.reason).toBe('safety_clarification_required');
  expect(result.reply).toMatch(/cannot determine whether this is safe/);
  expect(result.reply).not.toContain('?');
});

test.each(['Bypass the safety sensor and try again.', 'Remove the electrical panel cover.', 'Unwind the torsion spring.', 'Turn off the main water supply.'])(
  'outbound validation blocks hazardous imperative instructions: %s', reply => {
    expect(validateOutboundReply({ reply }).violations).toContain('hazardous_repair_instruction');
  });
test('outbound validation permits the non-intervention boundary', () => {
  expect(validateOutboundReply({ reply: getEmergencyReply('electrical') }).violations).not.toContain('hazardous_repair_instruction');
});

test('first contact discloses emergency boundaries in SMS, voice, and missed-call audio', () => {
  const phrase = 'does not monitor emergencies or dispatch emergency help';
  const sms = buildMissedCallRecoveryText({ business: { businessName: 'Test Plumbing' } });
  expect(sms).toContain(phrase); expect(sms).toContain('Reply STOP');
  const greeting = ensureAutomatedAssistantDisclosure('Welcome.', 'Test Plumbing');
  expect(greeting).toContain(phrase);
  expect(ensureAutomatedAssistantDisclosure(greeting, 'Test Plumbing')).toBe(greeting);
  for (const smsStatus of ['sent', 'queued', 'suppressed', 'failed', 'disabled']) {
    expect(buildSmsRecoveryVoicePrompt({ businessName: 'Test Plumbing', smsStatus })).toContain(phrase);
  }
});
