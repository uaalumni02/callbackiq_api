import Db from "../db/db.js";
import Business from "../models/business.js";
import { resolveTrackingNumberContext } from "./marketingAttribution.service.js"; // CALLBACKIQ_MARKETING_ATTRIBUTION_V1
import {
  normalizePhoneToE164,
  phoneLookupVariants,
} from "../voice/voicePhone.service.js";

import { createFreshFindOneBatch } from './database/freshFindOneBatch.js';
const freshLegacyBusiness = createFreshFindOneBatch(Business, {
  select: '_id owner businessName businessType phone phoneLookup trackingNumber forwardingPhone email website address city state zipCode timezone smsTemplate estimatedJobValue features communicationLimits voiceSettings setupProgress isActive createdAt updatedAt', defaults: true,
});

const hasBusinessIdentity = (business) =>
  Boolean(business?._id || business?.id);

const isActiveBusiness = (business) =>
  hasBusinessIdentity(business) &&
  business.isActive !== false &&
  business.trackingNumber?.status === "active";

const materializeBusiness = async (value) => {
  let resolved = await value;
  if (!hasBusinessIdentity(resolved) && typeof resolved?.lean === "function") {
    resolved = await resolved.lean();
  }
  return resolved;
};

const resolveLegacyBusinessByTwilioNumber = async (
  phone,
  { activeOnly = true, batch = false } = {},
) => {
  const rawPhone = String(phone || "").trim();
  if (!rawPhone) return null;

  const direct = batch && Business.schema ? await freshLegacyBusiness({
    isActive: true, 'trackingNumber.status': 'active', $or: [{ phone: rawPhone }, { phoneLookup: rawPhone }],
  }) : await materializeBusiness(
    typeof Db.getBusinessByPhoneForWebhook === "function"
      ? Db.getBusinessByPhoneForWebhook(Business, rawPhone)
      : typeof Db.getBusinessByPhone === "function"
        ? Db.getBusinessByPhone(Business, rawPhone)
        : null,
  );

  if (hasBusinessIdentity(direct) && (!activeOnly || isActiveBusiness(direct))) {
    return direct;
  }

  const normalized = normalizePhoneToE164(rawPhone);
  if (!normalized) return null;

  const query = {
    ...(activeOnly
      ? { isActive: true, "trackingNumber.status": "active" }
      : {}),
    $or: [
      { phoneLookup: normalized },
      { phone: { $in: phoneLookupVariants(normalized) } },
    ],
  };

  const fallbackQuery = Business.findOne(query);
  const selected =
    typeof fallbackQuery?.select === "function"
      ? fallbackQuery.select(
          "_id businessName businessType phone phoneLookup trackingNumber forwardingPhone smsTemplate estimatedJobValue timezone isActive features voiceSettings owner",
        )
      : fallbackQuery;
  const fallback =
    typeof selected?.lean === "function" ? await selected.lean() : await selected;
  return hasBusinessIdentity(fallback) ? fallback : null;
};

export const resolveTwilioNumberContext = async (
  phone,
  options = {},
) => {
  const tracked = await resolveTrackingNumberContext(phone, options);
  if (tracked?.business) return tracked;

  const business = await resolveLegacyBusinessByTwilioNumber(phone, options);
  return business
    ? {
        business,
        trackingNumber: null,
        marketingSource: null,
        attribution: {
          sourceId: "",
          sourceName: "",
          channel: "",
          campaign: "",
          trackingNumberId: "",
          trackingNumber: String(business.phone || ""),
        },
      }
    : null;
};

export const resolveBusinessByTwilioNumber = async (phone, options = {}) =>
  (await resolveTwilioNumberContext(phone, options))?.business || null;

export const resolveBusinessFromWebhookPhones = async (
  phones = [],
  options = {},
) => {
  const unique = [
    ...new Set(
      phones
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  ];

  for (const phone of unique) {
    const business = await resolveBusinessByTwilioNumber(phone, options);
    if (business) return business;
  }
  return null;
};

export default {
  resolveTwilioNumberContext,
  resolveBusinessByTwilioNumber,
  resolveBusinessFromWebhookPhones,
};
