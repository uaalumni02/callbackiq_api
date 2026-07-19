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

/*
 * The identity a trial is charged against.
 *
 * A flag on Subscription cannot stop trial farming, because a new signup
 * produces a brand new Subscription document. These keys are what the
 * unique indexes on TrialRedemption enforce across accounts.
 */
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

/*
 * Eligibility is a lifetime question, not a status question. An expired or
 * canceled subscription is not eligible again; only a never-used trial or an
 * explicit admin override is.
 */
export const canStartTrial = (subscription) => {
  if (!subscription) return true;
  if (subscription.trialOverrideGrantedAt) return true;

  return !subscription.trialUsedAt;
};

/*
 * The single place a free trial is granted.
 *
 * Both registration and the billing endpoint route through here so the
 * redemption record and the trialUsedAt stamp can never be written by one
 * path and skipped by the other.
 *
 * Returns { granted: true, subscription } or { granted: false, reason }.
 * Callers decide how to surface a denial — registration degrades to a
 * no-trial account, billing returns a 400.
 */
export const grantFreeTrial = async ({
  business,
  ownerId,
  subscription = null,
  grantedBy = "self",
}) => {
  const overrideGranted = Boolean(subscription?.trialOverrideGrantedAt);

  if (!canStartTrial(subscription)) {
    return { granted: false, reason: TRIAL_DENIED_ALREADY_USED };
  }

  const identity = buildTrialIdentity(business, ownerId);

  if (!identity.emailKey) {
    return { granted: false, reason: TRIAL_DENIED_MISSING_EMAIL };
  }

  if (!overrideGranted) {
    const existingRedemption = await Db.findTrialRedemption(
      TrialRedemption,
      identity,
    );

    if (existingRedemption) {
      return { granted: false, reason: TRIAL_DENIED_ALREADY_USED };
    }

    /*
     * Written before the subscription so the unique index is the arbiter
     * under concurrent requests, not the read above.
     */
    try {
      await Db.createTrialRedemption(TrialRedemption, {
        business: business._id,
        owner: ownerId,
        emailKey: identity.emailKey,
        phoneKey: identity.phoneKey,
        grantedBy,
        redeemedAt: new Date(),
      });
    } catch (error) {
      if (error?.isDuplicateTrial) {
        return { granted: false, reason: TRIAL_DENIED_ALREADY_USED };
      }

      throw error;
    }
  }

  const now = new Date();
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

  return { granted: true, subscription: updatedSubscription };
};

/*
 * Placeholder subscription for an account that could not be given a trial.
 * The account still exists and can subscribe — it just starts locked.
 */
export const createInactiveSubscription = async (businessId) => {
  return await Db.upsertSubscriptionByBusiness(Subscription, businessId, {
    plan: "pro",
    status: "none",
    lastPaymentStatus: "trial_unavailable",
    priceMonthly: TRIAL_PRICE_MONTHLY,
    aiEnabled: false,
    isActive: false,
    cancelAtPeriodEnd: false,
  });
};
