import { normalizePhoneToE164, phoneLookupVariants } from "../voice/voicePhone.service.js";

export const FORWARDING_PHONE_INDEX = "active_forwarding_phone_unique";
export const FORWARDING_PHONE_INDEX_OPTIONS = {
  name: FORWARDING_PHONE_INDEX,
  unique: true,
  partialFilterExpression: { isActive: true, forwardingPhone: { $gt: "" } },
};
export const FORWARDING_PHONE_CONFLICT = {
  success: false,
  code: "FORWARDING_PHONE_IN_USE",
  field: "forwardingPhone",
  message: "This forwarding number is already linked to a business account. Sign in to that account or contact support if you believe this is incorrect.",
};

export function forwardingPhoneConflictQuery(phone, businessId = null) {
  return {
    ...(businessId ? { _id: { $ne: businessId } } : {}),
    // Missing isActive is treated as active until the migration fills defaults.
    isActive: { $ne: false },
    forwardingPhone: { $in: phoneLookupVariants(phone) },
  };
}

export function isForwardingPhoneDuplicate(error) {
  if (Number(error?.code) !== 11000) return false;
  return Object.hasOwn(error.keyPattern || {}, "forwardingPhone") ||
    Object.hasOwn(error.keyValue || {}, "forwardingPhone") ||
    String(error.message || "").includes(FORWARDING_PHONE_INDEX);
}

export function normalizeForwardingPhone(value) {
  const raw = String(value || "").trim();
  return normalizePhoneToE164(raw) || raw;
}
