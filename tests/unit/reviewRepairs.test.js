import { invoiceSubscriptionId } from '../../src/helpers/billing/invoiceSubscriptionId.js';
import { applySmsProductionInvariants } from '../../src/services/messaging/smsProductionInvariant.service.js';
import { getSmsAutomationSuppressionReason } from '../../src/services/messaging/smsAutomationDispatchPolicy.service.js';
import Business from '../../src/models/business.js';
import Conversation from '../../src/models/conversation.js';
jest.mock('../../src/models/business.js', () => ({ __esModule: true, default: { findById: jest.fn() } }));
jest.mock('../../src/models/conversation.js', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
test.each([
  [null, ''], [{}, ''], [{ subscription: 'sub_old' }, 'sub_old'],
  [{ subscription: { id: 'sub_old' } }, 'sub_old'],
  [{ parent: { subscription_details: { subscription: 'sub_new' } } }, 'sub_new'],
  [{ parent: { subscription_details: { subscription: { id: 'sub_new' } } } }, 'sub_new'],
  [{ subscription: 'sub_old', parent: { subscription_details: { subscription: 'sub_new' } } }, 'sub_new'],
])('invoice subscription extraction %j', (invoice, expected) => expect(invoiceSubscriptionId(invoice)).toBe(expected));

describe('fixed emergency delivery boundary', () => {
  const args = { businessId: 'b', conversationId: 'c', leadId: 'l', to: '+16785768258', isAiGenerated: false, fixedEmergencyReply: true };
  let conversation;
  beforeEach(() => {
    conversation = { lead: 'l', customerPhone: args.to, status: 'open', humanTakeover: true, aiEnabled: false };
    Business.findById.mockResolvedValue({ isActive: true });
    Conversation.findOne.mockImplementation(async () => conversation);
  });
  test('permits fixed safety response without resuming automation', async () => {
    expect(await getSmsAutomationSuppressionReason(args)).toBe('');
    expect(conversation).toMatchObject({ humanTakeover: true, aiEnabled: false });
  });
  test.each([
    [{ isAiGenerated: true }, 'human_takeover'], [{ fixedEmergencyReply: false }, 'human_takeover'],
    [{ to: '+12025550100' }, 'automation_context_changed'], [{ leadId: 'foreign' }, 'automation_context_changed'],
  ])('rejects unsafe override %j', async (overrides, reason) => expect(await getSmsAutomationSuppressionReason({ ...args, ...overrides })).toBe(reason));
  test.each(['closed', 'archived'])('rejects %s conversation', async status => {
    conversation.status = status;
    expect(await getSmsAutomationSuppressionReason(args)).toBe('conversation_inactive');
  });
  test('does not bypass inactive business', async () => {
    Business.findById.mockResolvedValue({ isActive: false });
    expect(await getSmsAutomationSuppressionReason(args)).toBe('business_inactive');
  });
  test.each(['unsupported', 'needs_clarification', 'needs_staff_review'])('catalog decision %s cannot replace emergency guidance', decision => {
    const reply = 'Leave the area and call emergency services.';
    const result = applySmsProductionInvariants({ result: { decision: 'send_fixed_response', messageCategory: 'emergency', reply, guardrail: { skipAI: true } }, lead: { serviceEligibility: { decision } }, customerMessage: 'I smell gas. How much to fix it?' });
    expect(result.reply).toBe(reply);
  });
});
