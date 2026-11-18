import mongoose from 'mongoose';
import Alert from '../../src/models/alert.js';
import Appointment from '../../src/models/appointment.js';
import CallLog from '../../src/models/callLog.js';
import Conversation from '../../src/models/conversation.js';
import Lead from '../../src/models/lead.js';
import Message from '../../src/models/message.js';
import { clearTestDB, closeTestDB, connectTestDB } from '../setup/testReplicaDb.js';

beforeAll(connectTestDB, 60000);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearTestDB();
});
afterAll(closeTestDB);

const id = () => new mongoose.Types.ObjectId();
const phone = '+14045550191';
const models = [
  [Alert, { type: 'customer_reply', title: 'Reply', message: 'Received' }],
  [Appointment, { serviceOffering: id(), customerPhone: phone, status: 'held' }],
  [CallLog, { direction: 'inbound', from: phone, to: '+14045550192' }],
  [Conversation, { customerPhone: phone }],
  [Lead, { phone, serviceNeeded: 'Heating repair' }],
  [Message, { direction: 'inbound', from: phone, to: '+14045550192', body: 'Synthetic inbound message' }],
];

async function fixture(Model, values, session) {
  const business = id();
  const lead = id();
  const conversation = id();
  const now = new Date();
  if (Model !== Lead) await Lead.collection.insertOne({ _id: lead, business, phone, status: 'new' }, { session });
  if (Model === Message) {
    await Conversation.collection.insertOne({ _id: conversation, business, lead, customerPhone: phone }, { session });
  }
  return {
    _id: Model === Lead ? lead : id(), business, lead, conversation: Model === Message ? conversation : undefined,
    ...(Model === Appointment ? { startAt: new Date(+now + 3600000), endAt: new Date(+now + 7200000), idempotencyKey: String(id()) } : {}),
    createdAt: now, updatedAt: now, ...values,
  };
}

const operations = [
  ['save', (Model, row, options) => new Model(row).save(options)],
  ['hydrate insert', (Model, row, options) => Model.insertMany([row], options)],
  ['lean insert', (Model, row, options) => Model.insertMany([row], { ...options, lean: true })],
  ['lean query upsert', (Model, { updatedAt, ...row }, options) => Model.findOneAndUpdate(
    { _id: row._id, business: row.business }, { $setOnInsert: row }, { ...options, upsert: true, returnDocument: 'after' },
  ).lean()],
];

test.each(models.map(([Model, values]) => [Model.modelName, Model, values]))(
  '%s projects hydrated and plain writes with and without an active session',
  async (_name, Model, values) => {
    for (const inTransaction of [false, true]) {
      const session = inTransaction ? await mongoose.startSession() : undefined;
      try {
        if (session) session.startTransaction();
        const options = session ? { session } : {};
        for (const [operation, write] of operations) {
          const row = await fixture(Model, values, session);
          await write(Model, row, options);
          const lead = await Lead.collection.findOne({ _id: row.lead, business: row.business }, options);
          const observed = Model === Message || Model === CallLog
            ? lead?.lastInboundActivityAt
            : lead?.workflowFlags?.computedAt;
          expect({ operation, observed }).toEqual({ operation, observed: expect.any(Date) });
        }
        if (Model === Conversation) {
          const row = await fixture(Model, values, session);
          await Model.collection.insertOne(row, options);
          await Model.bulkWrite([{ updateOne: {
            filter: { _id: row._id, business: row.business }, update: { $set: { status: 'closed' } },
          } }], options);
          const lead = await Lead.collection.findOne({ _id: row.lead, business: row.business }, options);
          expect(lead?.workflowFlags?.computedAt).toBeInstanceOf(Date);
        }
      } finally {
        if (session) {
          if (session.inTransaction()) await session.abortTransaction();
          await session.endSession();
        }
      }
    }
  }, 60000,
);

test.each([false, true])('projection fault with transaction=%s preserves the primary write contract', async inTransaction => {
  const session = inTransaction ? await mongoose.startSession() : undefined;
  const error = new Error('synthetic projection failure');
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    if (session) session.startTransaction();
    const row = await fixture(Alert, models[0][1], session);
    const update = jest.spyOn(Lead.collection, 'updateOne').mockRejectedValueOnce(error);
    const result = Alert.insertMany([row], { lean: true, session });
    if (session) {
      await expect(result).rejects.toBe(error);
      await session.abortTransaction();
      expect(await Alert.exists({ _id: row._id, business: row.business })).toBeNull();
    } else {
      await expect(result).resolves.toHaveLength(1);
      expect(await Alert.exists({ _id: row._id, business: row.business })).not.toBeNull();
      expect(log).toHaveBeenCalledWith('[lead.workflow_flags.failed]', expect.any(Object));
    }
    expect(update.mock.calls[0][2].session === session).toBe(true);
  } finally {
    if (session) {
      if (session.inTransaction()) await session.abortTransaction();
      await session.endSession();
    }
  }
});
