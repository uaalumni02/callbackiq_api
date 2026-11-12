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
  releaseTrackingNumberWithReceipt,
} from "./trackingNumberProvisioning.service.js";
import { getSubscriptionAccess, ACCESS_LEVELS } from "./subscriptionAccess.service.js";
import {
  assertStripeCustomerHasNoCompetingSubscriptions,
  findExistingStripeCustomerForBusiness,
  guardCanonicalStripeSubscription,
} from "./subscriptionIntegrity.service.js";
import "../helpers/email/mailer.js";

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

const configuredLimit = (name, fallback) => {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
};

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


const assertTrialActivationCapacity = async (now = new Date()) => {
  const maxNewPerDay = configuredLimit(
    "TRIAL_MAX_NEW_TRIALS_PER_DAY",
    10,
  );
  const maxConcurrent = configuredLimit(
    "TRIAL_MAX_CONCURRENT_ACTIVE",
    25,
  );
  const maxTrialNumbersHeld = configuredLimit(
    "TRIAL_MAX_TRACKING_NUMBERS_HELD",
    40,
  );

  const dayStart = new Date(now.getTime() - DAY_MS);
  const [newTrialActivations, concurrentTrials, graceHeldTrialNumbers] =
    await Promise.all([
      maxNewPerDay > 0
        ? Subscription.countDocuments({
            trialStartedAt: { $gte: dayStart },
            trialUsedAt: { $ne: null },
          })
        : Promise.resolve(0),
      maxConcurrent > 0 || maxTrialNumbersHeld > 0
        ? Subscription.countDocuments({
            status: "trialing",
            trialEndsAt: { $gt: now },
          })
        : Promise.resolve(0),
      maxTrialNumbersHeld > 0
        ? Subscription.countDocuments({
            trialUsedAt: { $ne: null },
            trialNumberReleaseAt: { $gt: now },
            status: { $ne: "active" },
          })
        : Promise.resolve(0),
    ]);

  if (maxNewPerDay > 0 && newTrialActivations >= maxNewPerDay) {
    throw lifecycleError(
      "TRIAL_DAILY_CAPACITY_REACHED",
      "Free-trial activation is temporarily at capacity. Please try again later or choose a paid plan.",
      503,
    );
  }

  if (maxConcurrent > 0 && concurrentTrials >= maxConcurrent) {
    throw lifecycleError(
      "TRIAL_CONCURRENT_CAPACITY_REACHED",
      "Free-trial capacity is temporarily full. Please try again later or choose a paid plan.",
      503,
    );
  }

  if (
    maxTrialNumbersHeld > 0 &&
    concurrentTrials + graceHeldTrialNumbers >= maxTrialNumbersHeld
  ) {
    throw lifecycleError(
      "TRIAL_NUMBER_INVENTORY_CAPACITY_REACHED",
      "Free-trial tracking-number inventory is temporarily at capacity. Please try again later or choose a paid plan.",
      503,
    );
  }
};

export const createSubscriptionCheckout = async ({
  business,
  ownerId,
  plan = "pro",
  requireTrial = false,
  returnToSetup = false,
}) => {
  const priceId = getPriceIdByPlan(plan);
  if (!priceId) {
    throw lifecycleError(
      "STRIPE_PRICE_NOT_CONFIGURED",
      "Stripe price ID is not configured for this plan.",
    );
  }

  const existing = await Subscription.findOne({ business: business._id });
  const access = getSubscriptionAccess(existing);

  if (access.level === ACCESS_LEVELS.FULL) {
    if (existing?.status === "trialing") {
      throw lifecycleError(
        "TRIAL_ALREADY_ACTIVE",
        "Your free trial is already active. Use Billing to add a payment method.",
        409,
      );
    }
    throw lifecycleError(
      "SUBSCRIPTION_ALREADY_ACTIVE",
      "This business already has active subscription access.",
      409,
    );
  }

  const eligibility = await getTrialEligibility({
    business,
    ownerId,
    subscription: existing,
  });

  if (requireTrial && !eligibility.eligible) {
    throw lifecycleError(
      eligibility.reason === "disposable_email"
        ? "TRIAL_EMAIL_NOT_ELIGIBLE"
        : "TRIAL_ALREADY_USED",
      eligibility.reason === "disposable_email"
        ? "This email domain is not eligible for the free trial. You can still choose a paid plan."
        : "This customer or business identity has already used its lifetime free trial. Choose a paid plan to continue.",
      409,
    );
  }

  const offerTrial = requireTrial === true;
  if (offerTrial) {
    await assertTrialActivationCapacity();
  }

  const stripe = getStripeClient();
  if (!stripe?.checkout?.sessions?.create || !stripe?.customers?.create) {
    throw lifecycleError(
      "STRIPE_NOT_CONFIGURED",
      "Stripe checkout is not configured.",
      503,
    );
  }

  let stripeCustomerId = existing?.stripeCustomerId;
  if (!stripeCustomerId) {
    const existingStripeCustomer = await findExistingStripeCustomerForBusiness({
      stripe,
      businessId: business._id,
    });
    stripeCustomerId = existingStripeCustomer?.id || "";
  }
  if (!stripeCustomerId) {
    const customer = await stripe.customers.create(
      {
        name: business.businessName,
        email: business.email || undefined,
        metadata: {
          ownerId: String(ownerId),
          businessId: String(business._id),
        },
      },
      {
        idempotencyKey: `callbackiq:customer:${business._id}`,
      },
    );
    stripeCustomerId = customer.id;
  }
  await assertStripeCustomerHasNoCompetingSubscriptions({
    stripe,
    business,
    existingSubscription: existing,
    stripeCustomerId,
  });


  const metadata = {
    ownerId: String(ownerId),
    businessId: String(business._id),
    plan,
    trialRequested: offerTrial ? "true" : "false",
  };

  const subscriptionData = { metadata };

  if (offerTrial) {
    subscriptionData.trial_period_days = TRIAL_DAYS;
    subscriptionData.trial_settings = {
      end_behavior: {
        missing_payment_method: "pause",
      },
    };
  }

  const clientUrl = process.env.CLIENT_URL || "http://localhost:3001";
  const checkoutParams = {
    mode: "subscription",
    customer: stripeCustomerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: returnToSetup
      ? `${clientUrl}/trial/activate/success?session_id={CHECKOUT_SESSION_ID}`
      : `${clientUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: returnToSetup
      ? `${clientUrl}/setup?step=activate&trial=cancelled`
      : `${clientUrl}/billing`,
    metadata,
    subscription_data: subscriptionData,
    payment_method_collection: offerTrial ? "if_required" : "always",
  };

  const checkout = await stripe.checkout.sessions.create(
    checkoutParams,
    {
      idempotencyKey: `callbackiq:checkout:${business._id}:${plan}:${offerTrial ? "trial" : "paid"}:${returnToSetup ? "setup" : "billing"}`,
    },
  );

  const completion = await completeObservedSubscription({businessId:business._id,observed:existing,fields:{
        stripeCustomerId,
        stripePriceId: priceId,
        checkoutSessionId: checkout.id,
        plan,
        status: "incomplete",
        lastPaymentStatus: offerTrial
          ? "trial_checkout_started"
          : "checkout_started",
        isActive: false,
        aiEnabled: false,
        priceMonthly: TRIAL_PRICE_MONTHLY,
      }});
  if (!completion.applied && !matchesCheckoutReceipt(completion.current,{sessionId:checkout.id,
    customerId:stripeCustomerId,priceId,plan,trialOffered:offerTrial})) throw Object.assign(lifecycleError('CHECKOUT_STATE_CHANGED',
    'Subscription changed while checkout was being created. Reload Billing before continuing.',409),{current:completion.current});
  const subscription=completion.current;

  return {
    checkoutUrl: checkout.url,
    checkoutSessionId: checkout.id,
    subscription,
    trialOffered: offerTrial,
  };
};

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
        await assertTrialActivationCapacity();
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

  const observedSubscription=checkoutSession.metadata?.businessId
    ? await Subscription.findOne({business:checkoutSession.metadata.businessId}) : undefined;
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
  const subscriptions = Subscription.find({ $or: [
    { status: 'trialing', trialEndsAt: { $lte: new Date(now.getTime() + 3 * DAY_MS) } },
    { trialUsedAt: { $ne: null }, trialNumberReleaseAt: { $lte: now, $ne: null } },
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

    let refreshed = await Subscription.findById(subscription._id);
    if (
      refreshed?.trialNumberReleaseAt &&
      new Date(refreshed.trialNumberReleaseAt) <= now &&
      getSubscriptionAccess(refreshed, now).level !== ACCESS_LEVELS.FULL
    ) {
      // Never release a customer's telecom number based only on stale local
      // billing state. Reconcile Stripe immediately before the destructive
      // provider action. If Stripe cannot be reached, postpone release rather
      // than risk deleting a number for a customer who converted to paid.
      if (refreshed.stripeSubscriptionId) {
        try {
          const stripe = getStripeClient();
          const remote = await stripe.subscriptions.retrieve(
            refreshed.stripeSubscriptionId,
            { expand: ["latest_invoice"] },
          );
          await syncStripeSubscription({
            stripeSubscription: remote,
            refreshFromStripe: false,
            observedSubscription: refreshed,
          });
          refreshed = await Subscription.findById(refreshed._id);
        } catch (error) {
          safeConsole.error("Trial number release reconciliation failed:", error);
          await conditionalWrite({ model: Subscription,
            identity: { _id: refreshed._id, business: refreshed.business }, observed: observeTrialState(refreshed),
            update: { $set: { trialNumberReleaseAt: new Date(now.getTime() + DAY_MS) } } });
          continue;
        }
      }

      if (getSubscriptionAccess(refreshed, now).level === ACCESS_LEVELS.FULL) {
        continue;
      }

      const released = await releaseTrackingNumberWithReceipt(refreshed.business, {
        authorization: { kind: 'trial_expiry', subscription: { subscriptionId: refreshed._id, ...observeTrialState(refreshed) } },
      }).catch(
        (error) => {
          safeConsole.error("Trial number release failed:", error);
          return null;
        },
      );

      if (released && ['released', 'already_released'].includes(released.outcome)) {
        const completion = await conditionalWrite({ model: Subscription,
          identity: { _id: refreshed._id, business: refreshed.business }, observed: observeTrialState(refreshed),
          update: { $set: { trialNumberReleaseAt: null } } });
        if (completion.applied && released.intentId) {
          await sendTrialLifecycleMessage(completion.current, 'number_released')
            .catch(error => safeConsole.error('Trial lifecycle notice failed:', error));
        }
      }
    }
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
