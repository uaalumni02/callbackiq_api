import {createCheckoutService} from './billing/createCheckout.service.js';
import {matchesCheckoutReceipt,planSubscriptionProjection} from '../helpers/billing/subscriptionProjection.js';
import {applyObservedTrial,completeObservedSubscription,subscriptionObservationMatches} from './subscriptionState.service.js';
import { projectCurrentEntitlement } from './subscriptionEntitlement.service.js';
import { expireObservedTrial, observeTrialState } from './trialExpiry.service.js';
import { conditionalWrite } from './database/conditionalWrite.js';
import { extendTrial as extendTrialByAdmin } from './trialExtension.service.js';
import { sendTrialNotice, reconcileTrialNotices } from './trialLifecycleDelivery.service.js';
import { canonicalInvoiceProjection, stripePeriodDates } from '../helpers/billing/stripeSubscriptionSnapshot.js';
import { safeConsole } from "../helpers/logging/safeLogger.js";
import mongoose from "mongoose";

import Business from "../models/business.js";
import Subscription from "../models/subscription.js";
import TrialRedemption from "../models/trialRedemption.js";
import "../models/trialExtensionGrant.js";
import { getStripeClient, getPriceIdByPlan } from "../helpers/stripe/stripeClient.js";
import {
  TRIAL_DAYS,
  TRIAL_PRICE_MONTHLY,
  buildTrialIdentity,
  getTrialEligibility,
} from "../helpers/billing/trial.js";
import { getStripeSubscriptionPriceSnapshot } from "../helpers/billing/stripeSubscriptionPrice.js";
import {
  provisionTrackingNumber,
} from "./trackingNumberProvisioning.service.js";
import { getSubscriptionAccess, ACCESS_LEVELS } from "./subscriptionAccess.service.js";
import {
  assertStripeCustomerHasNoCompetingSubscriptions,
  guardCanonicalStripeSubscription,
} from "./subscriptionIntegrity.service.js";
import "../helpers/email/mailer.js";
import { prepareTrialForCheckout, reconcileTrialPreparations } from './trialPreparation.service.js';
import { assertTrialActivationCapacity } from './trialActivationCapacity.service.js';
import { releaseExpiredTrialNumber } from './trialNumberCleanup.service.js';
import { getCheckoutCustomer } from './subscriptionCheckoutCustomer.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const RELEASE_GRACE_DAYS = Math.max(
  1,
  Number(process.env.TRIAL_NUMBER_RELEASE_GRACE_DAYS) || 7,
);
const NO_PAYMENT_METHOD_RELEASE_GRACE_HOURS = Math.max(
  1,
  Number(process.env.TRIAL_NO_PAYMENT_METHOD_NUMBER_RELEASE_GRACE_HOURS) || 48,
);
const releaseGraceMsForStatus = (status) =>
  String(status || "").toLowerCase() === "paused"
    ? NO_PAYMENT_METHOD_RELEASE_GRACE_HOURS * 60 * 60 * 1000
    : RELEASE_GRACE_DAYS * DAY_MS;

const isTransactionUnsupported = (error) =>
  error?.code === 20 ||
  error?.codeName === "IllegalOperation" ||
  /transaction numbers are only allowed|does not support transactions|replica set/i.test(
    String(error?.message || ""),
  );

const lifecycleError = (code, message, statusCode = 400) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const toDateFromUnix = (timestamp) =>
  timestamp ? new Date(Number(timestamp) * 1000) : null;

const getPeriodDates = stripePeriodDates;

const latestInvoiceId = (stripeSubscription) =>
  typeof stripeSubscription?.latest_invoice === "string"
    ? stripeSubscription.latest_invoice
    : stripeSubscription?.latest_invoice?.id || "";



const getBusinessOwnerId = (business, fallbackOwnerId = null) =>
  business?.owner?._id || business?.owner || fallbackOwnerId;

const trialRedemptionQuery = ({ ownerId, emailKey, phoneKey }) => {
  const or = [];
  if (ownerId) or.push({ owner: ownerId });
  if (emailKey) or.push({ emailKey });
  if (phoneKey) or.push({ phoneKey });
  return or.length ? { $or: or } : { _id: null };
};

// Always reload the authority inside the shared transactional projection boundary.
const setBusinessAccessState = businessId => projectCurrentEntitlement(businessId);

const safeProvisionNumber = async (businessId) => {
  try {
    return await provisionTrackingNumber(businessId);
  } catch (error) {
    // Billing entitlement must not be rolled back because a carrier inventory
    // request failed. trackingNumberProvisioning records the error for setup UI.
    safeConsole.error("Trial tracking-number provisioning failed:", {
      businessId: String(businessId),
      code: error?.code,
      message: error?.message,
    });
    return null;
  }
};

const buildTrialSubscriptionUpdate = ({
  invoiceProjection = {},
  existingSubscription,
  stripeSubscription,
  checkoutSessionId,
  plan,
  trialStartedAt,
  trialEndsAt,
}) => {
  const priceSnapshot = getStripeSubscriptionPriceSnapshot(
    stripeSubscription,
    {
      fallbackPriceMonthly:
        existingSubscription?.priceMonthly ?? TRIAL_PRICE_MONTHLY,
      fallbackStripePriceId: existingSubscription?.stripePriceId || "",
    },
  );

  return {
    stripeCustomerId: stripeSubscription.customer || "",
    stripeSubscriptionId: stripeSubscription.id || "",
    stripePriceId: priceSnapshot.stripePriceId,
    checkoutSessionId,
    latestInvoiceId: latestInvoiceId(stripeSubscription),
    plan,
    status: "trialing",
    lastPaymentStatus: "trialing",
    ...getPeriodDates(stripeSubscription),
    trialStartedAt,
    trialEndsAt,
    trialUsedAt: existingSubscription?.trialUsedAt || trialStartedAt,
    trialCount: Math.max(1, Number(existingSubscription?.trialCount || 0)),
    cancelAtPeriodEnd: Boolean(stripeSubscription.cancel_at_period_end),
    priceMonthly: priceSnapshot.priceMonthly ?? TRIAL_PRICE_MONTHLY,
    isActive: true,
    aiEnabled: true,
    trialNumberReleaseAt: null,
    ...invoiceProjection,
  };
};

const isSameStripeTrialRedemption = ({
  redemption,
  existingSubscription,
  businessId,
  stripeSubscriptionId,
}) =>
  Boolean(
    redemption &&
      String(redemption.business) === String(businessId) &&
      (
        String(redemption.stripeSubscriptionId || "") ===
          String(stripeSubscriptionId || "") ||
        String(existingSubscription?.stripeSubscriptionId || "") ===
          String(stripeSubscriptionId || "")
      ),
  );

const consumeTrialTransaction = async ({
  business,
  ownerId,
  stripeSubscription,
  checkoutSessionId = "",
  plan = "pro",
  observedSubscription,
  invoiceProjection = {},
}) => {
  const identity = buildTrialIdentity(business, ownerId);
  if (!identity.emailKey) {
    throw lifecycleError(
      "TRIAL_IDENTITY_REQUIRED",
      "A business email is required to activate a free trial.",
    );
  }

  const trialStartedAt = toDateFromUnix(stripeSubscription.trial_start);
  const trialEndsAt = toDateFromUnix(stripeSubscription.trial_end);
  if (!trialStartedAt || !trialEndsAt) {
    throw lifecycleError(
      "STRIPE_TRIAL_REQUIRED",
      "Stripe did not create the expected trial period.",
      409,
    );
  }

  const dbSession = await mongoose.startSession();
  let updatedSubscription = null;

  try {
    try {
      await dbSession.withTransaction(async () => {
        const existingSubscription = await Subscription.findOne({
          business: business._id,
        }).session(dbSession);

        if (!subscriptionObservationMatches(observedSubscription,existingSubscription)) {
          throw Object.assign(lifecycleError('TRIAL_STATE_CHANGED','Subscription changed before trial redemption.',409),{current:existingSubscription});
        }
        const existingRedemption = await TrialRedemption.findOne(
          trialRedemptionQuery(identity),
        ).session(dbSession);

        if (
          existingRedemption &&
          !isSameStripeTrialRedemption({
            redemption: existingRedemption,
            existingSubscription,
            businessId: business._id,
            stripeSubscriptionId: stripeSubscription.id,
          })
        ) {
          throw lifecycleError(
            "TRIAL_ALREADY_USED",
            "This customer or business identity has already used its lifetime free trial.",
            409,
          );
        }

        if (!existingRedemption) {
          await TrialRedemption.create(
            [
              {
                business: business._id,
                owner: ownerId,
                emailKey: identity.emailKey,
                phoneKey: identity.phoneKey,
                stripeSubscriptionId: stripeSubscription.id || "",
                grantedBy: "self",
                redeemedAt: trialStartedAt,
              },
            ],
            { session: dbSession },
          );
        }

        updatedSubscription = await applyObservedTrial({businessId:business._id,observed:existingSubscription,fields:buildTrialSubscriptionUpdate({
          invoiceProjection,
              existingSubscription,
              stripeSubscription,
              checkoutSessionId,
              plan,
              trialStartedAt,
              trialEndsAt,
            }),session:dbSession});
      });

      return updatedSubscription;
    } catch (error) {
      if (!isTransactionUnsupported(error)) throw error;
      throw lifecycleError('TRIAL_TRANSACTION_REQUIRED','Trial activation requires transaction-capable MongoDB.',503);
    }
  } finally {
    await dbSession.endSession();
  }
};

const denyDuplicateStripeTrial = async ({
  businessId,
  stripeSubscriptionId,
  reason,
}) => {
  const observed=await Subscription.findOne({business:businessId});
  const stripe = getStripeClient();

  if (stripeSubscriptionId) {
    try {
      if (stripe?.subscriptions?.cancel) {
        await stripe.subscriptions.cancel(stripeSubscriptionId);
      } else if (stripe?.subscriptions?.del) {
        await stripe.subscriptions.del(stripeSubscriptionId);
      }
    } catch (error) {
      safeConsole.error("Unable to cancel duplicate Stripe trial:", error);
    }
  }

  if (!observed || (observed.stripeSubscriptionId && observed.stripeSubscriptionId !== stripeSubscriptionId)) return observed;
  const subscription = (await completeObservedSubscription({businessId:businessId,observed:observed,fields:{
        status: "canceled",
        isActive: false,
        aiEnabled: false,
        lastPaymentStatus: reason || "trial_identity_rejected",
      }})).current;
  await setBusinessAccessState(businessId, subscription || "canceled");
  return subscription;
};


/** Creates one serialized, readiness-checked PRO checkout; provider uncertainty requires reconciliation. */
export const createSubscriptionCheckout = createCheckoutService({Subscription,getSubscriptionAccess,ACCESS_LEVELS,lifecycleError,getTrialEligibility,getPriceIdByPlan,getStripeClient,assertTrialActivationCapacity,prepareTrialForCheckout,getCheckoutCustomer,assertStripeCustomerHasNoCompetingSubscriptions,completeObservedSubscription,matchesCheckoutReceipt,TRIAL_DAYS,TRIAL_PRICE_MONTHLY});

export const syncStripeSubscription = async ({
  stripeSubscription,
  checkoutSessionId = "",
  fallbackBusinessId = "",
  fallbackOwnerId = "",
  fallbackPlan = "pro",
  refreshFromStripe = true,
  observedSubscription,
  invoiceEvent,
}) => {
  const observedBusinessId=stripeSubscription?.metadata?.businessId || fallbackBusinessId;
  const observed=observedSubscription===undefined && observedBusinessId
    ? await Subscription.findOne({business:observedBusinessId}) : observedSubscription;
  const stripe = getStripeClient();

  if (
    refreshFromStripe &&
    stripeSubscription?.id &&
    stripe?.subscriptions?.retrieve
  ) {
    stripeSubscription = await stripe.subscriptions.retrieve(
      stripeSubscription.id,
      { expand: ["latest_invoice"] },
    );
  }

  const invoiceProjection=invoiceEvent ? canonicalInvoiceProjection(stripeSubscription,invoiceEvent.invoice,invoiceEvent.status) : {};
  const businessId =
    stripeSubscription?.metadata?.businessId || fallbackBusinessId;
  if (!businessId) return null;

  const business = await Business.findById(businessId).populate(
    "owner",
    "email role",
  );
  if (!business) return null;


  /* Never let a webhook from sub_B silently replace live canonical sub_A. */
  const canonicalGuard = await guardCanonicalStripeSubscription({
    stripe,
    businessId,
    incomingStripeSubscription: stripeSubscription,
    source: "sync_stripe_subscription",
  });
  if (!canonicalGuard.allowed) {
    return canonicalGuard.current || null;
  }
  if (!subscriptionObservationMatches(observed,canonicalGuard.current)) return canonicalGuard.current;
  const ownerId =
    stripeSubscription?.metadata?.ownerId ||
    fallbackOwnerId ||
    getBusinessOwnerId(business);
  const plan = stripeSubscription?.metadata?.plan || fallbackPlan || "pro";
  const status = String(stripeSubscription?.status || "none").toLowerCase();

  if (status === "trialing") {
    try {
      const currentSubscription = await Subscription.findOne({
        business: businessId,
      }).lean();
      const isExistingStripeTrial =
        currentSubscription?.status === "trialing" &&
        String(currentSubscription?.stripeSubscriptionId || "") ===
          String(stripeSubscription?.id || "") &&
        Boolean(currentSubscription?.trialUsedAt);

      if (!isExistingStripeTrial) {
        await assertTrialActivationCapacity(new Date(), businessId);
      }

      const subscription = await consumeTrialTransaction({
        business,
        ownerId,
        stripeSubscription,
        checkoutSessionId,
        plan,
        observedSubscription:observed,
        invoiceProjection,
      });

      await setBusinessAccessState(businessId, subscription);
      await safeProvisionNumber(businessId);
      await sendTrialLifecycleMessage(subscription, "welcome").catch((error) => {
        safeConsole.error("Trial welcome email failed:", error);
      });
      return subscription;
    } catch (error) {
      if (error?.code === 'TRIAL_STATE_CHANGED') return error.current || await Subscription.findOne({business:businessId});
      const capacityRejected = [
        "TRIAL_DAILY_CAPACITY_REACHED",
        "TRIAL_CONCURRENT_CAPACITY_REACHED",
        "TRIAL_NUMBER_INVENTORY_CAPACITY_REACHED",
      ].includes(error?.code);
      if (
        error?.code === "TRIAL_ALREADY_USED" ||
        error?.code === 11000 ||
        capacityRejected
      ) {
        // The event is valid Stripe traffic, so acknowledge it after canceling
        // the rejected trial instead of returning 4xx and causing retries.
        return denyDuplicateStripeTrial({
          businessId,
          stripeSubscriptionId: stripeSubscription?.id,
          reason: capacityRejected
            ? "trial_capacity_rejected"
            : "trial_identity_rejected",
        });
      }
      throw error;
    }
  }

  const {fields:update,active:isActive,terminal:terminalTrialStatus}=planSubscriptionProjection({
    remote:stripeSubscription,current:canonicalGuard.current,checkoutSessionId,plan,now:new Date(),
    releaseGraceMs:releaseGraceMsForStatus(status),invoiceProjection,
  });
  const completion=await completeObservedSubscription({businessId,observed,fields:update});
  const subscription=completion.current;
  if (!completion.applied) return subscription;

  await setBusinessAccessState(businessId, subscription);

  if (isActive) {
    await safeProvisionNumber(businessId);
  } else if (terminalTrialStatus && subscription?.trialUsedAt) {
    await sendTrialLifecycleMessage(subscription, "expired").catch((error) => {
      safeConsole.error("Trial expired email failed:", error);
    });
  }

  return subscription;
};

export const syncCheckoutSession = async (checkoutSession) => {
  const stripe = getStripeClient();
  const subscriptionId = checkoutSession?.subscription;
  if (!subscriptionId || !stripe?.subscriptions?.retrieve) return null;

  // Legacy checkout sessions may omit tenant metadata. Capture the canonical
  // SID's local state before the provider await rather than observing its result.
  const observedSubscription=await Subscription.findOne(checkoutSession.metadata?.businessId
    ? {business:checkoutSession.metadata.businessId} : {stripeSubscriptionId:subscriptionId});
  const stripeSubscription = await stripe.subscriptions.retrieve(
    subscriptionId,
    { expand: ["latest_invoice"] },
  );

  return syncStripeSubscription({
    stripeSubscription,
    checkoutSessionId: checkoutSession.id || "",
    fallbackBusinessId: checkoutSession.metadata?.businessId || "",
    fallbackOwnerId: checkoutSession.metadata?.ownerId || "",
    fallbackPlan: checkoutSession.metadata?.plan || "pro",
    observedSubscription,
    refreshFromStripe: false,
  });
};

export const sendTrialLifecycleMessage = sendTrialNotice;

export const processTrialLifecycle = async (now = new Date()) => {
  await reconcileTrialNotices();
  await reconcileTrialPreparations();
  const subscriptions = Subscription.find({ $or: [
    { status: 'trialing', trialEndsAt: { $lte: new Date(now.getTime() + 3 * DAY_MS) } },
    { trialNumberReleaseAt: { $lte: now, $ne: null } },
    { status: 'active', $or: [{ provisioningCheckAt: { $lte: now } }, { provisioningCheckAt: null }] },
  ] }).sort({ _id: 1 }).maxTimeMS(5000).cursor({ batchSize: 100 });

  let processed = 0;
  for await (const subscription of subscriptions) {
    processed += 1;

    if (getSubscriptionAccess(subscription, now).level === ACCESS_LEVELS.FULL) {
      const business = await Business.findById(subscription.business)
        .select("phone trackingNumber.status")
        .lean();
      if (!business?.phone || business?.trackingNumber?.status !== "active") {
        await safeProvisionNumber(subscription.business);
      }
      await conditionalWrite({model:Subscription,identity:{_id:subscription._id,business:subscription.business},
        observed:observeTrialState(subscription),update:{$set:{provisioningCheckAt:new Date(now.getTime()+DAY_MS)}}});
    }

    const trialEnd = subscription.trialEndsAt
      ? new Date(subscription.trialEndsAt)
      : null;

    if (subscription.status === "trialing" && trialEnd) {
      const remainingMs = trialEnd.getTime() - now.getTime();

      if (remainingMs > 0 && remainingMs <= DAY_MS) {
        await sendTrialLifecycleMessage(subscription, "one_day").catch(
          (error) => safeConsole.error("Trial 1-day reminder failed:", error),
        );
      } else if (remainingMs > DAY_MS && remainingMs <= 3 * DAY_MS) {
        await sendTrialLifecycleMessage(subscription, "three_day").catch(
          (error) => safeConsole.error("Trial 3-day reminder failed:", error),
        );
      }

      if (remainingMs <= 0) {
        try {
          const stripe = getStripeClient();
          const remote = subscription.stripeSubscriptionId
            ? await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId, {
                expand: ["latest_invoice"],
              })
            : null;

          if (remote) {
            await syncStripeSubscription({ stripeSubscription: remote, observedSubscription: subscription });
          } else {
            throw new Error("Stripe subscription unavailable");
          }
        } catch (error) {
          // Fail safe: access never remains active merely because Stripe or the
          // worker is temporarily unavailable.
          const releaseAt =
            subscription.trialNumberReleaseAt ||
            new Date(now.getTime() + releaseGraceMsForStatus("paused"));
          const expiry = await expireObservedTrial(subscription, {
            now, releaseAt, lastPaymentStatus: 'trial_expired_reconcile_pending',
          });
          // A stale expiry must not send an expiry notice or project expired access.
          if (expiry.applied) {
            await setBusinessAccessState(subscription.business, expiry.current);
            await sendTrialLifecycleMessage(expiry.current, 'expired').catch(
              error => safeConsole.error('Trial lifecycle notice failed:', error),
            );
          }
        }
      }
    }

    await releaseExpiredTrialNumber(subscription._id, now, { syncStripeSubscription, syncCheckoutSession });
  }

  return { processed };
};

export { extendTrial as extendTrialByAdmin } from './trialExtension.service.js';

export default {
  createSubscriptionCheckout,
  syncCheckoutSession,
  syncStripeSubscription,
  processTrialLifecycle,
  sendTrialLifecycleMessage,
  extendTrialByAdmin,
};
