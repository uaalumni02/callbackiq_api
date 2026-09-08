import Lease from '../../src/models/productionOperationLease.js';
import { assertDistributedLeaseActive, renewDistributedLease, withDistributedLease } from '../../src/services/distributedLease.service.js';
jest.mock('../../src/models/productionOperationLease.js', () => ({ __esModule: true, default: { findOneAndUpdate: jest.fn(), updateOne: jest.fn(), deleteOne: jest.fn() } }));
jest.mock('../../src/helpers/logging/safeLogger.js', () => ({ safeConsole: { error: jest.fn() } }));

describe('lease loss fences subsequent effects', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    Lease.findOneAndUpdate.mockImplementation((_filter, update) => ({ lean: async () => update.$set }));
    Lease.updateOne.mockResolvedValue({ matchedCount: 1 });
    Lease.deleteOne.mockResolvedValue({ deletedCount: 1 });
  });
  afterEach(() => { jest.useRealTimers(); jest.clearAllMocks(); });

  test.each(['lost', 'unavailable'])('renewal %s prevents a paused operation from sending', async kind => {
    if (kind === 'lost') Lease.updateOne.mockResolvedValue({ matchedCount: 0 });
    else Lease.updateOne.mockRejectedValue(new Error('database unreachable'));
    let resume;
    const paused = new Promise(resolve => { resume = resolve; });
    const send = jest.fn();
    const running = withDistributedLease('sms:c1', async () => {
      await paused;
      assertDistributedLeaseActive();
      send();
    }, { ttlMs: 3000 });
    const rejected = expect(running).rejects.toMatchObject({ code: 'DISTRIBUTED_LEASE_LOST' });
    await jest.advanceTimersByTimeAsync(1000);
    resume();
    await rejected;
    expect(send).not.toHaveBeenCalled();
    expect(Lease.deleteOne).toHaveBeenCalledTimes(1);
  });

  test('local expiry prevents effects even without a heartbeat callback', async () => {
    let resume;
    const paused = new Promise(resolve => { resume = resolve; });
    const send = jest.fn();
    const running = withDistributedLease('sms:c1', async () => { await paused; assertDistributedLeaseActive(); send(); }, { ttlMs: 1000, heartbeat: false });
    const rejected = expect(running).rejects.toMatchObject({ code: 'DISTRIBUTED_LEASE_LOST' });
    await jest.advanceTimersByTimeAsync(1001);
    resume(); await rejected;
    expect(send).not.toHaveBeenCalled();
  });

  test('renewal cannot revive an expired document with the same token', async () => {
    const expiredAt = Date.now() - 1;
    Lease.updateOne.mockImplementation(async filter => ({ matchedCount: expiredAt > filter.expiresAt.$gt.getTime() ? 1 : 0 }));
    await expect(renewDistributedLease('sms:c1', 'old-token')).resolves.toBe(false);
    expect(Lease.updateOne).toHaveBeenCalledWith(expect.objectContaining({ ownerToken: 'old-token', expiresAt: { $gt: expect.any(Date) } }), expect.any(Object));
  });

  test('lost heartbeat rejects even an operation that lacks a final assertion', async () => {
    Lease.updateOne.mockResolvedValue({ matchedCount: 0 });
    let resume;
    const running = withDistributedLease('sms:c1', () => new Promise(resolve => { resume = resolve; }), { ttlMs: 3000 });
    const rejected = expect(running).rejects.toMatchObject({ code: 'DISTRIBUTED_LEASE_LOST' });
    await jest.advanceTimersByTimeAsync(1000);
    resume('done'); await rejected;
  });
});
