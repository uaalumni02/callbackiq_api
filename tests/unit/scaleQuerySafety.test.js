import mongoose from 'mongoose';
import { decodePage, encodePage, beforePage, finishPage } from '../../src/services/scale/queryBudget.js';
import { historyPipeline } from '../../src/services/scale/customerHistory.service.js';
import { opportunityFlags } from '../../src/services/scale/ownerOpportunityQuery.service.js';
const oid = () => new mongoose.Types.ObjectId();
test('continuation validates tenant, resource and date before any query', () => {
  const id = oid(), at = new Date(), scope = 'tenant:a:messages';
  const token = encodePage({ scope, id, at });
  expect(decodePage(token, scope)).toEqual({ id, at });
  for (const value of [token, 'not-json', 'x'.repeat(3000), encodePage({ scope: 'other', id, at })]) {
    expect(() => decodePage(value, 'tenant:b:messages')).toThrow();
  }
  expect(beforePage(decodePage(token, scope), 'createdAt').$or).toHaveLength(2);
});
test('equal timestamp pages use IDs and do not lose the extra row', () => {
  const at = new Date(), scope = 'example';
  const rows = Array.from({ length: 4 }, () => ({ _id: oid(), createdAt: at }));
  const result = finishPage(rows, 3, scope);
  expect(result.items).toHaveLength(3);
  expect(decodePage(result.pagination.nextCursor, scope).id).toEqual(rows[2]._id);
  expect(finishPage(rows, 4, scope).pagination).toMatchObject({ hasMore: false, nextCursor: null });
});
test('legacy customer history joins remain scoped on both sides', () => {
  const businessId = oid(), lead = { _id: oid(), phone: '+14045550123' };
  const pipeline = historyPipeline({ section: 'messages', businessId, lead });
  expect(pipeline[0].$match.$and[0].business).toEqual(businessId);
  const union = pipeline.find(x => x.$unionWith).$unionWith;
  expect(union.pipeline[0].$match.business).toEqual(businessId);
  const lookup = union.pipeline.find(x => x.$lookup).$lookup;
  expect(lookup.pipeline[0].$match.$and[0].business).toEqual(businessId);
  expect(lookup.pipeline[0].$match.$and[0].$nor).toEqual([{ lead: lead._id }]);
});
test('owner workflow lookups only retain one existence record per relationship', () => {
  const pipeline = opportunityFlags(oid(), { resolvedAt: null }, false);
  for (const stage of pipeline.filter(x => x.$lookup)) expect(stage.$lookup.pipeline).toContainEqual({ $limit: 1 });
  expect(pipeline.at(-1).$set._ready.$and[0]).toBe(true);
  expect(opportunityFlags(oid(), {}, true).at(-1).$set._ready.$and[0]).toBe(false);
});
