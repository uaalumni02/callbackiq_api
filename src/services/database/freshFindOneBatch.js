import { createAwaitedKeyBatch } from './awaitedKeyBatch.js';
import { withSnapshotDefaults } from './readOnlySnapshot.js';

// Each branch is the original indexed find-one (filter, sort, limit). $unionWith
// shares the round trip, not the result or any cached state. Only opt-in ingress
// lookups use this; ordinary callers retain query middleware and documents.
export function createFreshFindOneBatch(Model, { sort, select, defaults = false } = {}) {
  const query = filter => {
    let q = Model.findOne(filter);
    if (sort) q = q.sort(sort);
    if (select) q = q.select(select);
    return q;
  };
  const batch = createAwaitedKeyBatch({ maxBatchSize: 32, maxConcurrent: 4, execute: async filters => {
    if (filters.length === 1) return [await query(filters[0]).lean()];
    const branch = (filter, index) => {
      // Query.cast preserves schema casting without using driver internals.
      const cast = Model.findOne(filter).cast(Model);
      return [{ $match: cast }, ...(sort ? [{ $sort: sort }] : []), { $limit: 1 },
        ...(select ? [{ $project: Object.fromEntries(select.split(/\s+/).filter(Boolean).map(k => [k, 1])) }] : []),
        { $project: { _id: 0, requestIndex: { $literal: index }, row: '$$ROOT' } }];
    };
    const pipeline = branch(filters[0], 0);
    filters.slice(1).forEach((filter, i) => pipeline.push({ $unionWith: {
      coll: Model.collection.name, pipeline: branch(filter, i + 1),
    } }));
    const rows = await Model.aggregate(pipeline);
    const result = filters.map(() => null);
    for (const row of rows) result[row.requestIndex] = row.row;
    return result;
  } });
  let next = 0;
  const find = async filter => {
    if (typeof Model.aggregate !== 'function' || !Model.schema) return query(filter);
    const row = await batch.enqueue(String(next++), filter);
    const result = defaults ? withSnapshotDefaults(Model, row) : row;
    if (!result || !select) return result;
    return Object.fromEntries(['_id', ...select.split(/\s+/).filter(Boolean)].filter(k => Object.hasOwn(result, k)).map(k => [k, result[k]]));
  };
  find.diagnostics = batch.diagnostics;
  return find;
}
