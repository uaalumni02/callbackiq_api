import mongoose from 'mongoose';
import { withRequestStateTransaction, requestStateRead, requestStateOptions, requestStateWrite } from '../../src/services/booking/requestStateTransaction.service.js';
import { assertDistributedLeaseActive } from '../../src/services/distributedLease.service.js';
jest.mock('../../src/services/distributedLease.service.js', () => ({ assertDistributedLeaseActive: jest.fn() }));
afterEach(() => jest.restoreAllMocks());
beforeEach(() => jest.clearAllMocks());

test('[state-writer-pins] the owner binds reads/writes and does not leak a transaction session', async () => {
  const session = { id: 'attempt-1' };
  jest.spyOn(mongoose.connection, 'transaction').mockImplementation(command => command(session));
  const query = { session: jest.fn(function () { return this; }) };
  const model = { updateOne: jest.fn(async () => ({ modifiedCount: 1 })) };
  await withRequestStateTransaction(async () => {
    expect(requestStateRead(query)).toBe(query);
    await requestStateWrite({ model, method: 'updateOne', filter: { _id: 'record', business: 'tenant' },
      changes: { $set: { status: 'resolved' } }, options: { runValidators: true } });
    expect(requestStateOptions()).toEqual({ session });
  }, { guardAtCommit: true });
  expect(query.session).toHaveBeenCalledWith(session);
  expect(model.updateOne).toHaveBeenCalledWith({ _id: 'record', business: 'tenant' }, { $set: { status: 'resolved' } },
    { runValidators: true, session });
  expect(assertDistributedLeaseActive).toHaveBeenCalledTimes(1);
  expect(requestStateOptions()).toEqual({});
  requestStateRead(query);expect(query.session).toHaveBeenLastCalledWith(null);
});

test('[state-writer-pins] replay without writes retains the previous no-final-fence behavior', async () => {
  jest.spyOn(mongoose.connection, 'transaction').mockImplementation(command => command({ id: 'read-only-replay' }));
  await withRequestStateTransaction(async () => 'already-applied', { guardAtCommit: true });
  expect(assertDistributedLeaseActive).not.toHaveBeenCalled();
});

test('[state-writer-pins] independent transaction attempts retain distinct sessions', async () => {
  let attempt = 0;
  jest.spyOn(mongoose.connection, 'transaction').mockImplementation(command => command({ id: ++attempt }));
  const execute = () => withRequestStateTransaction(async () => {
    await Promise.resolve();return requestStateOptions().session.id;
  });
  expect(await Promise.all([execute(), execute()])).toEqual([1, 2]);
  expect(requestStateOptions()).toEqual({});
});

test('[state-writer-pins] callback failures propagate and explicit legacy sessions remain compatible', async () => {
  const session = { id: 'attempt' }, legacy = { id: 'legacy' }, failure = Error('Synthetic transaction failure');
  jest.spyOn(mongoose.connection, 'transaction').mockImplementation(command => command(session));
  await expect(withRequestStateTransaction(async () => {
    expect(requestStateOptions(legacy)).toEqual({ session: legacy });throw failure;
  })).rejects.toBe(failure);
  expect(requestStateOptions()).toEqual({});
  expect(() => requestStateWrite({ model: {}, method: 'deleteMany', filter: {}, changes: {} })).toThrow('Unsupported request-state write');
});
