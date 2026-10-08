import Reservation from '../../src/models/communicationUsageReservation.js';
import { reconcileSmsProviderReceipt } from '../../src/services/messaging/smsProviderReceipt.service.js';
import { commitCommunicationUsageReservation } from '../../src/services/communicationUsageReservation.service.js';
jest.mock('../../src/models/communicationUsageReservation.js', () => ({ __esModule: true, default: { findOneAndUpdate: jest.fn(), findOne: jest.fn() } }));
const businessId = '64f000000000000000000001', reservationId = '64f000000000000000000002';
const ownerToken = '23b2c4d0-5053-48c7-8f2a-09e7727ea107';
const payload = { MessageSid: 'SM' + 'a'.repeat(32), MessageStatus: 'delivered', To: '+14045550101' };
beforeEach(() => jest.clearAllMocks());
test('signed receipt reconciliation fences tenant, recipient, dispatch state and previous receipt', async () => {
  Reservation.findOneAndUpdate.mockResolvedValue({ state: 'committed' });
  await reconcileSmsProviderReceipt({ businessId, reservationId, ownerToken, payload });
  expect(Reservation.findOneAndUpdate).toHaveBeenCalledWith({ _id: reservationId, business: businessId, ownerToken, metric: 'sms_outbound',
    state: { $in: ['pending', 'uncertain'] }, providerDispatchStartedAt: { $type: 'date' },
    'metadata.providerRequest.to': payload.To, providerOperationId: { $in: ['', payload.MessageSid] } },
    { $set: expect.objectContaining({ state: 'committed', providerOperationId: payload.MessageSid }) }, { returnDocument: 'after' });
});
test.each([
  [{ businessId, ownerToken, payload }], [{ businessId, ownerToken, reservationId: 'wrong', payload }],
  [{ businessId, reservationId, ownerToken, payload: { ...payload, MessageSid: 'garbage' } }],
  [{ businessId, reservationId, ownerToken, payload: { ...payload, To: 'invalid' } }],
  [{ businessId, reservationId, payload }],
  [{ businessId, reservationId, ownerToken: 'invalid', payload }],
])('malformed callback references never access the database (%#)', async (input) => {
  expect(await reconcileSmsProviderReceipt(input)).toBeNull(); expect(Reservation.findOneAndUpdate).not.toHaveBeenCalled();
});
test('a callback winning the race before the send response remains a successful commit', async () => {
  Reservation.findOneAndUpdate.mockResolvedValue(null);
  Reservation.findOne.mockResolvedValue({ state: 'committed', providerOperationId: payload.MessageSid });
  expect(await commitCommunicationUsageReservation({ reservation: { _id: reservationId, ownerToken: 'owner' }, providerOperationId: payload.MessageSid }))
    .toMatchObject({ state: 'committed' });
  expect(Reservation.findOne).toHaveBeenCalledWith({ _id: reservationId, state: 'committed', ownerToken: 'owner', providerOperationId: payload.MessageSid });
});
