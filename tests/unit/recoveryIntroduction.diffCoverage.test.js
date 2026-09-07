import Conversation from '../../src/models/conversation.js';
import { claimRecoveryIntroduction, hasRecentRecoveryIntroduction, RECOVERY_INTRO_COOLDOWN_MS } from '../../src/services/messaging/recoveryIntroduction.service.js';
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
test('same-operation retries remain tenant scoped and persist their operation key', async () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-09-07T12:00:00Z'));
  const update = jest.spyOn(Conversation, 'findOneAndUpdate').mockResolvedValue({ _id: 'c1' });
  await expect(claimRecoveryIntroduction({ businessId: 'b1', conversationId: 'c1', operationKey: 'op-1' })).resolves.toBe(true);
  expect(update).toHaveBeenCalledWith({ _id: 'c1', business: 'b1', status: 'open', humanTakeover: { $ne: true }, aiEnabled: { $ne: false }, $or: [
    { 'orchestration.recoveryIntroOperationKey': 'op-1' },
    { 'orchestration.recoveryIntroClaimedAt': null },
    { 'orchestration.recoveryIntroClaimedAt': { $lte: new Date(Date.now() - RECOVERY_INTRO_COOLDOWN_MS) } },
  ] }, { $set: { 'orchestration.recoveryIntroClaimedAt': new Date(), 'orchestration.recoveryIntroOperationKey': 'op-1' } }, { returnDocument: 'after' });
});
test('a claim without an operation key cannot use the same-operation bypass', async () => {
  const now = new Date('2026-09-07T12:00:00Z');
  const update = jest.spyOn(Conversation, 'findOneAndUpdate').mockResolvedValue(null);
  await expect(claimRecoveryIntroduction({ businessId: 'b1', conversationId: 'c1', now })).resolves.toBe(false);
  expect(update.mock.calls[0][0].$or).toHaveLength(2);
  expect(update.mock.calls[0][1].$set).toEqual({ 'orchestration.recoveryIntroClaimedAt': now });
});
test('claim database errors reach the caller for retry rather than pretending to claim', async () => {
  const error = new Error('database unavailable');
  jest.spyOn(Conversation, 'findOneAndUpdate').mockRejectedValue(error);
  await expect(claimRecoveryIntroduction({ businessId: 'b1', conversationId: 'c1', operationKey: '' })).rejects.toBe(error);
});
test('cooldown handles absent, invalid, fresh, expired and exact-boundary timestamps', () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-09-07T12:00:00Z'));
  for (const value of [undefined, null, {}, { orchestration: {} }]) expect(hasRecentRecoveryIntroduction(value)).toBe(false);
  const conv = at => ({ orchestration: { recoveryIntroClaimedAt: at } });
  expect(hasRecentRecoveryIntroduction(conv('not-a-date'))).toBe(false);
  expect(hasRecentRecoveryIntroduction(conv(new Date()))).toBe(true);
  expect(hasRecentRecoveryIntroduction(conv(new Date(Date.now() - RECOVERY_INTRO_COOLDOWN_MS)))).toBe(false);
  expect(hasRecentRecoveryIntroduction(conv(new Date(Date.now() - RECOVERY_INTRO_COOLDOWN_MS - 1)), new Date())).toBe(false);
  expect(hasRecentRecoveryIntroduction(conv(new Date(Date.now() - RECOVERY_INTRO_COOLDOWN_MS + 1)))).toBe(true);
});
