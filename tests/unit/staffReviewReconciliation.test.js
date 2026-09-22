import Conversation from '../../src/models/conversation.js';
import Alert from '../../src/models/alert.js';
import Message from '../../src/models/message.js';
import AlertService from '../../src/services/alert.service.js';
import { withDistributedLease } from '../../src/services/distributedLease.service.js';
import { needsStaffReviewRecovery, reconcileConversationStaffReview, reconcileStaffReviewPage } from '../../src/services/staffReviewReconciliation.service.js';
jest.mock('../../src/models/conversation.js', () => ({ __esModule: true, default: { find: jest.fn(), findOne: jest.fn() } }));
jest.mock('../../src/models/alert.js', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../src/models/message.js', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../src/services/alert.service.js', () => ({ __esModule: true, default: { create: jest.fn() } }));
jest.mock('../../src/helpers/logging/safeLogger.js', () => ({ logOperationalError: jest.fn() }));
jest.mock('../../src/services/distributedLease.service.js', () => ({ withDistributedLease: jest.fn(), assertDistributedLeaseActive: jest.fn() }));
const query = value => { const q = { select: () => q, sort: () => q, limit: () => q, maxTimeMS: () => q, lean: async () => value }; return q; };
let conversation;
const run = apply => reconcileConversationStaffReview({ businessId: 'b1', conversationId: 'c1', apply });
beforeEach(() => {
  jest.clearAllMocks();
  conversation = { _id: 'c1', business: 'b1', lead: 'l1', status: 'open', orchestration: { handoffReason: 'intake_complete', handoffInboundMessage: 'm1' }, conversationMemory: { recoveryIntake: { reviewReady: true } } };
  Conversation.findOne.mockImplementation(() => query(conversation));
  Alert.findOne.mockImplementation(() => query(null));
  Message.findOne.mockReturnValue(query({ _id: 'm1', providerMessageId: 'SM1' }));
  AlertService.create.mockResolvedValue({ alert: { _id: 'a1' }, created: true });
  withDistributedLease.mockImplementation(async (key, op) => ({ acquired: true, value: await op() }));
});
test('dry run audits without taking a lease or writing', async () => {
  expect(await run(false)).toMatchObject({ status: 'missing' });
  expect(AlertService.create).not.toHaveBeenCalled(); expect(withDistributedLease).not.toHaveBeenCalled();
});
test('repair uses original SMS dedupe identity and preserves all request facts', async () => {
  const original = JSON.stringify(conversation);
  expect(await run(true)).toMatchObject({ status: 'recovered', alertId: 'a1' });
  expect(AlertService.create).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'b1', conversationId: 'c1', leadId: 'l1', dedupeKey: 'human_handoff:SM1', actionRequired: true }));
  expect(JSON.stringify(conversation)).toBe(original);
  expect(withDistributedLease).toHaveBeenCalledWith('sms-conversation:c1', expect.any(Function), expect.any(Object));
});
test.each([null, new Date()])('existing open or handled review prevents duplicate recovery', async resolvedAt => {
  Alert.findOne.mockReturnValue(query({ _id: 'a1', resolvedAt }));
  expect((await run(true)).status).toBe(resolvedAt ? 'handled' : 'present');
  expect(AlertService.create).not.toHaveBeenCalled();
});
test('a failed alert write is retried on a later invocation, not marked complete', async () => {
  AlertService.create.mockRejectedValueOnce(new Error('database disconnected'));
  await expect(run(true)).rejects.toThrow('database disconnected');
  expect(await run(true)).toMatchObject({ status: 'recovered' });
  expect(AlertService.create.mock.calls[0][0].dedupeKey).toBe(AlertService.create.mock.calls[1][0].dedupeKey);
});
test('unpersisted results and busy SMS processing never report successful recovery', async () => {
  AlertService.create.mockResolvedValue({});
  await expect(run(true)).rejects.toThrow('not persisted');
  withDistributedLease.mockResolvedValue({ acquired: false });
  expect(await run(true)).toEqual({ status: 'busy' });
});
test.each([
  { status: 'closed' }, { bookingState: { status: 'booked' } },
  { conversationMemory: { recoveryIntake: { withdrawnAt: new Date() } } },
  { conversationMemory: { recoveryIntake: { journeyKey: 'old' } } },
  { conversationMemory: { recoveryIntake: { review: { status: 'resolved' } } } },
])('does not revive finished or superseded requests: %j', patch => {
  expect(needsStaffReviewRecovery({ ...conversation, ...patch })).toBe(false);
});
test('page isolates a failing record and continues later customers', async () => {
  Conversation.find.mockReturnValue(query([{ _id: 'c1', business: 'b1' }, { _id: 'c2', business: 'b2' }]));
  AlertService.create.mockRejectedValueOnce(new Error('database failure'));
  const result = await reconcileStaffReviewPage({ limit: 2, apply: true });
  expect(result.results.map(row => row.status)).toEqual(['failed', 'recovered']);
  expect(result.nextCursor).toBe('c2');
});
