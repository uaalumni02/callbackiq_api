import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import Reservation from '../../src/models/communicationUsageReservation.js';
import { markCommunicationProviderDispatch, commitCommunicationUsageReservation,
  markCommunicationUsageUncertain, sweepExpiredCommunicationReservations,
  releaseCommunicationUsageReservation } from '../../src/services/communicationUsageReservation.service.js';
import { reconcileSmsProviderReceipt } from '../../src/services/messaging/smsProviderReceipt.service.js';
let mongo;
beforeAll(async () => {
  mongo = new MongoMemoryReplSet({ binary: { version: '7.0.24' }, replSet: { count: 1 } });
  await mongo.start(); await mongoose.connect(mongo.getUri()); await Reservation.init();
}, 120000);
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });
const create = extra => Reservation.create({ business: new mongoose.Types.ObjectId(), operationKey: crypto.randomUUID(),
  metric: 'sms_outbound', amount: 1, state: 'pending', ownerToken: crypto.randomUUID(),
  leaseExpiresAt: new Date(Date.now() + 60000), purgeAt: new Date(Date.now() + 86400000), ...extra });

test('two competing dispatches have exactly one durable winner', async () => {
  const row = await create();
  const results = await Promise.allSettled([markCommunicationProviderDispatch({ reservation: row }), markCommunicationProviderDispatch({ reservation: row })]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
});
test('restart sweep preserves a dispatched send instead of enabling a duplicate', async () => {
  const row = await create(); await markCommunicationProviderDispatch({ reservation: row, body: 'Original body' });
  await Reservation.updateOne({ _id: row._id }, { $set: { leaseExpiresAt: new Date(0) } });
  await sweepExpiredCommunicationReservations();
  expect((await Reservation.findById(row._id)).state).toBe('uncertain');
  await expect(markCommunicationProviderDispatch({ reservation: row })).rejects.toMatchObject({ deliveryUncertain: true });
});
test('late uncertainty cannot downgrade an accepted receipt', async () => {
  const row = await create(); await markCommunicationProviderDispatch({ reservation: row });
  await commitCommunicationUsageReservation({ reservation: row, providerOperationId: 'SMreceipt' });
  await markCommunicationUsageUncertain({ reservation: row, error: { code: 'LATE_DB_ERROR' } });
  expect(await Reservation.findById(row._id)).toMatchObject({ state: 'committed', providerOperationId: 'SMreceipt' });
});
test('old owner cannot overwrite a new dispatch owner', async () => {
  const row = await create();
  await Reservation.updateOne({ _id: row._id }, { $set: { ownerToken: 'new-owner' } });
  expect(await commitCommunicationUsageReservation({ reservation: row, providerOperationId: 'SMold' })).toBeNull();
});
test('legacy pending records without a dispatch boundary are conservatively retained', async () => {
  const row = await create({ leaseExpiresAt: new Date(0) });
  await Reservation.collection.updateOne({ _id: row._id }, { $unset: { providerDispatchStartedAt: '' } });
  await sweepExpiredCommunicationReservations();
  expect((await Reservation.findById(row._id)).state).toBe('uncertain');
});
test('a delayed rejection cannot release the next owner of a reused reservation', async () => {
  const row = await create();
  const nextOwner = crypto.randomUUID();
  await Reservation.updateOne({ _id: row._id }, { $set: { ownerToken: nextOwner } });
  await releaseCommunicationUsageReservation({ reservation: row, providerRejected: true });
  expect(await Reservation.findById(row._id)).toMatchObject({ state: 'pending', ownerToken: nextOwner });
});
test('a signed callback from the previous owner cannot settle the new dispatch', async () => {
  const row = await create();
  const to = '+14045550101';
  await markCommunicationProviderDispatch({ reservation: row, to, body: 'Original body' });
  const nextOwner = crypto.randomUUID();
  await Reservation.updateOne({ _id: row._id }, { $set: { ownerToken: nextOwner } });
  const request = { businessId: row.business, reservationId: row._id,
    payload: { MessageSid: 'SM' + 'a'.repeat(32), MessageStatus: 'delivered', To: to } };
  expect(await reconcileSmsProviderReceipt({ ...request, ownerToken: row.ownerToken })).toBeNull();
  expect(await reconcileSmsProviderReceipt({ ...request, ownerToken: nextOwner })).toMatchObject({ state: 'committed' });
});
