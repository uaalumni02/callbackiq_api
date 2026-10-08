import mongoose from 'mongoose';
import Message from '../../src/models/message.js';
import { withMessageInsertDefaults } from '../../src/services/database/messageInsertDefaults.js';
import { persistInboundSmsMessage, smsIngressPersistenceDiagnostics } from '../../src/services/messaging/smsIngressPersistence.service.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testDb.js';

beforeAll(async () => { await connectTestDB(); await Message.init(); }, 60000);
afterEach(async () => { jest.restoreAllMocks(); await clearTestDB(); }, 30000);
afterAll(async () => { await closeTestDB(); }, 30000);

const input = (business = new mongoose.Types.ObjectId(), sid = 'SM_TEST', processingRequired = false) => {
  const filter = { business, providerMessageId: sid };
  const update = { $set: { 'metadata.processingRequired': processingRequired, 'metadata.twilioOptOutType': '' },
    $setOnInsert: { ...filter, conversation: new mongoose.Types.ObjectId(), lead: new mongoose.Types.ObjectId(),
      direction: 'inbound', generatedBy: 'customer', actorType: 'customer', from: '+14045550123', to: '+14045550124',
      body: 'My air conditioner needs repair', media: [], provider: 'twilio', status: 'received', deliveryStatus: 'received',
      segmentCount: 0, 'metadata.processingEnqueuedAt': null } };
  return [filter, update, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }];
};
const stable = row => {
  const { _id, createdAt, updatedAt, ...fields } = row;
  return JSON.parse(JSON.stringify(fields));
};

test('singleton preserves all persisted schema defaults, metadata, casts and timestamps', async () => {
  const args = input();
  const old = await Message.findOneAndUpdate(...args).lean();
  await Message.deleteMany({});
  const next = await persistInboundSmsMessage(...args).lean().exec();
  expect(stable(next)).toEqual(stable(old));
  expect(next.createdAt).toBeInstanceOf(Date);
  expect(next.updatedAt).toBeInstanceOf(Date);
  expect(typeof next.save).toBe('undefined');
});

test('burst coalesces database commands and returns the exact business-owned row for each caller', async () => {
  const businessA = new mongoose.Types.ObjectId(); const businessB = new mongoose.Types.ObjectId();
  const args = Array.from({ length: 128 }, (_, i) => input(i % 2 ? businessA : businessB, `SM_${Math.floor(i / 2)}`));
  const bulk = jest.spyOn(Message, 'bulkWrite');
  const reads = jest.spyOn(Message, 'find');
  const results = await Promise.all(args.map(values => persistInboundSmsMessage(...values)));
  expect(bulk.mock.calls.length).toBe(2);
  expect(reads.mock.calls.length).toBe(2);
  for (let i = 0; i < results.length; i++) {
    expect(String(results[i].business)).toBe(String(args[i][0].business));
    expect(results[i].providerMessageId).toBe(args[i][0].providerMessageId);
  }
  expect(await Message.countDocuments()).toBe(128);
  const native = await Message.findOneAndUpdate(...input(businessA, 'SM_NATIVE')).lean();
  const { business, conversation, lead, providerMessageId, ...nativeDefaults } = stable(native);
  const { business: b, conversation: c, lead: l, providerMessageId: s, ...batchDefaults } = stable(results[0]);
  expect(batchDefaults).toEqual(nativeDefaults);
  expect(smsIngressPersistenceDiagnostics().largestBatch).toBe(64);
});

test('same SID retries update processing intent without replacing intake or generating duplicates', async () => {
  const args = input();
  const first = await persistInboundSmsMessage(...args);
  await Message.updateOne({ _id: first._id }, { $set: { 'metadata.processingEnqueuedAt': new Date(), 'aiOutcome.outcome': 'saved' } });
  const retry = input(args[0].business, args[0].providerMessageId, true);
  retry[1].$setOnInsert.body = 'Must not replace the original';
  const [a, b] = await Promise.all([persistInboundSmsMessage(...retry), persistInboundSmsMessage(...retry)]);
  expect(String(a._id)).toBe(String(first._id)); expect(String(b._id)).toBe(String(first._id));
  expect(a.body).toBe(first.body); expect(a.metadata.processingRequired).toBe(true);
  expect(a.metadata.processingEnqueuedAt).toBeInstanceOf(Date); expect(a.aiOutcome.outcome).toBe('saved');
  expect(await Message.countDocuments()).toBe(1);
});

test('uncertain or partial bulk writes reject every caller, and retries recover unique persisted rows', async () => {
  const args = [input(undefined, 'SM_1'), input(undefined, 'SM_2')];
  const native = Message.bulkWrite.bind(Message);
  jest.spyOn(Message, 'bulkWrite').mockImplementationOnce(async operations => {
    await native([operations[0]]);
    throw new Error('simulated connection loss after partial commit');
  });
  const failed = await Promise.allSettled(args.map(values => persistInboundSmsMessage(...values)));
  expect(failed.every(result => result.status === 'rejected')).toBe(true);
  const results = await Promise.all(args.map(values => persistInboundSmsMessage(...values)));
  expect(results).toHaveLength(2); expect(await Message.countDocuments()).toBe(2);
});

test('persisted metadata is never replaced by its empty default when child fields are updated', () => {
  const [filter, update] = input();
  const prepared = withMessageInsertDefaults(Message, filter, update);
  expect(prepared.$setOnInsert.metadata).toBeUndefined();
  expect(prepared.$setOnInsert['metadata.processingEnqueuedAt']).toBeNull();
  expect(update.$setOnInsert.aiOutcome).toBeUndefined();
  const second = withMessageInsertDefaults(Message, filter, update);
  prepared.$setOnInsert.deliveryEvents.push({ providerStatus: 'test' });
  expect(second.$setOnInsert.deliveryEvents).toEqual([]);
});

test('readback failure cannot falsely complete webhook persistence', async () => {
  const args = [input(undefined, 'SM_1'), input(undefined, 'SM_2')];
  jest.spyOn(Message, 'find').mockReturnValueOnce({ lean: async () => [] });
  const results = await Promise.allSettled(args.map(values => persistInboundSmsMessage(...values)));
  expect(results.every(result => result.status === 'rejected')).toBe(true);
});


test('batched MMS inserts retain media defaults and empty-text attachment content', async () => {
  const args = [input(undefined, 'SM_MMS_1'), input(undefined, 'SM_MMS_2')];
  for (const row of args) {
    row[1].$setOnInsert.body = '';
    row[1].$setOnInsert.media = [{ providerUrl: 'https://example.test/media', providerIndex: 0 }];
  }
  const results = await Promise.all(args.map(row => persistInboundSmsMessage(...row)));
  expect(results.every(row => row.body === '' && row.media[0].contentType === 'application/octet-stream' && row.media[0].storageStatus === 'provider')).toBe(true);
});
