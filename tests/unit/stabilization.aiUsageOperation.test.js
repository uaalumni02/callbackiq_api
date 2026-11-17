import { runAiUsageOperation } from '../../src/services/aiUsageOperation.service.js';
import { reserveAiUsage } from '../../src/services/communicationUsage.service.js';
import { beginCommunicationUsageReservation, markCommunicationProviderDispatch, commitCommunicationUsageReservation,
  releaseCommunicationUsageReservation, markCommunicationUsageUncertain } from '../../src/services/communicationUsageReservation.service.js';
jest.mock('../../src/services/communicationUsage.service.js', () => ({ reserveAiUsage: jest.fn() }));
jest.mock('../../src/services/communicationUsageReservation.service.js', () => ({ beginCommunicationUsageReservation: jest.fn(),
  markCommunicationProviderDispatch: jest.fn(), commitCommunicationUsageReservation: jest.fn(),
  releaseCommunicationUsageReservation: jest.fn(), markCommunicationUsageUncertain: jest.fn() }));
const reservation = { _id: 'journal', ownerToken: 'owner', state: 'pending' }, parameters = { business: { _id: 'business' }, source: 'test' };
beforeEach(() => {
  jest.resetAllMocks();
  reserveAiUsage.mockResolvedValue({ allowed: true, amount: 1, reservations: [{ _id: 'counter' }] });
  beginCommunicationUsageReservation.mockResolvedValue({ reservation, replayed: false });
  markCommunicationProviderDispatch.mockResolvedValue(reservation);
  commitCommunicationUsageReservation.mockResolvedValue({ ...reservation, state: 'committed' });
});
test('denied and unrecordable usage never invokes a model', async () => {
  const model = jest.fn(); reserveAiUsage.mockResolvedValueOnce({ allowed: false, reason: 'limit' });
  await expect(runAiUsageOperation(parameters, model)).rejects.toMatchObject({ statusCode: 429 });
  beginCommunicationUsageReservation.mockRejectedValueOnce(new Error('journal unavailable'));
  await expect(runAiUsageOperation(parameters, model)).rejects.toThrow('journal unavailable');
  expect(model).not.toHaveBeenCalled();
  // The journal helper already owns rollback on failure; do not decrement counters twice.
  expect(releaseCommunicationUsageReservation).not.toHaveBeenCalled();
});
test('a rejected provider call releases usage; a transport failure retains a durable uncertain charge', async () => {
  await expect(runAiUsageOperation(parameters, async () => { throw Object.assign(new Error('rejected'), { status: 400 }); })).rejects.toThrow('rejected');
  expect(releaseCommunicationUsageReservation).toHaveBeenCalledWith(expect.objectContaining({ reservation, providerRejected: true }));
  await expect(runAiUsageOperation(parameters, async () => { throw new Error('transport outcome unknown'); })).rejects.toThrow('transport');
  expect(markCommunicationUsageUncertain).toHaveBeenCalledWith(expect.objectContaining({ reservation }));
});
