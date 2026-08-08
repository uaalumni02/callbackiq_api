import Db from "../db/db.js";
import Business from "../models/business.js";
import {
  normalizePhoneToE164,
  phoneLookupVariants,
} from "../voice/voicePhone.service.js";

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

export const resolveBusinessByTwilioNumber = async (
  phone,
  { activeOnly = true } = {},
) => {
  const rawPhone = String(phone || "").trim();
  if (!rawPhone) return null;

  const direct = await materializeBusiness(
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
          "_id businessName businessType phone phoneLookup smsTemplate estimatedJobValue timezone isActive features owner",
        )
      : fallbackQuery;
  const fallback =
    typeof selected?.lean === "function" ? await selected.lean() : await selected;
  return hasBusinessIdentity(fallback) ? fallback : null;
};

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
  resolveBusinessByTwilioNumber,
  resolveBusinessFromWebhookPhones,
};
