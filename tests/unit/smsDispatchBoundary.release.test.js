import Reservation from '../../src/models/communicationUsageReservation.js';
import { markCommunicationProviderDispatch, commitCommunicationUsageReservation,
  markCommunicationUsageUncertain, releaseCommunicationUsageReservation,
  sweepExpiredCommunicationReservations, isUncertainProviderFailure } from '../../src/services/communicationUsageReservation.service.js';

jest.mock('../../src/models/communicationUsageReservation.js', () => ({ __esModule: true, default: {
  findOne: jest.fn().mockResolvedValue(null), findOneAndUpdate: jest.fn(), findById: jest.fn(), find: jest.fn(),
} }));
const row = { _id: 'r1', ownerToken: 'owner-1', state: 'pending', operationKey: 'sms:b1:1' };
beforeEach(() => jest.clearAllMocks());

test('provider dispatch is fenced by owner, live lease, and an unused boundary', async () => {
  Reservation.findOneAndUpdate.mockResolvedValue({ ...row, providerDispatchStartedAt: new Date() });
  await markCommunicationProviderDispatch({ reservation: row, from: '+14045550100', to: '+14045550101', body: 'Original body' });
  expect(Reservation.findOneAndUpdate).toHaveBeenCalledWith({ _id: 'r1', ownerToken: 'owner-1', state: 'pending',
    providerDispatchStartedAt: null, leaseExpiresAt: { $gt: expect.any(Date) } },
    { $set: { providerDispatchStartedAt: expect.any(Date), 'metadata.providerRequest': { from: '+14045550100', to: '+14045550101', body: 'Original body' } } },
    { returnDocument: 'after' });
});
test('expired or already dispatched reservation cannot start another send', async () => {
  Reservation.findOneAndUpdate.mockResolvedValue(null);
  await expect(markCommunicationProviderDispatch({ reservation: row })).rejects.toMatchObject({ deliveryUncertain: true });
});
test('missing durable owner blocks dispatch before any write', async () => {
  await expect(markCommunicationProviderDispatch({ reservation: { _id: 'r1' } })).rejects.toMatchObject({ code: 'SMS_DISPATCH_RESERVATION_REQUIRED' });
  expect(Reservation.findOneAndUpdate).not.toHaveBeenCalled();
});
test('uncertainty cannot overwrite a committed receipt or a new owner', async () => {
  Reservation.findOneAndUpdate.mockResolvedValue(null);
  await markCommunicationUsageUncertain({ reservation: row, error: { code: 'DB_FAILURE' }, providerOperationId: 'SMreceipt' });
  expect(Reservation.findOneAndUpdate).toHaveBeenCalledWith({ _id: 'r1', ownerToken: 'owner-1', state: { $in: ['pending', 'uncertain'] } },
    expect.objectContaining({ $set: expect.objectContaining({ state: 'uncertain', providerOperationId: 'SMreceipt' }) }), { returnDocument: 'after' });
});
test('late provider acceptance cannot commit a reclaimed operation', async () => {
  Reservation.findOneAndUpdate.mockResolvedValue(null);
  await commitCommunicationUsageReservation({ reservation: row, providerOperationId: 'SMreceipt' });
  expect(Reservation.findOneAndUpdate.mock.calls[0][0]).toMatchObject({ ownerToken: 'owner-1', state: { $in: ['pending', 'uncertain'] } });
});
test('automatic release only claims records proving dispatch has not begun', async () => {
  Reservation.findOneAndUpdate.mockResolvedValue(null);
  Reservation.findById.mockResolvedValue({ ...row, providerDispatchStartedAt: new Date() });
  await releaseCommunicationUsageReservation({ reservation: row });
  expect(Reservation.findOneAndUpdate.mock.calls[0][0].$or[0]).toMatchObject({ providerDispatchStartedAt: { $eq: null, $exists: true } });
});
test('a delayed conclusive rejection can only release its original dispatch owner', async () => {
  Reservation.findOneAndUpdate.mockResolvedValue(null);
  Reservation.findById.mockResolvedValue({ ...row, ownerToken: 'new-owner' });
  await releaseCommunicationUsageReservation({ reservation: row, providerRejected: true });
  expect(Reservation.findOneAndUpdate.mock.calls[0][0].$or[0]).toEqual({
    state: { $in: ['pending'] }, ownerToken: row.ownerToken,
  });
});
test.each([new Date(), undefined])('expiration preserves both dispatched and legacy unknown outcomes (%p)', async dispatchAt => {
  const query = { sort: jest.fn(), limit: jest.fn(), select: jest.fn(), lean: jest.fn().mockResolvedValue([{ ...row, providerDispatchStartedAt: dispatchAt }]) };
  query.sort.mockReturnValue(query); query.limit.mockReturnValue(query); query.select.mockReturnValue(query);
  Reservation.find.mockReturnValue(query);
  Reservation.findOneAndUpdate.mockResolvedValue({ ...row, state: 'uncertain' });
  expect(await sweepExpiredCommunicationReservations()).toEqual({ inspected: 1, released: 0 });
  expect(Reservation.findOneAndUpdate).toHaveBeenCalledTimes(1);
  expect(Reservation.findOneAndUpdate.mock.calls[0][1].$set.state).toBe('uncertain');
});
test.each([500, 502, 503, 504])('HTTP %s cannot prove a provider rejected the send', status => {
  expect(isUncertainProviderFailure({ status })).toBe(true);
});
