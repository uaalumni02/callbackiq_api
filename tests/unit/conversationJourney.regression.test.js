import { evaluateSmsTurnPolicy } from '../../src/services/messaging/smsTurnPolicy.service.js';
import { bookingQuestionReply, isAmbiguousServiceLoss } from '../../src/services/booking/conversationQuestions.service.js';
import { expireBookingOffer } from '../../src/workers/conversationLifecycle.worker.js';
import Conversation from '../../src/models/conversation.js';
import { sendSms } from '../../src/services/twilioSmsService.js';
jest.mock('../../src/models/conversation.js', () => ({ __esModule: true, default: { findOneAndUpdate: jest.fn() } }));
jest.mock('../../src/models/message.js', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/twilioSmsService.js', () => ({ sendSms: jest.fn() }));
jest.mock('../../src/services/alert.service.js', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/distributedLease.service.js', () => ({ withDistributedLease: jest.fn() }));
const business = { timezone: 'America/New_York', features: { aiBookingEnabled: false } };
afterEach(() => jest.clearAllMocks());
test('time preference cannot bypass the live offer state machine', () => {
  expect(evaluateSmsTurnPolicy({ business, customerMessage: 'Today at 1:30pm', conversation: { bookingState: { status: 'offering_slots' } } }).directResult).toBeNull();
});
test('loss of service requests clarification, without claiming an emergency or alert', () => {
  const result = evaluateSmsTurnPolicy({ business, lead: { serviceNeeded: 'blocked sink' }, customerMessage: 'Loss of service' }).directResult;
  expect(result.reply).toMatch(/whole property/);
  expect(result.shouldAlertOwner).toBe(false);
  expect(result.urgency).toBe('medium');
  expect(isAmbiguousServiceLoss('Loss of service and smoke')).toBe(false);
});
test('expired offers invalidate silently and compare the exact snapshot', async () => {
  const expiresAt = new Date('2026-09-07T15:45:00Z');
  const conversation = { _id: 'c1', bookingState: { status: 'offering_slots', expiresAt } };
  Conversation.findOneAndUpdate.mockResolvedValue(conversation);
  expect(await expireBookingOffer(conversation, new Date('2026-09-07T16:00:00Z'))).toBe(true);
  expect(Conversation.findOneAndUpdate.mock.calls[0][0]).toMatchObject({ 'bookingState.expiresAt': expiresAt, humanTakeover: { $ne: true } });
  expect(sendSms).not.toHaveBeenCalled();
});
test('pending approval and manual review are never expired as offers', async () => {
  for (const status of ['pending_business_confirmation', 'human_takeover', 'booked']) {
    expect(await expireBookingOffer({ bookingState: { status, expiresAt: new Date(0) } }, new Date())).toBe(false);
  }
  expect(Conversation.findOneAndUpdate).not.toHaveBeenCalled();
});
test('database-backed confirmation status cannot be guessed from conversation state', () => {
  expect(bookingQuestionReply({ customerMessage: 'Is my appointment confirmed?', conversation: { bookingState: { status: 'booked' } } })).toBeNull();
});

test('recovery introduction uses one atomic business-scoped cooldown claim', async () => {
  const { claimRecoveryIntroduction, hasRecentRecoveryIntroduction } = await import('../../src/services/messaging/recoveryIntroduction.service.js');
  const now = new Date('2026-09-07T15:15:00Z');
  Conversation.findOneAndUpdate.mockResolvedValueOnce({ _id: 'c1' }).mockResolvedValueOnce(null);
  expect(await claimRecoveryIntroduction({ businessId: 'b1', conversationId: 'c1', now })).toBe(true);
  expect(await claimRecoveryIntroduction({ businessId: 'b1', conversationId: 'c1', now })).toBe(false);
  expect(Conversation.findOneAndUpdate.mock.calls[0][0]).toMatchObject({ _id: 'c1', business: 'b1', humanTakeover: { $ne: true } });
  expect(hasRecentRecoveryIntroduction({ orchestration: { recoveryIntroClaimedAt: now } }, now)).toBe(true);
  expect(hasRecentRecoveryIntroduction({ orchestration: { recoveryIntroClaimedAt: new Date('2026-09-07T14:00:00Z') } }, now)).toBe(false);
});
