import Business from '../../models/business.js';
import { sameTurnBatch } from './sameTurnBatch.js';

export const readFreshFollowUpSettings = sameTurnBatch(async ids => {
  if (ids.length === 1) {
    return [await Business.findById(ids[0]).select('features.automatedFollowUpEnabled').lean()];
  }
  const rows = await Business.find({ _id: { $in: ids } })
    .select('features.automatedFollowUpEnabled').lean();
  const byId = new Map(rows.map(row => [String(row._id), row]));
  return ids.map(id => {
    const row = byId.get(String(id));
    // Do not share mutable feature objects between callers for the same business.
    return row ? { _id: row._id, features: { automatedFollowUpEnabled: row.features?.automatedFollowUpEnabled } } : null;
  });
}, { name: "followUpSettings" });
