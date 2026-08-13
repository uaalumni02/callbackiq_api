import Subscription from "../../src/models/subscription.js";
import { getStripeClient } from "../../src/helpers/stripe/stripeClient.js";
import {
  assertCanonicalIsOnlyLiveSubscription,
  recordBillingAnomaly,
} from "../../src/services/subscriptionIntegrity.service.js";
import {
  createSubscriptionCheckout,
  syncStripeSubscription,
} from "../../src/services/trialLifecycle.service.js";
import {
  createTrialPaymentMethodCheckout,
  completeTrialPaymentMethodCheckout,
} from "../../src/services/subscriptionActions.service.js";

jest.mock("../../src/models/subscription.js", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
    findByIdAndUpdate: jest.fn(),
  },
}));

jest.mock("../../src/helpers/stripe/stripeClient.js", () => ({
  getStripeClient: jest.fn(),
}));

jest.mock("../../src/services/subscriptionIntegrity.service.js", () => ({
  assertCanonicalIsOnlyLiveSubscription: jest.fn(),
  recordBillingAnomaly: jest.fn(),
}));

jest.mock("../../src/services/trialLifecycle.service.js", () => ({
  createSubscriptionCheckout: jest.fn(),
  syncStripeSubscription: jest.fn(),
}));

const localSubscription = (status = "trialing") => ({
  _id: "local_subscription_id",
  business: "business_123",
  status,
  stripeCustomerId: "cus_trial_123",
  stripeSubscriptionId: "sub_trial_123",
});

const buildStripe = () => ({
  checkout: {
    sessions: {
      create: jest.fn().mockResolvedValue({
        id: "cs_setup_123",
        url: "https://checkout.stripe.test/setup",
      }),
    },
  },
  setupIntents: {
    retrieve: jest.fn().mockResolvedValue({ payment_method: "pm_trial_123" }),
  },
  subscriptions: {
    retrieve: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
    resume: jest.fn().mockResolvedValue({
      id: "sub_trial_123",
      customer: "cus_trial_123",
      status: "active",
      current_period_start: 1786669200,
      current_period_end: 1789347600,
      cancel_at_period_end: false,
      metadata: {
        businessId: "business_123",
        plan: "pro",
      },
      items: { data: [] },
    }),
  },
  customers: {
    update: jest.fn().mockResolvedValue({}),
  },
});

describe("Stripe paused-trial reactivation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CLIENT_URL = "http://localhost:3001";
  });

  test("creates setup checkout for the same paused Stripe trial even when local status is expired", async () => {
    const stripe = buildStripe();
    const subscription = localSubscription("expired");
    Subscription.findOne.mockResolvedValue(subscription);
    getStripeClient.mockReturnValue(stripe);
    assertCanonicalIsOnlyLiveSubscription.mockResolvedValue({
      id: "sub_trial_123",
      status: "paused",
    });

    const result = await createTrialPaymentMethodCheckout({
      business: { _id: "business_123" },
      ownerId: "owner_123",
    });

    expect(result.reactivatingPausedTrial).toBe(true);
    expect(result.checkoutUrl).toBe("https://checkout.stripe.test/setup");
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "setup",
        customer: "cus_trial_123",
        success_url: expect.stringContaining("reactivation=started"),
        metadata: expect.objectContaining({
          purpose: "trial_payment_method",
          stripeSubscriptionId: "sub_trial_123",
          reactivatePausedTrial: "true",
        }),
      }),
      expect.objectContaining({
        idempotencyKey:
          "callbackiq:trial-reactivation-payment-method:business_123:sub_trial_123",
      }),
    );
  });

  test("falls back to the existing paid checkout when the old trial is truly terminal in Stripe", async () => {
    const stripe = buildStripe();
    const subscription = { ...localSubscription("expired"), plan: "pro" };
    Subscription.findOne.mockResolvedValue(subscription);
    getStripeClient.mockReturnValue(stripe);
    const notLive = new Error("canonical subscription is not live");
    notLive.code = "CANONICAL_STRIPE_SUBSCRIPTION_NOT_LIVE";
    assertCanonicalIsOnlyLiveSubscription.mockRejectedValue(notLive);
    createSubscriptionCheckout.mockResolvedValue({
      checkoutUrl: "https://checkout.stripe.test/paid",
      checkoutSessionId: "cs_paid_123",
      trialOffered: false,
    });

    const result = await createTrialPaymentMethodCheckout({
      business: { _id: "business_123" },
      ownerId: "owner_123",
    });

    expect(createSubscriptionCheckout).toHaveBeenCalledWith({
      business: { _id: "business_123" },
      ownerId: "owner_123",
      plan: "pro",
      requireTrial: false,
    });
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(result.checkoutUrl).toBe("https://checkout.stripe.test/paid");
  });

  test("preserves the existing active-trial setup checkout behavior", async () => {
    const stripe = buildStripe();
    Subscription.findOne.mockResolvedValue(localSubscription("trialing"));
    getStripeClient.mockReturnValue(stripe);
    assertCanonicalIsOnlyLiveSubscription.mockResolvedValue({
      id: "sub_trial_123",
      status: "trialing",
    });

    const result = await createTrialPaymentMethodCheckout({
      business: { _id: "business_123" },
      ownerId: "owner_123",
    });

    expect(result.reactivatingPausedTrial).toBe(false);
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        success_url:
          "http://localhost:3001/billing?payment_method=added&session_id={CHECKOUT_SESSION_ID}",
        metadata: expect.objectContaining({ reactivatePausedTrial: "false" }),
      }),
      expect.objectContaining({
        idempotencyKey:
          "callbackiq:trial-payment-method:business_123:sub_trial_123",
      }),
    );
  });

  test("attaches the payment method and resumes the same paused Stripe subscription", async () => {
    const stripe = buildStripe();
    const subscription = localSubscription("paused");
    const synced = { ...subscription, status: "active", isActive: true };
    Subscription.findOne.mockResolvedValue(subscription);
    getStripeClient.mockReturnValue(stripe);
    assertCanonicalIsOnlyLiveSubscription.mockResolvedValue({
      id: "sub_trial_123",
      status: "paused",
    });
    syncStripeSubscription.mockResolvedValue(synced);

    const result = await completeTrialPaymentMethodCheckout({
      checkoutSession: {
        id: "cs_setup_123",
        mode: "setup",
        setup_intent: "seti_123",
        metadata: {
          purpose: "trial_payment_method",
          businessId: "business_123",
          stripeSubscriptionId: "sub_trial_123",
        },
      },
    });

    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      "sub_trial_123",
      { default_payment_method: "pm_trial_123" },
      expect.objectContaining({
        idempotencyKey:
          "callbackiq:trial-default-payment-method:cs_setup_123",
      }),
    );
    expect(stripe.customers.update).toHaveBeenCalledWith(
      "cus_trial_123",
      { invoice_settings: { default_payment_method: "pm_trial_123" } },
      expect.any(Object),
    );
    expect(stripe.subscriptions.resume).toHaveBeenCalledWith(
      "sub_trial_123",
      { billing_cycle_anchor: "now" },
      expect.objectContaining({
        idempotencyKey: "callbackiq:trial-reactivation-resume:cs_setup_123",
      }),
    );
    expect(syncStripeSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeSubscription: expect.objectContaining({ status: "active" }),
        refreshFromStripe: false,
      }),
    );
    expect(result).toEqual(synced);
  });

  test("does not call Stripe resume while the free trial is still active", async () => {
    const stripe = buildStripe();
    const subscription = localSubscription("trialing");
    const updatedLocal = {
      ...subscription,
      lastPaymentStatus: "trial_payment_method_added",
    };
    Subscription.findOne.mockResolvedValue(subscription);
    Subscription.findByIdAndUpdate.mockResolvedValue(updatedLocal);
    getStripeClient.mockReturnValue(stripe);
    assertCanonicalIsOnlyLiveSubscription.mockResolvedValue({
      id: "sub_trial_123",
      status: "trialing",
    });

    const result = await completeTrialPaymentMethodCheckout({
      checkoutSession: {
        id: "cs_setup_123",
        mode: "setup",
        setup_intent: "seti_123",
        metadata: {
          purpose: "trial_payment_method",
          businessId: "business_123",
          stripeSubscriptionId: "sub_trial_123",
        },
      },
    });

    expect(stripe.subscriptions.resume).not.toHaveBeenCalled();
    expect(Subscription.findByIdAndUpdate).toHaveBeenCalled();
    expect(result).toEqual(updatedLocal);
  });

  test("still records subscription-id mismatches without changing Stripe", async () => {
    const stripe = buildStripe();
    const subscription = localSubscription("paused");
    Subscription.findOne.mockResolvedValue(subscription);
    getStripeClient.mockReturnValue(stripe);

    const result = await completeTrialPaymentMethodCheckout({
      checkoutSession: {
        id: "cs_setup_bad",
        mode: "setup",
        metadata: {
          purpose: "trial_payment_method",
          businessId: "business_123",
          stripeSubscriptionId: "sub_other",
        },
      },
    });

    expect(recordBillingAnomaly).toHaveBeenCalledWith(
      expect.objectContaining({ type: "trial_setup_subscription_mismatch" }),
    );
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(stripe.subscriptions.resume).not.toHaveBeenCalled();
    expect(result).toBe(subscription);
  });
});
