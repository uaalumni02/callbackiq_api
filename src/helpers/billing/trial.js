import Subscription from "../../models/subscription.js";
import TrialRedemption from "../../models/trialRedemption.js";

export const TRIAL_DAYS = 14;
export const TRIAL_PRICE_MONTHLY = 199;
export const TRIAL_DENIED_ALREADY_USED = "trial_already_used";
export const TRIAL_DENIED_MISSING_EMAIL = "missing_email";
export const TRIAL_DENIED_DISPOSABLE_EMAIL = "disposable_email";

const DEFAULT_BLOCKED_TRIAL_DOMAINS = new Set([
  "10minutemail.com",
  "guerrillamail.com",
  "mailinator.com",
  "tempmail.com",
  "temp-mail.org",
  "yopmail.com",
]);

const envBlockedDomains = () =>
  new Set(
    String(process.env.TRIAL_BLOCKED_EMAIL_DOMAINS || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );

export const normalizeEmail = (email = "") => {
  const raw = String(email || "").trim().toLowerCase();
  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1) return raw;

  let local = raw.slice(0, at);
  let domain = raw.slice(at + 1);

  // Gmail treats dots and +aliases as the same mailbox. Canonicalizing only
  // Gmail avoids incorrectly merging identities for providers with different
  // mailbox semantics.
  if (domain === "gmail.com" || domain === "googlemail.com") {
    domain = "gmail.com";
    local = local.split("+")[0].replace(/\./g, "");
  }

  return `${local}@${domain}`;
};

export const normalizePhone = (phone = "") => {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
};

export const buildTrialIdentity = (business, ownerId) => {
  const emailKey =
    normalizeEmail(business?.email) || normalizeEmail(business?.owner?.email);
  const phoneKey = normalizePhone(
    business?.forwardingPhone || business?.businessPhone || "",
  );
  return { ownerId, emailKey, phoneKey };
};

export const isDisposableTrialEmail = (email = "") => {
  const normalized = normalizeEmail(email);
  const domain = normalized.split("@")[1] || "";
  if (!domain) return false;
  return DEFAULT_BLOCKED_TRIAL_DOMAINS.has(domain) || envBlockedDomains().has(domain);
};

const identityQuery = ({ ownerId, emailKey, phoneKey }) => {
  const checks = [];
  if (ownerId) checks.push({ owner: ownerId });
  if (emailKey) checks.push({ emailKey });
  if (phoneKey) checks.push({ phoneKey });
  return checks.length ? { $or: checks } : { _id: null };
};

export const getTrialEligibility = async ({
  business,
  ownerId,
  subscription = null,
  session = null,
}) => {
  const identity = buildTrialIdentity(business, ownerId);

  if (!identity.emailKey) {
    return {
      eligible: false,
      reason: TRIAL_DENIED_MISSING_EMAIL,
      identity,
    };
  }

  if (isDisposableTrialEmail(identity.emailKey)) {
    return {
      eligible: false,
      reason: TRIAL_DENIED_DISPOSABLE_EMAIL,
      identity,
    };
  }

  if (subscription?.trialUsedAt) {
    return {
      eligible: false,
      reason: TRIAL_DENIED_ALREADY_USED,
      identity,
    };
  }

  let query = TrialRedemption.findOne(identityQuery(identity));
  if (session) query = query.session(session);
  const existing = await query.lean();

  return {
    eligible: !existing,
    reason: existing ? TRIAL_DENIED_ALREADY_USED : null,
    identity,
    existingRedemption: existing || null,
  };
};

export const canStartTrial = async (params) =>
  (await getTrialEligibility(params)).eligible;

export const createInactiveSubscription = async (businessId) =>
  Subscription.findOneAndUpdate(
    { business: businessId },
    {
      $setOnInsert: { business: businessId },
      $set: {
        plan: "pro",
        status: "none",
        lastPaymentStatus: "trial_not_activated",
        priceMonthly: TRIAL_PRICE_MONTHLY,
        aiEnabled: false,
        isActive: false,
        cancelAtPeriodEnd: false,
      },
    },
    {
      upsert: true,
      returnDocument: "after",
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  );

export default {
  TRIAL_DAYS,
  TRIAL_PRICE_MONTHLY,
  normalizeEmail,
  normalizePhone,
  buildTrialIdentity,
  isDisposableTrialEmail,
  getTrialEligibility,
  canStartTrial,
  createInactiveSubscription,
};
