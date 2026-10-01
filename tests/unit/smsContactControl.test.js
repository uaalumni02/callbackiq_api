import { smsContactControlKind, contactControlReply } from '../../src/services/messaging/smsContactControl.service.js';
import { applySmsProductionInvariants } from '../../src/services/messaging/smsProductionInvariant.service.js';
import { getSmsAutomationSuppressionReason } from '../../src/services/messaging/smsAutomationDispatchPolicy.service.js';
import Business from '../../src/models/business.js';
import Conversation from '../../src/models/conversation.js';
jest.mock('../../src/models/business.js', () => ({ __esModule: true, default: { findById: jest.fn() } }));
jest.mock('../../src/models/conversation.js', () => ({ __esModule: true, default: { findOne: jest.fn() } }));

test.each(['Did you get my text?', 'Have you seen my message yet?', 'Has anyone received my SMS?',
  'Did my message go through?', 'Did you get my earlier text message?', 'Are you still there?',
  'When will someone call me?', 'Any update on my callback request?', 'Can you confirm you received my text?'])('receipt recognition: %s', text => {
  expect(smsContactControlKind(text)).toBe('receipt');
});
test.each(['Call me', 'Please call me back', 'Can someone call me?', 'Give me a call please',
  'Have a person call me', 'Call me when you get a chance', 'Call me\nDid you get my text?', 'Call me. Did you receive my message?'])('callback recognition: %s', text => {
  expect(smsContactControlKind(text)).toBe('callback');
});
test.each(["Don't call me", 'No callback, text me instead', 'I called back', 'Stop',
  'Call me. My address is 12 Oak Street', 'Call me. I smell gas', 'Call me and book tomorrow at 10',
  'Did you get my text? Change my address to 12 Oak Street', 'Call me at 4045550101',
  'What time is the appointment?', 'Is my appointment confirmed?', 'Hello'])('does not consume a negative, factual, safety, scheduling or ordinary turn: %s', text => {
  expect(smsContactControlKind(text)).toBe('');
});

test.each(['callback', 'human', 'receipt'])('fixed %s reply survives production sanitizers and does not imply staff read it', kind => {
  const conversation = { humanTakeover: true, aiEnabled: false, serviceEligibility: { decision: 'unsupported' } };
  const reply = contactControlReply({ kind, conversation, savedRequest: kind !== 'receipt' });
  const result = applySmsProductionInvariants({ result: { decision: 'send_fixed_response', reply, contactControl: kind,
    guardrail: { skipAI: true, reason: 'sms_contact_control' } }, conversation,
    customerMessage: kind === 'receipt' ? 'Did you get my text?' : 'Call me' });
  expect(result.reply).toBe(reply);
  expect(reply).not.toMatch(/keep helping|will call|staff (?:received|read)|appointment is (?:not )?confirmed/i);
});

describe('dispatch permission for narrow customer contact controls', () => {
  let conversation;
  const base = { businessId: 'b', conversationId: 'c', leadId: 'l', to: '+14045550101',
    isAiGenerated: false, contactControl: 'receipt', customerMessage: 'Did you get my text?' };
  beforeEach(() => {
    conversation = { _id: 'c', business: 'b', lead: 'l', customerPhone: base.to,
      status: 'open', humanTakeover: true, aiEnabled: false };
    Business.findById.mockResolvedValue({ isActive: true });
    Conversation.findOne.mockImplementation(async () => conversation);
  });
  test('allows deterministic receipt without releasing staff ownership', async () => {
    expect(await getSmsAutomationSuppressionReason(base)).toBe('');
    expect(conversation).toMatchObject({ humanTakeover: true, aiEnabled: false });
  });
  test.each([
    [{ isAiGenerated: true }, 'human_takeover'],
    [{ contactControl: '' }, 'human_takeover'],
    [{ contactControl: 'callback' }, 'human_takeover'],
    [{ customerMessage: 'How much is it?' }, 'human_takeover'],
    [{ customerMessage: 'Did you get my text? Book me tomorrow.' }, 'human_takeover'],
    [{ to: '+14045559999' }, 'automation_context_changed'],
    [{ leadId: 'other-lead' }, 'automation_context_changed'],
  ])('fails closed for %p', async (overrides, reason) => {
    expect(await getSmsAutomationSuppressionReason({ ...base, ...overrides })).toBe(reason);
  });
  test.each(['closed', 'archived'])('does not bypass %s', async status => {
    conversation.status = status;
    expect(await getSmsAutomationSuppressionReason(base)).not.toBe('');
  });
  test('does not bypass an explicit AI pause without staff ownership', async () => {
    conversation.humanTakeover = false;
    expect(await getSmsAutomationSuppressionReason(base)).toBe('conversation_ai_disabled');
  });
  test('does not bypass business disablement', async () => {
    Business.findById.mockResolvedValue({ isActive: false });
    expect(await getSmsAutomationSuppressionReason(base)).toBe('business_inactive');
  });
});
