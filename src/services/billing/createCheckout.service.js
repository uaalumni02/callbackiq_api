import {
  withDistributedLease,
  assertDistributedLeaseActive,
} from "../distributedLease.service.js";
import {
  openCheckoutAttempt,
  retireLegacyCheckout,
} from "./checkoutAttempt.service.js";
import { requirePaidServiceReady } from "./paidReadiness.service.js";
import { assertCapabilityEnabled } from "../../config/capabilities.js";
const parameters = (
  {
    business,
    ownerId,
    offerTrial,
    returnToSetup,
    stripeCustomerId,
    priceId,
    smsPending,
  },
  deps,
) => {
  const { TRIAL_DAYS } = deps,
    clientUrl = process.env.CLIENT_URL;
  const metadata = {
    ownerId: String(ownerId),
    businessId: String(business._id),
    plan: "pro",
    trialRequested: String(offerTrial),
  };
  const subscription_data = { metadata };
  if (offerTrial)
    Object.assign(subscription_data, {
      trial_period_days: TRIAL_DAYS,
      trial_settings: { end_behavior: { missing_payment_method: "pause" } },
    });
  return {
    mode: "subscription",
    customer: stripeCustomerId,
    line_items: [{ price: priceId, quantity: 1 }],
    metadata,
    subscription_data,
    success_url: returnToSetup
      ? `${clientUrl}/trial/activate/success?session_id={CHECKOUT_SESSION_ID}`
      : `${clientUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: returnToSetup
      ? `${clientUrl}/setup?step=activate&trial=cancelled`
      : `${clientUrl}/billing`,
    payment_method_collection: offerTrial ? "if_required" : "always",
    ...(smsPending
      ? {
          custom_text: {
            submit: {
              message:
                "Text messaging is pending carrier approval and remains disabled until approved. Approval timing is not guaranteed.",
            },
          },
        }
      : {}),
  };
};
const validateAccess = async (
  { business, ownerId, requireTrial, plan },
  deps,
) => {
  const {
    Subscription,
    getSubscriptionAccess,
    ACCESS_LEVELS,
    lifecycleError,
    getTrialEligibility,
  } = deps;
  if (plan !== "pro")
    throw lifecycleError(
      "UNSUPPORTED_PILOT_PLAN",
      "Only the PRO plan is available for this pilot.",
      400,
    );
  const existing = await Subscription.findOne({ business: business._id });
  if (getSubscriptionAccess(existing).level === ACCESS_LEVELS.FULL)
    throw lifecycleError(
      existing.status === "trialing"
        ? "TRIAL_ALREADY_ACTIVE"
        : "SUBSCRIPTION_ALREADY_ACTIVE",
      "Your subscription is already active. Use Billing to manage it.",
      409,
    );
  const eligibility = await getTrialEligibility({
    business,
    ownerId,
    subscription: existing,
  });
  if (requireTrial && !eligibility.eligible)
    throw lifecycleError(
      eligibility.reason === "disposable_email"
        ? "TRIAL_EMAIL_NOT_ELIGIBLE"
        : "TRIAL_ALREADY_USED",
      "This business is not eligible for another free trial.",
      409,
    );
  return existing;
};
const finishCheckout = async (
  {
    checkout,
    existing,
    stripeCustomerId,
    priceId,
    offerTrial,
    business,
    smsPending,
  },
  deps,
) => {
  const completion = await deps.completeObservedSubscription({
    businessId: business._id,
    observed: existing,
    fields: {
      stripeCustomerId,
      stripePriceId: priceId,
      checkoutSessionId: checkout.id,
      plan: "pro",
      status: "incomplete",
      lastPaymentStatus: offerTrial
        ? "trial_checkout_started"
        : "checkout_started",
      isActive: false,
      aiEnabled: false,
      priceMonthly: deps.TRIAL_PRICE_MONTHLY,
    },
  });
  if (
    !completion.applied &&
    !deps.matchesCheckoutReceipt(completion.current, {
      sessionId: checkout.id,
      customerId: stripeCustomerId,
      priceId,
      plan: "pro",
      trialOffered: offerTrial,
    })
  )
    throw Object.assign(
      deps.lifecycleError(
        "CHECKOUT_STATE_CHANGED",
        "Subscription changed. Reload Billing before continuing.",
        409,
      ),
      { current: completion.current },
    );
  return {
    checkoutUrl: checkout.url,
    checkoutSessionId: checkout.id,
    subscription: completion.current,
    trialOffered: offerTrial,
    smsPending,
  };
};
const checkoutCustomer = async (
  { stripe, business, ownerId, existing },
  deps,
) => {
  const stripeCustomerId = await deps.getCheckoutCustomer({
    stripe,
    business,
    ownerId,
    subscription: existing,
  });
  await deps.assertStripeCustomerHasNoCompetingSubscriptions({
    stripe,
    business,
    existingSubscription: existing,
    stripeCustomerId,
  });
  return stripeCustomerId;
};
const openReadyCheckout = async (context, deps) => {
  const {
    stripe,
    business,
    ownerId,
    returnToSetup,
    offerTrial,
    smsPending,
    stripeCustomerId,
    priceId,
    existing,
  } = context;
  assertDistributedLeaseActive();
  await retireLegacyCheckout({
    stripe,
    businessId: business._id,
    sessionId: existing?.checkoutSessionId,
  });
  const params = parameters(
    {
      business,
      ownerId,
      offerTrial,
      returnToSetup,
      stripeCustomerId,
      priceId,
      smsPending,
    },
    deps,
  );
  const checkout = await openCheckoutAttempt({
    stripe,
    businessId: business._id,
    purpose: offerTrial ? "trial" : "paid",
    params,
  });
  return finishCheckout(
    {
      checkout,
      existing,
      stripeCustomerId,
      priceId,
      offerTrial,
      business,
      smsPending,
    },
    deps,
  );
};
const execute = async (input, deps) => {
  const {
    business,
    ownerId,
    plan = "pro",
    requireTrial = false,
    returnToSetup = false,
  } = input;
  assertCapabilityEnabled("billing");
  let existing = await validateAccess({ ...input, plan }, deps),
    smsPending = false;
  const priceId = deps.getPriceIdByPlan(plan);
  if (!priceId)
    throw deps.lifecycleError(
      "STRIPE_PRICE_NOT_CONFIGURED",
      "The PRO plan is temporarily unavailable.",
      503,
    );
  const stripe = deps.getStripeClient(),
    offerTrial = requireTrial === true;
  if(!stripe?.checkout?.sessions?.create)throw deps.lifecycleError("STRIPE_NOT_CONFIGURED","Secure payment setup is temporarily unavailable.",503);
  if (offerTrial) {
    await deps.assertTrialActivationCapacity(new Date(), business._id);
    const preparation = await deps.prepareTrialForCheckout({
      business,
      ownerId,
    });
    if (!preparation.ready) return { ...preparation, trialOffered: true };
    existing = preparation.subscription;
  } else
    ({ smsPending } = await requirePaidServiceReady({
      businessId: business._id,
      ownerId,
    }));
  const stripeCustomerId = await checkoutCustomer(
    { stripe, business, ownerId, existing },
    deps,
  );
  return openReadyCheckout(
    {
      stripe,
      business,
      ownerId,
      returnToSetup,
      offerTrial,
      smsPending,
      stripeCustomerId,
      priceId,
      existing,
    },
    deps,
  );
};
/** Creates a serialized checkout service with injected orchestration dependencies; uncertain attempts fail closed. */
export const createCheckoutService = (deps) => async (input) => {
  const result = await withDistributedLease(
    `billing-checkout:${input.business._id}`,
    () => execute(input, deps),
    { ttlMs: 60000 },
  );
  if (!result.acquired)
    throw deps.lifecycleError(
      "CHECKOUT_BUSY",
      "Payment setup is already in progress. Wait a moment and reload Billing.",
      409,
    );
  return result.value;
};
