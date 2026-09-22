import mongoose from 'mongoose';
import Alert from '../../src/models/alert.js';
import { ownerAttentionPipeline } from '../../src/services/ownerExperience.service.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testDb.js';
beforeAll(connectTestDB, 60000);
afterEach(clearTestDB);
afterAll(closeTestDB);
const id = () => new mongoose.Types.ObjectId();
const issue = (business, extra = {}) => ({ _id: id(), business, type: 'human_requested', resolvedAt: null,
  priority: 'high', createdAt: new Date(), ...extra });
const summary = async (business, limit) => (await Alert.aggregate(ownerAttentionPipeline(business, limit)))[0];
test('distinct triggers in one conversation yield one customer, two issues and the highest-priority representative', async () => {
  const business = id(), conversation = id();
  const high = issue(business, { conversation, priority: 'critical' });
  await Alert.collection.insertMany([issue(business, { conversation }), high,
    issue(id(), { conversation }), issue(business, { conversation, resolvedAt: new Date() })]);
  const result = await summary(business);
  expect(result.totals[0]).toMatchObject({ count: 1, issueCount: 2 });
  expect(result.preview).toHaveLength(1);
  expect(result.preview[0].representative._id).toEqual(high._id);
  expect(await Alert.countDocuments()).toBe(4);
});
test('grouping precedes limits even with more than 250 issues for one conversation', async () => {
  const business = id(), conversation = id();
  await Alert.collection.insertMany([...Array.from({ length: 251 }, () => issue(business, { conversation })),
    ...Array.from({ length: 5 }, () => issue(business, { conversation: id() }))]);
  const result = await summary(business);
  expect(result.totals[0]).toMatchObject({ count: 6, issueCount: 256 });
  expect(result.preview).toHaveLength(5);
});
test('separate conversations stay distinct; lead-only issues group; unlinked issues stay independent', async () => {
  const business = id(), lead = id();
  await Alert.collection.insertMany([issue(business, { conversation: id(), lead }), issue(business, { conversation: id(), lead }),
    issue(business, { lead }), issue(business, { lead }), issue(business), issue(business)]);
  expect((await summary(business)).totals[0]).toMatchObject({ count: 5, issueCount: 6 });
});
