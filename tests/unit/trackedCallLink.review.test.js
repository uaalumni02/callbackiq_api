import mongoose from 'mongoose';
import CallLog from '../../src/models/callLog.js';
import Lead from '../../src/models/lead.js';
import { linkRecentTrackedCalls } from '../../src/services/messaging/trackedCallLink.service.js';
jest.mock('../../src/models/callLog.js', () => ({ __esModule: true, default: { updateMany: jest.fn(), findOne: jest.fn() } }));
jest.mock('../../src/models/lead.js', () => ({ __esModule: true, default: { updateOne: jest.fn() } }));
const oid = () => new mongoose.Types.ObjectId();
beforeEach(() => jest.clearAllMocks());
test('later SMS link is bounded and never overwrites assigned lead, first source, or recovery outcome', async () => {
  const args = { businessId: oid(), leadId: oid(), conversationId: oid(), phone: '(678) 576-8258', now: new Date('2026-10-04') };
  const original = { marketingSource: oid(), trackingNumber: oid(), attribution: { sourceName: 'Search' } };
  const q = { sort: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue(original) };
  CallLog.findOne.mockReturnValue(q);
  await linkRecentTrackedCalls(args);
  expect(CallLog.updateMany).toHaveBeenCalledWith(expect.objectContaining({ business: args.businessId, from: '+16785768258', lead: null, deletedAt: null, trackingNumber: { $ne: null }, createdAt: { $gte: new Date('2026-09-04'), $lte: args.now } }), { $set: { lead: args.leadId, conversation: args.conversationId } });
  expect(Lead.updateOne).toHaveBeenCalledWith({ _id: args.leadId, business: args.businessId, firstTrackingNumber: null, firstMarketingSource: null }, expect.objectContaining({ $set: expect.objectContaining({ firstMarketingSource: original.marketingSource }) }));
});
test('rejects invalid identity without querying or writing', async () => {
  await linkRecentTrackedCalls({ businessId: 'bad', leadId: oid(), conversationId: oid(), phone: '+16785768258' });
  expect(CallLog.updateMany).not.toHaveBeenCalled(); expect(Lead.updateOne).not.toHaveBeenCalled();
});
