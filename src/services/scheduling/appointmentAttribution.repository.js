// Stage 3: exact original appointment attribution behavior, isolated for testing.
import mongoose from 'mongoose';
import Lead from '../../models/lead.js';
import CallLog from '../../models/callLog.js';
import { normalizePhoneToE164 } from '../../voice/voicePhone.service.js';

const emptyAppointmentAttribution = () => ({
  marketingSource: null,
  trackingNumber: null,
  attribution: {},
});

export const resolveAppointmentAttribution = async ({ businessId, input }) => {
  if (!mongoose.isValidObjectId(businessId)) return emptyAppointmentAttribution();
  // Acquisition credit is write-once first source. Calls still retain their
  // interaction source; never rewrite historical appointments on report reads.
  if (input?.lead && mongoose.isValidObjectId(input.lead)) {
    const lead = await Lead.findOne({ _id: input.lead, business: businessId })
      .select('firstMarketingSource firstTrackingNumber firstAttribution').lean();
    if (lead?.firstMarketingSource) return {
      marketingSource: lead.firstMarketingSource,
      trackingNumber: lead.firstTrackingNumber || null,
      attribution: lead.firstAttribution || {},
    };
  }
  const filter = { business: businessId, marketingSource: { $ne: null } };
  if (input?.lead) {
    if (!mongoose.isValidObjectId(input.lead)) return emptyAppointmentAttribution();
    filter.lead = input.lead;
  } else if (input?.customerPhone) {
    filter.from = normalizePhoneToE164(input.customerPhone);
    if (!filter.from) return emptyAppointmentAttribution();
  } else return {
    marketingSource: input?.marketingSource || null,
    trackingNumber: input?.trackingNumber || null,
    attribution: input?.attribution || {},
  };
  // Legacy leads without acquisition metadata use the earliest attributed
  // interaction, not the latest. Explicit metadata is the final fallback.
  const call = await CallLog.findOne(filter).sort({ createdAt: 1, _id: 1 })
    .select('marketingSource trackingNumber attribution').lean();
  return {
    marketingSource: call?.marketingSource || input?.marketingSource || null,
    trackingNumber: call?.trackingNumber || input?.trackingNumber || null,
    attribution: call?.attribution || input?.attribution || {},
  };
};
