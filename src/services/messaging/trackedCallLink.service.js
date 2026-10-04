import mongoose from 'mongoose';
import CallLog from '../../models/callLog.js';
import Lead from '../../models/lead.js';
import { normalizePhoneToE164 } from '../../voice/voicePhone.service.js';

// Link only recent, unassigned tracking calls within the same business and phone identity.
// An answered call remains answered: linking is attribution, not proof of recovery.
export async function linkRecentTrackedCalls({ businessId, leadId, conversationId, phone, now = new Date() }) {
  if (![businessId, leadId, conversationId].every(value => mongoose.isValidObjectId(value))) return;
  const normalized = normalizePhoneToE164(phone);
  if (!normalized) return;
  const since = new Date(now.getTime() - 30 * 86400000);
  await CallLog.updateMany({ business: businessId, from: normalized, lead: null,
    deletedAt: null, trackingNumber: { $ne: null }, createdAt: { $gte: since, $lte: now } },
    { $set: { lead: leadId, conversation: conversationId } });
  const earliest = await CallLog.findOne({ business: businessId, lead: leadId,
    trackingNumber: { $ne: null }, deletedAt: null }).sort({ createdAt: 1, _id: 1 })
    .select('marketingSource trackingNumber attribution').lean();
  if (!earliest) return;
  await Lead.updateOne({ _id: leadId, business: businessId, firstTrackingNumber: null, firstMarketingSource: null }, {
    $set: { firstMarketingSource: earliest.marketingSource || null,
      firstTrackingNumber: earliest.trackingNumber, firstAttribution: earliest.attribution || {} },
  });
}
