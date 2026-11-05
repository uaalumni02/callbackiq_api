import Conversation from '../../src/models/conversation.js';
import Lead from '../../src/models/lead.js';
import RecoveryCase from '../../src/models/recoveryCase.js';
import Alert from '../../src/models/alert.js';
import { linked, caseFor, requireOwnedReview } from '../../src/services/recoveryCoordinator/recoveryScope.repository.js';

jest.mock('../../src/models/conversation.js', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../src/models/lead.js', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../src/models/recoveryCase.js', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../src/models/alert.js', () => ({ __esModule: true, default: { findOne: jest.fn() } }));

const businessId = '507f1f77bcf86cd799439011';
const conversationId = '507f1f77bcf86cd799439012';
const leadId = '507f1f77bcf86cd799439013';
const userId = '507f1f77bcf86cd799439014';
const session = { id: 'transaction-session' };

const query = result => ({
  session: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(result),
});

beforeEach(() => jest.clearAllMocks());

test('linked customer context enforces tenant scope for both conversation and lead', async () => {
  const conversation = { _id: conversationId, lead: leadId };
  const lead = { _id: leadId, business: businessId };
  const cq = query(conversation), lq = query(lead);
  Conversation.findOne.mockReturnValue(cq);
  Lead.findOne.mockReturnValue(lq);
  await expect(linked(businessId, conversationId, session)).resolves.toEqual({ conversation, lead });
  expect(Conversation.findOne).toHaveBeenCalledWith({ _id: conversationId, business: businessId });
  expect(Lead.findOne).toHaveBeenCalledWith({ _id: leadId, business: businessId });
  expect(cq.session).toHaveBeenCalledWith(session);
  expect(lq.session).toHaveBeenCalledWith(session);
});

test('invalid conversation ID fails before querying any tenant data', async () => {
  await expect(linked(businessId, 'invalid-id', session)).rejects.toMatchObject({ statusCode:400 });
  expect(Conversation.findOne).not.toHaveBeenCalled();
  expect(Lead.findOne).not.toHaveBeenCalled();
});

test.each([
  [null, 'missing conversation'],
  [{ _id: conversationId }, 'missing linked lead'],
  [{ _id: conversationId, lead: 'invalid' }, 'invalid lead reference'],
])('%s fails closed on %s', async (conversation) => {
  Conversation.findOne.mockReturnValue(query(conversation));
  await expect(linked(businessId, conversationId)).rejects.toMatchObject({ code:'RECOVERY_NOT_FOUND', statusCode:404 });
  expect(Lead.findOne).not.toHaveBeenCalled();
});

test('missing lead fails closed instead of trusting cross-tenant conversation data', async () => {
  Conversation.findOne.mockReturnValue(query({ lead: leadId }));
  Lead.findOne.mockReturnValue(query(null));
  await expect(linked(businessId, conversationId)).rejects.toMatchObject({ code:'RECOVERY_NOT_FOUND' });
});

test('recovery record lookup includes tenant, conversation and generation, with transaction session', async () => {
  const record = { _id: 'case-id', version: 2 };
  const cq = query(record);
  RecoveryCase.findOne.mockReturnValue(cq);
  await expect(caseFor(businessId, conversationId, session)).resolves.toBe(record);
  expect(RecoveryCase.findOne).toHaveBeenCalledWith({ business:businessId, conversation:conversationId, generation:1 });
  expect(cq.session).toHaveBeenCalledWith(session);
});

test('missing recovery case cannot be silently initialized or approved', async () => {
  RecoveryCase.findOne.mockReturnValue(query(null));
  await expect(caseFor(businessId, conversationId)).rejects.toMatchObject({ code:'RECOVERY_NOT_FOUND', statusCode:404 });
});

test('staff authorization requires human takeover on the matching tenant conversation and lead', async () => {
  Conversation.findOne.mockReturnValue(query(null));
  await expect(requireOwnedReview({ businessId, conversationId, leadId, userId, session }))
    .rejects.toMatchObject({ code:'RECOVERY_CONFLICT', statusCode:409 });
  expect(Conversation.findOne).toHaveBeenCalledWith({ _id:conversationId, business:businessId, lead:leadId, humanTakeover:true });
  expect(Alert.findOne).not.toHaveBeenCalled();
});

test('a human takeover alone cannot authorize review without the assigned unresolved alert', async () => {
  Conversation.findOne.mockReturnValue(query({ _id:conversationId, humanTakeover:true }));
  Alert.findOne.mockReturnValue(query(null));
  await expect(requireOwnedReview({ businessId, conversationId, leadId, userId, session }))
    .rejects.toMatchObject({ code:'RECOVERY_CONFLICT', statusCode:409 });
  expect(Alert.findOne).toHaveBeenCalledWith(expect.objectContaining({
    business: businessId, conversation: conversationId, lead: leadId,
    actionRequired:true, resolvedAt:null, acknowledgedAt:{ $ne:null }, assignedTo:userId,
  }));
});

test('staff review returns owned conversation only after qualified alert evidence', async () => {
  const conversation = { _id:conversationId, humanTakeover:true };
  const alert = { _id:'alert' };
  Conversation.findOne.mockReturnValue(query(conversation));
  Alert.findOne.mockReturnValue(query(alert));
  const result = await requireOwnedReview({ businessId, conversationId, leadId, userId, session });
  expect(result).toBe(conversation);
  expect(Alert.findOne.mock.calls[0][0].$or).toEqual(expect.arrayContaining([
    expect.objectContaining({ type:'human_requested' }),
    expect.objectContaining({ type:'system' }),
  ]));
});
