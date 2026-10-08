import crypto from 'node:crypto';
import WebhookEvent from '../../models/webhookEvent.js';
import { createAwaitedKeyBatch } from '../database/awaitedKeyBatch.js';

// The receipt proves which conditional write matched. Aggregate bulk matched
// counts cannot safely identify a stale lease, so they are never used as proof.
const batch = createAwaitedKeyBatch({ execute: async rows => {
  if (rows.length === 1) {
    const row = rows[0];
    return [await WebhookEvent.findOneAndUpdate(row.filter, row.update, row.options).lean()];
  }
  await WebhookEvent.bulkWrite(rows.map(row => ({ updateOne: {
    filter: row.filter, update: row.update,
  } })), { ordered: false });
  const persisted = await WebhookEvent.find({ $or: rows.map(row => ({
    _id: row.filter._id, status: 'completed', settlementReceipt: row.receipt,
  })) }).lean();
  const byReceipt = new Map(persisted.map(row => [row.settlementReceipt, row]));
  return rows.map(row => byReceipt.get(row.receipt) || null);
} });

export const webhookSettlementDiagnostics = () => batch.diagnostics();
export function settleWebhookEvent(filter, update, options) {
  if (!WebhookEvent.schema?.path('settlementReceipt') || typeof WebhookEvent.bulkWrite !== 'function') {
    return WebhookEvent.findOneAndUpdate(filter, update, options);
  }
  const receipt = crypto.randomUUID();
  const persisted = batch.enqueue(String(filter._id), {
    filter, options, receipt,
    update: { ...update, $set: { ...update.$set, settlementReceipt: receipt } },
  });
  persisted.lean = () => persisted;
  persisted.exec = () => persisted;
  return persisted;
}
