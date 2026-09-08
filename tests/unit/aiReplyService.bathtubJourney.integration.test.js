import OpenAI from 'openai';
import { generateAIReplyResult, resetOpenAIReplyClient } from '../../src/services/aiReplyService.js';
import { classifySmsIntent } from '../../src/services/messaging/smsIntentClassifier.service.js';
import ServiceOffering from '../../src/models/serviceOffering.js';
import { reserveAiUsage } from '../../src/services/communicationUsage.service.js';
import { buildAIConfigurationContext } from '../../src/services/businessConfiguration.service.js';
import AlertService from '../../src/services/alert.service.js';

jest.mock('openai', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../src/models/serviceOffering.js', () => ({ __esModule: true, default: { find: jest.fn() } }));
jest.mock('../../src/services/communicationUsage.service.js', () => ({ reserveAiUsage: jest.fn() }));
jest.mock('../../src/services/businessConfiguration.service.js', () => ({ buildAIConfigurationContext: jest.fn() }));
jest.mock('../../src/services/alert.service.js', () => ({ __esModule: true, default: { createHumanHandoffAlert: jest.fn(), createOperationalAlert: jest.fn() } }));

const business = { _id: 'business-a', businessName: 'Atlanta Pro Plumbing & Drain', businessType: 'plumbing', timezone: 'America/New_York', features: { aiBookingEnabled: false } };
const modelCreate = jest.fn();
const originalKey = process.env.OPENAI_API_KEY;

// Reload from saved snapshots between turns so unsaved in-memory mutations cannot
// make the regression pass. Only database/provider boundaries are simulated.
function journey() {
  let savedLead = { _id: 'lead-a', serviceNeeded: 'Unknown', urgency: 'medium', phone: '+14045550100' };
  let savedConversation = { _id: 'conversation-a', status: 'open', humanTakeover: false, conversationMemory: {}, bookingState: { status: 'not_started' }, orchestration: { recoveryJourneyKey: 'journey-a' } };
  const messages = [{ direction: 'outbound', body: 'Hi, this is Atlanta Pro Plumbing & Drain. Sorry we missed your call. What service do you need help with today? Reply STOP to opt out.', createdAt: new Date('2026-09-08T01:59:00Z') }];
  const leadWrites = jest.fn();
  const conversationWrites = jest.fn();
  return {
    get lead() { return savedLead; },
    get conversation() { return savedConversation; },
    leadWrites, conversationWrites,
    async turn(body) {
      const turn = messages.filter(message => message.direction === 'inbound').length + 1;
      const lead = { ...structuredClone(savedLead), async save() { leadWrites(); savedLead = JSON.parse(JSON.stringify(this)); } };
      const conversation = { ...structuredClone(savedConversation), async save() { conversationWrites(); savedConversation = JSON.parse(JSON.stringify(this)); }, set(path, value) { const keys = path.split('.'); let target = this; for (const key of keys.slice(0, -1)) target = target[key] ||= {}; target[keys.at(-1)] = value; }, markModified() {} };
      messages.push({ _id: `in-${turn}`, direction: 'inbound', body, createdAt: new Date(Date.parse('2026-09-08T01:59:00Z') + turn * 60000) });
      const result = await generateAIReplyResult({ business, lead, conversation, customerMessage: body, messages });
      messages.push({ _id: `out-${turn}`, direction: 'outbound', body: result.reply, createdAt: new Date(Date.parse('2026-09-08T01:59:00Z') + turn * 60000 + 1000) });
      return result;
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.OPENAI_API_KEY = 'test-openai-key';
  resetOpenAIReplyClient();
  OpenAI.mockImplementation(() => ({ responses: { create: modelCreate } }));
  modelCreate.mockRejectedValue(new Error('Unexpected model call during deterministic intake'));
  ServiceOffering.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) });
  reserveAiUsage.mockResolvedValue({ allowed: true });
  buildAIConfigurationContext.mockResolvedValue({});
});
afterEach(() => {
  resetOpenAIReplyClient();
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
});

test('exact bathtub transcript preserves service through pricing, repetition, typo and new leak information', async () => {
  const c = journey();
  const first = await c.turn('My bathtub needs resealing. How much is the cost');
  expect(first.messageCategory).toBe('pricing_request');
  expect(first.reply).toMatch(/price/i);
  expect(first.serviceNeeded).toMatch(/bathtub.*resealing/i);
  expect(c.lead.serviceNeeded).toBe(first.serviceNeeded);
  expect(first.reply).not.toMatch(/what service|what.*need help with/i);
  const second = await c.turn('Bathtub needs resealing');
  const third = await c.turn('Seal around tube needs to be replaced');
  expect(c.conversation.conversationMemory.recoveryIntake.serviceDetail).toMatch(/tub/i);
  const fourth = await c.turn('Bathtub is leaking');
  for (const result of [first, second, third, fourth]) {
    expect(result.guardrail.reason).toBe('shared_recovery_intake');
    expect(result.reply).not.toMatch(/didn't understand|rephrase|saved for team review|response timeframe/i);
    expect(result.handoff).toBeUndefined();
    expect(result.serviceNeeded).toMatch(/bathtub/i);
  }
  expect(fourth.reply).toMatch(/leaking.*right now.*only when/i);
  expect(c.conversation.conversationMemory.recoveryIntake.triagePending).toBe(true);
  expect(c.conversation.conversationMemory.recoveryIntake.failures).toBe(0);
  expect(c.conversation.conversationMemory.uncertainTurns || 0).toBe(0);
  expect(c.leadWrites).toHaveBeenCalled();
  expect(c.conversationWrites).toHaveBeenCalled();
  expect(modelCreate).not.toHaveBeenCalled();
  expect(reserveAiUsage).not.toHaveBeenCalled();
  expect(AlertService.createHumanHandoffAlert).not.toHaveBeenCalled();
});

test('unfamiliar service uses one metered model extraction and then the real shared intake', async () => {
  const customerMessage = 'The escutcheon has come adrift. How much?';
  expect(classifySmsIntent({ business, customerMessage }).entities.serviceNeeded).toBe('');
  modelCreate.mockResolvedValueOnce({ output_text: JSON.stringify({ decision: 'send', messageCategory: 'pricing_request', isInScope: true, serviceNeeded: 'loose escutcheon repair', urgency: 'medium', address: '', preferredAppointmentTime: '', leadQualityScore: 60, summary: 'Customer asks the price for a loose escutcheon.', estimatedValue: 0, shouldAlertOwner: false, alertPriority: 'low', riskFlags: [], confidence: 93 }) });
  const c = journey();
  const result = await c.turn(customerMessage);
  expect(result.guardrail.reason).toBe('shared_recovery_intake');
  expect(result.messageCategory).toBe('pricing_request');
  expect(result.serviceNeeded).toBe('loose escutcheon repair');
  expect(c.lead.serviceNeeded).toBe('loose escutcheon repair');
  expect(result.reply).toMatch(/price/i);
  expect(result.reply).not.toMatch(/what service|didn't understand|rephrase/i);
  expect(reserveAiUsage).toHaveBeenCalledTimes(1);
  expect(modelCreate).toHaveBeenCalledTimes(1);
  expect(reserveAiUsage.mock.invocationCallOrder[0]).toBeLessThan(modelCreate.mock.invocationCallOrder[0]);
  expect(modelCreate.mock.calls[0][0].text.format.name).toMatch(/qualif/i);
  expect(AlertService.createHumanHandoffAlert).not.toHaveBeenCalled();
});
