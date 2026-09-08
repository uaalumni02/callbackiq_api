import { constrainUncertainReply, qualifiedIntakeFacts } from '../../src/services/messaging/uncertainReply.service.js';

const assessment = { decision: 'send', messageCategory: 'new_service_request', isInScope: true, confidence: 92, serviceNeeded: 'bathtub resealing', address: '', preferredAppointmentTime: '', riskFlags: [] };
const weakReply = { decision: 'send', actionType: 'acknowledge', confidence: 20, reply: 'Your appointment is booked.', serviceNeeded: 'guessed service', address: 'guessed address', guardrail: { skipAI: false } };
const conversation = () => ({ conversationMemory: { uncertainTurns: 1, uncertainTurnId: 'prior' }, save: jest.fn().mockResolvedValue(null) });

test('reliable service extraction survives uncertain wording without an escalation loop', async () => {
  const context = conversation();
  const result = await constrainUncertainReply({ result: weakReply, lead: {}, conversation: context, inboundAssessment: assessment, turnId: 'new' });
  expect(result.serviceNeeded).toBe('bathtub resealing');
  expect(result.address).toBe('');
  expect(result.reply).toMatch(/service address/);
  expect(result.reply).not.toMatch(/booked|rephrase|what needs repair/i);
  expect(result.handoff).toBeUndefined();
  expect(context.conversationMemory.uncertainTurns).toBe(0);
});

test('independent extraction survives a high confidence reply that omits the service', async () => {
  const result = await constrainUncertainReply({ result: { ...weakReply, confidence: 90, serviceNeeded: '' }, lead: {}, conversation: conversation(), inboundAssessment: assessment });
  expect(result.serviceNeeded).toBe('bathtub resealing');
});

test.each([
  { confidence: 15 }, { confidence: '99' }, { isInScope: false },
  { messageCategory: 'prompt_injection' }, { decision: 'alert_owner' },
  { riskFlags: ['safety_hazard'] }, { serviceNeeded: { value: 'invented' } },
])('untrusted extraction cannot replace captured service: %j', async override => {
  const untrusted = { ...assessment, ...override };
  const result = await constrainUncertainReply({ result: weakReply, lead: { serviceNeeded: 'drain cleaning' }, conversation: conversation(), inboundAssessment: untrusted });
  expect(result.serviceNeeded).toBe('drain cleaning');
});

test('a low confidence reply is constrained even without a persistence-capable conversation', async () => {
  const result = await constrainUncertainReply({ result: weakReply, lead: { serviceNeeded: 'drain cleaning' } });
  expect(result.reply).not.toContain('booked');
  expect(result.serviceNeeded).toBe('drain cleaning');
});

test('low confidence duplicate delivery counts once and second distinct unclear turn requests real handoff', async () => {
  const context = { conversationMemory: {}, save: jest.fn().mockResolvedValue(null) };
  const parameters = { result: weakReply, lead: {}, conversation: context, turnId: 'one' };
  await constrainUncertainReply(parameters);
  await constrainUncertainReply(parameters);
  expect(context.conversationMemory.uncertainTurns).toBe(1);
  const result = await constrainUncertainReply({ ...parameters, turnId: 'two' });
  expect(result.handoff).toEqual({ required: true, reason: 'intake_unclear', callbackRequested: false });
  expect(result.shouldAlertOwner).toBe(true);
  expect(result.reply).not.toMatch(/saved|shortly|timeframe/);
});

test('no-reply and outbound safeguards retain priority over semantic facts', async () => {
  for (const result of [{ ...weakReply, decision: 'no_reply' }, { ...weakReply, guardrail: { usedFallback: true } }, { ...weakReply, guardrail: { skipAI: true } }]) {
    expect(await constrainUncertainReply({ result, inboundAssessment: assessment })).toBe(result);
  }
  expect(qualifiedIntakeFacts(null)).toEqual({});
});
