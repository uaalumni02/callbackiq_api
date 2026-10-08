import Conversation from '../../models/conversation.js';
import { createAwaitedKeyBatch } from '../database/awaitedKeyBatch.js';
import { withSnapshotDefaults } from '../database/readOnlySnapshot.js';

// Only the five ingress bookkeeping fields use this path. Their values are
// normalized before submission and validated/cast through the public Model API.
// State/ownership/booking transitions retain their original query middleware.
const FIELDS = new Set(['lead', 'customerPhone', 'customerPhoneLookup', 'lastMessage', 'lastMessageAt']);
const batch = createAwaitedKeyBatch({ maxConcurrent: 4, execute: async rows => {
  if (rows.length === 1) {
    const row = rows[0];
    return [await Conversation.findOneAndUpdate(row.filter, row.update, { returnDocument: 'after', runValidators: true }).lean()];
  }
  const updates = await Promise.all(rows.map(row => Conversation.validate(row.update, Object.keys(row.update))));
  const result = await Conversation.bulkWrite(rows.map((row,i) => ({ updateOne: { filter: row.filter, update: { $set: updates[i] } } })), { ordered: false });
  if (result.matchedCount !== rows.length) throw new Error('SMS conversation update did not match its tenant');
  const saved = await Conversation.find({ $or: rows.map(row => row.filter) }).lean();
  const byId = new Map(saved.map(row => [String(row._id), row]));
  return rows.map(row => {
    const result = byId.get(String(row.filter._id));
    if (!result || String(result.business) !== String(row.filter.business)) throw new Error('Missing SMS conversation update readback');
    return result;
  });
} });
export async function updateSmsConversationSnapshot({ businessId, conversationId, update }) {
  if (!Conversation.schema || typeof Conversation.bulkWrite !== 'function' || Object.keys(update).some(k => !FIELDS.has(k))) {
    return Conversation.findByIdAndUpdate(conversationId, update, { returnDocument: 'after', runValidators: true });
  }
  const row = await batch.enqueue(String(conversationId), { filter: { _id: conversationId, business: businessId }, update });
  if (!row) throw new Error('SMS conversation disappeared before update');
  return withSnapshotDefaults(Conversation, row);
}
