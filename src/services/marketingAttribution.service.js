// CALLBACKIQ_MARKETING_ATTRIBUTION_V1
import Business from "../models/business.js";
import CallLog from "../models/callLog.js";
import Conversation from "../models/conversation.js";
import Lead from "../models/lead.js";
import MarketingSource from "../models/marketingSource.js";
import TrackingNumber from "../models/trackingNumber.js";
import { normalizePhoneToE164 } from "../voice/voicePhone.service.js";

export const buildAttributionSnapshot = ({
  marketingSource = null,
  trackingNumber = null,
} = {}) => ({
  sourceId: marketingSource?._id ? String(marketingSource._id) : "",
  sourceName: String(marketingSource?.name || ""),
  channel: String(marketingSource?.channel || ""),
  campaign: String(marketingSource?.campaign || ""),
  trackingNumberId: trackingNumber?._id ? String(trackingNumber._id) : "",
  trackingNumber: String(trackingNumber?.phoneNumber || ""),
});

export const resolveTrackingNumberContext = async (
  phone,
  { activeOnly = true } = {},
) => {
  const normalized = normalizePhoneToE164(phone);
  if (!normalized) return null;

  const number = await TrackingNumber.findOne({
    phoneLookup: normalized,
    ...(activeOnly ? { status: "active" } : {}),
  }).lean();

  if (!number) return null;

  const [business, marketingSource] = await Promise.all([
    Business.findById(number.business).lean(),
    number.marketingSource
      ? MarketingSource.findById(number.marketingSource).lean()
      : null,
  ]);

  if (
    !business ||
    (activeOnly &&
      (business.isActive === false ||
        (number.isPrimary && business.trackingNumber?.status !== "active")))
  ) {
    return null;
  }

  return {
    business,
    trackingNumber: number,
    marketingSource,
    attribution: buildAttributionSnapshot({
      marketingSource,
      trackingNumber: number,
    }),
  };
};

export const syncLatestAttribution = async ({
  businessId,
  leadId = null,
  conversationId = null,
  trackingNumber = null,
  marketingSource = null,
  calledPhone = "",
}) => {
  const attribution = buildAttributionSnapshot({
    marketingSource,
    trackingNumber,
  });
  const replyFromPhone =
    trackingNumber?.phoneNumber ||
    normalizePhoneToE164(calledPhone) ||
    "";

  const tasks = [];

  if (leadId) {
    tasks.push(
      (async () => {
        // CALLBACKIQ_ATTRIBUTION_10OF10_FULL_V2: first touch is write-once.
        // For pre-upgrade leads, derive it from the earliest attributed CallLog
        // instead of incorrectly treating the newest interaction as acquisition.
        if (trackingNumber?._id) {
          const firstTouchMissing = await Lead.exists({
            _id: leadId,
            business: businessId,
            $or: [
              { firstTrackingNumber: null },
              { firstTrackingNumber: { $exists: false } },
            ],
          });

          if (firstTouchMissing) {
            const earliestCall = await CallLog.findOne({
              business: businessId,
              lead: leadId,
              trackingNumber: { $ne: null },
            })
              .sort({ createdAt: 1, _id: 1 })
              .select("marketingSource trackingNumber attribution")
              .lean();

            await Lead.updateOne(
              {
                _id: leadId,
                business: businessId,
                $or: [
                  { firstTrackingNumber: null },
                  { firstTrackingNumber: { $exists: false } },
                ],
              },
              {
                $set: {
                  firstMarketingSource:
                    earliestCall?.marketingSource || marketingSource?._id || null,
                  firstTrackingNumber:
                    earliestCall?.trackingNumber || trackingNumber._id,
                  firstAttribution:
                    earliestCall?.attribution || attribution,
                },
              },
            );
          }
        }

        return Lead.updateOne(
          { _id: leadId, business: businessId },
          {
            $set: {
              latestMarketingSource: marketingSource?._id || null,
              latestTrackingNumber: trackingNumber?._id || null,
              latestAttribution: attribution,
            },
          },
        );
      })(),
    );
  }

  if (conversationId) {
    tasks.push(
      Conversation.updateOne(
        { _id: conversationId, business: businessId },
        {
          $set: {
            latestMarketingSource: marketingSource?._id || null,
            latestTrackingNumber: trackingNumber?._id || null,
            latestAttribution: attribution,
            ...(replyFromPhone ? { replyFromPhone } : {}),
          },
        },
      ),
    );
  }

  await Promise.all(tasks);
  return attribution;
};

export const getLatestCallAttribution = async ({
  businessId,
  leadId = null,
  customerPhone = "",
}) => {
  const filter = {
    business: businessId,
    marketingSource: { $ne: null },
  };

  if (leadId) {
    filter.lead = leadId;
  } else {
    const normalized = normalizePhoneToE164(customerPhone);
    if (!normalized) return null;
    filter.from = normalized;
  }

  const call = await CallLog.findOne(filter)
    .sort({ createdAt: -1 })
    .select("marketingSource trackingNumber attribution")
    .lean();

  if (!call) return null;

  return {
    marketingSource: call.marketingSource || null,
    trackingNumber: call.trackingNumber || null,
    attribution: call.attribution || {},
  };
};

export default {
  buildAttributionSnapshot,
  resolveTrackingNumberContext,
  syncLatestAttribution,
  getLatestCallAttribution,
};
