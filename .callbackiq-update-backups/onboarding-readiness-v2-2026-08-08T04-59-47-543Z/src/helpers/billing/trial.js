import Db from "../../db/db.js";
import Subscription from "../../models/subscription.js";
import TrialRedemption from "../../models/trialRedemption.js";

export const TRIAL_DAYS = 14;
export const TRIAL_PRICE_MONTHLY = 199;

export const TRIAL_DENIED_ALREADY_USED = "trial_already_used";
export const TRIAL_DENIED_MISSING_EMAIL = "missing_email";

const addDays = (date, days) => {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
};

export const normalizeEmail = (email = "") => {
  return String(email || "")
    .trim()
    .toLowerCase();
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

  const phoneKey = normalizePhone(business?.phone || business?.businessPhone);

  return {
    ownerId,
    emailKey,
    phoneKey,
  };
};

export const canStartTrial = (subscription) => {
  if (!subscription) return true;
  if (subscription.trialOverrideGrantedAt) return true;

  return !subscription.trialUsedAt;
};

export const grantFreeTrial = async ({
  business,
  ownerId,
  subscription = null,
  grantedBy = "self",
}) => {
  const overrideGranted = Boolean(subscription?.trialOverrideGrantedAt);

  if (!canStartTrial(subscription)) {
    return {
      granted: false,
      reason: TRIAL_DENIED_ALREADY_USED,
    };
  }

  const identity = buildTrialIdentity(business, ownerId);

  if (!identity.emailKey) {
    return {
      granted: false,
      reason: TRIAL_DENIED_MISSING_EMAIL,
    };
  }

  /*
   * Normal first-use requests perform a friendly read so callers receive a
   * clean denial without relying on an exception. The unique indexes remain
   * the source of truth for concurrent requests.
   */
  if (!overrideGranted) {
    const existingRedemption = await Db.findTrialRedemption(
      TrialRedemption,
      identity,
    );

    if (existingRedemption) {
      return {
        granted: false,
        reason: TRIAL_DENIED_ALREADY_USED,
      };
    }
  }

  const now = new Date();

  /*
   * Always write a fresh redemption record, including after an admin override.
   * This restores the lifetime identity lock after the additional trial is
   * consumed. The admin override flow clears the previous business redemption
   * before this method is called.
   */
  try {
    await Db.createTrialRedemption(TrialRedemption, {
      business: business._id,
      owner: ownerId,
      emailKey: identity.emailKey,
      phoneKey: identity.phoneKey,
      grantedBy: overrideGranted ? "admin" : grantedBy,
      redeemedAt: now,
    });
  } catch (error) {
    if (error?.isDuplicateTrial) {
      return {
        granted: false,
        reason: TRIAL_DENIED_ALREADY_USED,
      };
    }

    throw error;
  }

  const trialEndsAt = addDays(now, TRIAL_DAYS);

  const updatedSubscription = await Db.upsertSubscriptionByBusiness(
    Subscription,
    business._id,
    {
      plan: "pro",
      status: "trialing",
      lastPaymentStatus: "trialing",
      trialStartedAt: now,
      trialEndsAt,
      trialUsedAt: subscription?.trialUsedAt || now,
      trialCount: (subscription?.trialCount || 0) + 1,
      trialOverrideGrantedAt: null,
      currentPeriodStart: now,
      currentPeriodEnd: trialEndsAt,
      cancelAtPeriodEnd: false,
      priceMonthly: TRIAL_PRICE_MONTHLY,
      aiEnabled: true,
      isActive: true,
    },
  );

  return {
    granted: true,
    subscription: updatedSubscription,
  };
};

export const createInactiveSubscription = async (businessId) => {
  return Db.upsertSubscriptionByBusiness(Subscription, businessId, {
    plan: "pro",
    status: "none",
    lastPaymentStatus: "trial_unavailable",
    priceMonthly: TRIAL_PRICE_MONTHLY,
    aiEnabled: false,
    isActive: false,
    cancelAtPeriodEnd: false,
  });
};
