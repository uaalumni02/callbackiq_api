import Counter from '../../models/communicationRouteRateLimit.js';
import { createAwaitedKeyBatch } from './awaitedKeyBatch.js';

const reserveOne = async ({ filter, update }) => {
  try { return Boolean(await Counter.findOneAndUpdate(filter, update, { upsert: true, returnDocument: 'after' }).lean()); }
  catch (error) {
    if (error.code !== 11000) throw error;
    // A concurrent process may have inserted a still-under-limit counter.
    // Retry its conditional increment, without upsert; an exhausted counter
    // remains a no-op. A duplicate error alone does not prove exhaustion.
    return Boolean(await Counter.findOneAndUpdate(filter, { $inc: update.$inc }, { returnDocument: 'after' }).lean());
  }
};
const batch = createAwaitedKeyBatch({ maxConcurrent: 4, execute: async rows => {
  if (rows.length === 1) return [await reserveOne(rows[0])];
  let failures = new Map();
  try {
    const result = await Counter.bulkWrite(rows.map(row => ({ updateOne: { ...row, upsert: true } })), { ordered: false });
    if (result.matchedCount + result.upsertedCount !== rows.length) throw new Error('Incomplete rate-limit reservation');
  } catch (error) {
    const writes = (error.writeErrors || []).map(e => ({ ...(e.err || e), index: e.index ?? e.err?.index }));
    if (!writes.length || error.result?.getWriteConcernError?.() || writes.some(e => e.code !== 11000 || !Number.isInteger(e.index) || e.index < 0 || e.index >= rows.length) ||
        error.result?.matchedCount + error.result?.upsertedCount !== rows.length - writes.length) throw error;
    failures = new Map(writes.map(e => [e.index, e]));
  }
  return Promise.all(rows.map((row, i) => failures.has(i)
    ? Counter.findOneAndUpdate(row.filter, { $inc: row.update.$inc }, { returnDocument: 'after' }).lean().then(Boolean)
    : true));
} });
export const reserveMongoRouteCounter = (identity, max, expiresAt) => batch.enqueue(
  `${identity.name}:${identity.keyHash}:${identity.windowStart.getTime()}`,
  { filter: { ...identity, $or: [{ count: { $lt: max } }, { count: { $exists: false } }] },
    update: { $setOnInsert: { ...identity, expiresAt }, $inc: { count: 1 } } },
);
