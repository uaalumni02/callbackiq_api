import mongoose from 'mongoose';
import Conversation from '../../src/models/conversation.js';
import { claimRecoveryIntroduction } from '../../src/services/messaging/recoveryIntroduction.service.js';
import { expireBookingOffer } from '../../src/workers/conversationLifecycle.worker.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testDb.js';
jest.mock('../../src/services/twilioSmsService.js', () => ({ sendSms: jest.fn() }));
beforeAll(connectTestDB, 60000);
afterEach(async () => { if (mongoose.connection.readyState === 1) await clearTestDB(); });
afterAll(async () => { if (mongoose.connection.readyState === 1) await closeTestDB(); });
test('concurrent distinct calls claim only one intro for a business/customer conversation', async () => {
  const business = new mongoose.Types.ObjectId();
  const _id = new mongoose.Types.ObjectId();
  await Conversation.collection.insertOne({ _id, business, status: 'open', aiEnabled: true, humanTakeover: false });
  const claims = await Promise.all(Array.from({ length: 10 }, () => claimRecoveryIntroduction({ businessId: business, conversationId: _id })));
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(await claimRecoveryIntroduction({ businessId: new mongoose.Types.ObjectId(), conversationId: _id })).toBe(false);
});
test('a stale worker cannot expire a newly refreshed offer', async () => {
  const _id = new mongoose.Types.ObjectId();
  const now = new Date();
  const oldExpiry = new Date(now.getTime() - 60000);
  const refreshedExpiry = new Date(now.getTime() - 1000);
  await Conversation.collection.insertOne({ _id, business: new mongoose.Types.ObjectId(), status: 'open', aiEnabled: true, humanTakeover: false, bookingState: { status: 'offering_slots', expiresAt: refreshedExpiry } });
  expect(await expireBookingOffer({ _id, bookingState: { status: 'offering_slots', expiresAt: oldExpiry } }, now)).toBe(false);
  expect((await Conversation.findById(_id)).bookingState.status).toBe('offering_slots');
});
