import {completeObservedSubscription} from './subscriptionState.service.js';
import Subscription from "../models/subscription.js";
import { getStripeClient } from "../helpers/stripe/stripeClient.js";
import {
  assertCanonicalIsOnlyLiveSubscription,
  recordBillingAnomaly,
} from "./subscriptionIntegrity.service.js";
import { createSubscriptionCheckout, syncStripeSubscription } from "./trialLifecycle.service.js";

const actionError = (code, message, statusCode = 400) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const clientUrl = () => process.env.CLIENT_URL || "http://localhost:3001";

const requireStripeActionApis = (stripe) => {
  if (!stripe?.subscriptions?.retrieve || !stripe?.subscriptions?.update) {
    throw actionError(
      "STRIPE_NOT_CONFIGURED",
      "Stripe subscription management is not configured.",
      503,
    );
  }
};

export const createTrialPaymentMethodCheckout = async ({ business, ownerId }) => {
  const subscription = await Subscription.findOne({ business: business._id });
  if (
    !subscription ||
    !subscription.stripeCustomerId ||
    !subscription.stripeSubscriptionId
  ) {
    throw actionError(
      "TRIAL_SUBSCRIPTION_REQUIRED",
      "A Stripe trial subscription is required before adding a payment method.",
      409,
    );
  }
  const stripe = getStripeClient();
  if (!stripe?.checkout?.sessions?.create) {
    throw actionError(
      "STRIPE_NOT_CONFIGURED",
      "Stripe Checkout is not configured.",
      503,
    );
  }
  let canonicalRemote;
  try {
    canonicalRemote = await assertCanonicalIsOnlyLiveSubscription({
      stripe,
      subscription,
      source: "trial_payment_method",
    });
  } catch (error) {
    if (error?.code === "CANONICAL_STRIPE_SUBSCRIPTION_NOT_LIVE") {
      return createSubscriptionCheckout({
        business,
        ownerId,
        plan: subscription.plan || "pro",
        requireTrial: false,
      });
    }
    throw error;
  }
  const canonicalStatus = String(canonicalRemote.status || "").toLowerCase();
  if (!["trialing", "paused"].includes(canonicalStatus)) {
    throw actionError(
      "TRIAL_SUBSCRIPTION_REQUIRED",
      "The canonical Stripe trial is no longer eligible for payment-method setup.",
      409,
    );
  }
  const reactivatePausedTrial = canonicalStatus === "paused";
  const metadata = {
    purpose: "trial_payment_method",
    businessId: String(business._id),
    ownerId: String(ownerId),
    stripeSubscriptionId: String(subscription.stripeSubscriptionId),
    reactivatePausedTrial: reactivatePausedTrial ? "true" : "false",
  };
  const checkout = await stripe.checkout.sessions.create(
    {
      mode: "setup",
      customer: subscription.stripeCustomerId,
      success_url: reactivatePausedTrial
        ? `${clientUrl()}/billing?payment_method=added&reactivation=started&session_id={CHECKOUT_SESSION_ID}`
        : `${clientUrl()}/billing?payment_method=added&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl()}/billing?payment_method=cancelled`,
      metadata,
      setup_intent_data: { metadata },
    },
    {
      idempotencyKey: reactivatePausedTrial
        ? `callbackiq:trial-reactivation-payment-method:${business._id}:${subscription.stripeSubscriptionId}`
        : `callbackiq:trial-payment-method:${business._id}:${subscription.stripeSubscriptionId}`,
    },
  );
  return {
    checkoutUrl: checkout.url,
    checkoutSessionId: checkout.id,
    subscription,
    reactivatingPausedTrial: reactivatePausedTrial,
  };
};
const getSetupIntent = async (stripe, checkoutSession) => {
  const setupIntentRef = checkoutSession?.setup_intent;
  if (!setupIntentRef) return null;
  if (typeof setupIntentRef !== "string") return setupIntentRef;
  if (!stripe?.setupIntents?.retrieve) {
    throw actionError(
      "STRIPE_SETUP_INTENT_UNAVAILABLE",
      "Stripe payment-method setup could not be verified.",
      503,
    );
  }
  return stripe.setupIntents.retrieve(setupIntentRef, {
    expand: ["payment_method"],
  });
};

export const completeTrialPaymentMethodCheckout = async ({ checkoutSession }) => {
  if (
    checkoutSession?.mode !== "setup" ||
    checkoutSession?.metadata?.purpose !== "trial_payment_method"
  ) {
    return null;
  }

  const businessId = checkoutSession.metadata.businessId;
  const expectedSubscriptionId = checkoutSession.metadata.stripeSubscriptionId;
  const subscription = await Subscription.findOne({ business: businessId });
  if (!subscription) return null;
  if (
    !expectedSubscriptionId ||
    String(subscription.stripeSubscriptionId || "") !==
      String(expectedSubscriptionId)
  ) {
    await recordBillingAnomaly({
      businessId,
      type: "trial_setup_subscription_mismatch",
      severity: "critical",
      stripeCustomerId: subscription.stripeCustomerId,
      canonicalSubscriptionId: subscription.stripeSubscriptionId,
      observedSubscriptionId: expectedSubscriptionId || "",
      source: "checkout.session.completed",
      dedupeKey: `trial-setup-mismatch:${checkoutSession.id || "unknown"}`,
      details: { checkoutSessionId: checkoutSession.id || "" },
    });
    return subscription;
  }
  const stripe = getStripeClient();
  requireStripeActionApis(stripe);
  const canonicalRemote = await assertCanonicalIsOnlyLiveSubscription({
    stripe,
    subscription,
    source: "trial_payment_method_complete",
  });
  const canonicalStatus = String(canonicalRemote.status || "").toLowerCase();
  if (!["trialing", "paused"].includes(canonicalStatus)) {
    throw actionError(
      "TRIAL_SUBSCRIPTION_REQUIRED",
      "The canonical Stripe trial is no longer eligible for payment-method setup.",
      409,
    );
  }

  const setupIntent = await getSetupIntent(stripe, checkoutSession);
  const paymentMethodId =
    typeof setupIntent?.payment_method === "string"
      ? setupIntent.payment_method
      : setupIntent?.payment_method?.id;
  if (!paymentMethodId) {
    throw actionError(
      "PAYMENT_METHOD_NOT_FOUND",
      "Stripe did not return a payment method for the completed setup session.",
      409,
    );
  }

  await stripe.subscriptions.update(
    subscription.stripeSubscriptionId,
    { default_payment_method: paymentMethodId },
    {
      idempotencyKey: `callbackiq:trial-default-payment-method:${checkoutSession.id}`,
    },
  );
  if (stripe?.customers?.update && subscription.stripeCustomerId) {
    await stripe.customers.update(
      subscription.stripeCustomerId,
      { invoice_settings: { default_payment_method: paymentMethodId } },
      {
        idempotencyKey: `callbackiq:customer-default-payment-method:${checkoutSession.id}`,
      },
    );
  }

  if (canonicalStatus === "paused") {
    if (!stripe?.subscriptions?.resume) {
      throw actionError(
        "STRIPE_SUBSCRIPTION_RESUME_UNAVAILABLE",
        "Stripe subscription reactivation is not configured.",
        503,
      );
    }
    const resumedSubscription = await stripe.subscriptions.resume(
      subscription.stripeSubscriptionId,
      { billing_cycle_anchor: "now" },
      {
        idempotencyKey: `callbackiq:trial-reactivation-resume:${checkoutSession.id}`,
      },
    );
    return syncStripeSubscription({
      stripeSubscription: resumedSubscription,
      refreshFromStripe: false,
      observedSubscription:subscription,
    });
  }

  return (await completeObservedSubscription({businessId:subscription.business,observed:subscription,
    fields:{lastPaymentStatus:'trial_payment_method_added'}})).current;
};
export const resumeCanonicalSubscription = async ({ businessId }) => {
  const subscription = await Subscription.findOne({ business: businessId });
  if (!subscription?.stripeSubscriptionId || !subscription?.stripeCustomerId) {
    throw actionError(
      "ACTIVE_STRIPE_SUBSCRIPTION_NOT_FOUND",
      "A Stripe subscription was not found for this business.",
      409,
    );
  }

  const stripe = getStripeClient();
  requireStripeActionApis(stripe);
  const canonicalRemote = await assertCanonicalIsOnlyLiveSubscription({
    stripe,
    subscription,
    source: "resume_subscription",
  });

  if (!canonicalRemote.cancel_at_period_end) {
    return syncStripeSubscription({
      stripeSubscription: canonicalRemote,
      refreshFromStripe: false,
      observedSubscription:subscription,
    });
  }

  const updated = await stripe.subscriptions.update(
    subscription.stripeSubscriptionId,
    { cancel_at_period_end: false },
    {
      idempotencyKey: `callbackiq:resume:${subscription.stripeSubscriptionId}:${canonicalRemote.current_period_end || "current"}`,
    },
  );

  return syncStripeSubscription({
    stripeSubscription: updated,
    refreshFromStripe: false,
    observedSubscription:subscription,
  });
};

export default {
  createTrialPaymentMethodCheckout,
  completeTrialPaymentMethodCheckout,
  resumeCanonicalSubscription,
};
