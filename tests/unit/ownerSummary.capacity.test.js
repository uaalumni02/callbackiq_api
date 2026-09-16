import mongoose from 'mongoose';
import Lead from '../../src/models/lead.js';
import ScaleCache from '../../src/services/scaleCache.service.js';
import { queryOwnerOpportunities, ownerWorkflowPipeline, opportunityFlags } from '../../src/services/scale/ownerOpportunityQuery.service.js';
const business = { _id: new mongoose.Types.ObjectId(), features: {} };
const cache = new Map();
beforeEach(() => {
  jest.spyOn(ScaleCache, 'getOrLoad').mockImplementation(async ({ key, loader }) => {
    if (!cache.has(key)) cache.set(key, await loader());
    return cache.get(key);
  });
  jest.spyOn(Lead, 'aggregate').mockImplementation(pipeline => ({ option: async () => {
    if (pipeline.at(-1)?.$group?._id === '$status') return [{ _id: 'new', count: 3 }, { _id: 'booked', count: 100000 }, { _id: 'lost', count: 7 }];
    if (pipeline.at(-1)?.$group?.needsMe) return [{ readyToSchedule: 1, needsMe: 2, waiting: 0 }];
    if (pipeline.at(-1)?.$count) return [{ value: 1 }];
    return [];
  } }));
});
afterEach(() => { cache.clear(); jest.restoreAllMocks(); });
test('tab switches and distinct search terms reuse one tenant workflow summary', async () => {
  const options = { business, interventionFilter: { resolvedAt: null } };
  for (const view of ['all', 'active', 'ready', 'waiting', 'needs_me', 'booked', 'not_booked']) {
    const page = await queryOwnerOpportunities({ ...options, view });
    expect(page.stats).toMatchObject({ active: 3, booked: 100000 });
    expect(page.pagination.total).toBe({all:100010,active:3,ready:1,waiting:0,needs_me:2,booked:100000,not_booked:7}[view]);
  }
  for (const search of ['repair', 'different']) expect((await queryOwnerOpportunities({ ...options, search })).pagination.total).toBe(1);
  expect(Lead.aggregate.mock.calls.filter(([p]) => p.at(-1)?.$group?.needsMe)).toHaveLength(1);
});
test('different tenant and booking policy never reuse a summary', async () => {
  for (const b of [business, { ...business, features: { aiBookingEnabled: true } }, { ...business, _id: new mongoose.Types.ObjectId() }]) {
    await queryOwnerOpportunities({ business: b, interventionFilter: {} });
  }
  expect(Lead.aggregate.mock.calls.filter(([p]) => p.at(-1)?.$group?.needsMe)).toHaveLength(3);
});
test('workflow aggregation excludes historical closed leads before lookups', () => {
  const pipeline = ownerWorkflowPipeline(business._id, opportunityFlags(business._id, {}, false));
  expect(pipeline[0]).toEqual({ $match: { business: business._id, status: { $in: ['new', 'contacted'] } } });
});
