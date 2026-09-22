import '../../src/models/business.js';
import '../../src/models/lead.js';
import mongoose from 'mongoose';
import Conversation from '../../src/models/conversation.js';
import Alert from '../../src/models/alert.js';
import AlertService from '../../src/services/alert.service.js';
import ProductionOperationLease from '../../src/models/productionOperationLease.js';
import { reconcileConversationStaffReview, reconcileStaffReviewPage } from '../../src/services/staffReviewReconciliation.service.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testDb.js';
jest.mock('../../src/services/socket.service.js', () => ({ __esModule: true, default: { emitAlertCreated: jest.fn(), emitDashboardRefresh: jest.fn() } }));
let business, conversation;
beforeAll(async () => { await connectTestDB(); await Alert.init(); await ProductionOperationLease.init(); }, 60000);
beforeEach(async () => {
  business = new mongoose.Types.ObjectId();
  conversation = await Conversation.create({ business, customerPhone: '+14045550123', status: 'open',
    conversationMemory: { recoveryIntake: { reviewReady: true, review: { status: 'pending_persistence' }, serviceNeeded: 'Leaking pipe', address: '1 Test Road', preferredAppointmentTime: 'Tomorrow at noon' } } });
});
afterEach(async () => { jest.restoreAllMocks(); await clearTestDB(); });
afterAll(closeTestDB);
const run = apply => reconcileConversationStaffReview({ businessId: business, conversationId: conversation._id, apply });
test('audit is read-only; concurrent recovery and repeat invocation persist exactly one linked review', async () => {
  expect(await run(false)).toMatchObject({ status: 'missing' });
  expect(await Alert.countDocuments()).toBe(0);
  await Promise.all(Array.from({ length: 8 }, () => run(true)));
  expect(await Alert.countDocuments({ business, conversation: conversation._id })).toBe(1);
  expect(await run(true)).toMatchObject({ status: 'present' });
  const alert = await Alert.findOne({ business });
  expect(alert.actionRequired).toBe(true);
  expect(alert.metadata.recoveredReview).toBe(true);
  const saved = await Conversation.findById(conversation._id);
  expect(saved.conversationMemory.recoveryIntake.preferredAppointmentTime).toBe('Tomorrow at noon');
  expect(saved.bookingState?.status).not.toBe('booked');
});
test('failed persistence remains recoverable on the next pass', async () => {
  const create = jest.spyOn(AlertService, 'create').mockRejectedValueOnce(new Error('database disconnected'));
  await expect(run(true)).rejects.toThrow('database disconnected');
  expect(await Alert.countDocuments()).toBe(0);
  create.mockRestore();
  expect(await run(true)).toMatchObject({ status: 'recovered' });
});
test('a handled review is not recreated and another tenant cannot recover this conversation', async () => {
  await run(true);
  await Alert.updateMany({ business }, { $set: { resolvedAt: new Date() } });
  expect(await run(true)).toMatchObject({ status: 'handled' });
  expect(await reconcileConversationStaffReview({ businessId: new mongoose.Types.ObjectId(), conversationId: conversation._id, apply: true })).toMatchObject({ status: 'not_required' });
  expect(await Alert.countDocuments()).toBe(1);
});
test('closed and withdrawn requests are not reopened', async () => {
  await Conversation.updateOne({ _id: conversation._id }, { $set: { status: 'closed' } });
  expect(await run(true)).toMatchObject({ status: 'not_required' });
  await Conversation.updateOne({ _id: conversation._id }, { $set: { status: 'open', 'conversationMemory.recoveryIntake.withdrawnAt': new Date() } });
  expect(await run(true)).toMatchObject({ status: 'not_required' });
  expect(await Alert.countDocuments()).toBe(0);
});
test('a seek page moves beyond already handled records instead of starving later requests', async () => {
  await Conversation.collection.updateOne({ _id: conversation._id }, { $set: { updatedAt: new Date(0) } });
  const first = await reconcileStaffReviewPage({ businessId: business, limit: 1, apply: true });
  expect(first.scanned).toBe(1); expect(first.nextCursor).toBe(String(conversation._id));
  const next = await reconcileStaffReviewPage({ businessId: business, limit: 1, after: first.nextCursor, apply: true });
  expect(next.scanned).toBe(0); expect(next.nextCursor).toBeNull();
});
