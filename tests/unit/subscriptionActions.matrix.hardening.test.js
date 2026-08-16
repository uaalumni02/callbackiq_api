/*
 * High-risk billing action matrix.
 *
 * Intentionally mocks Stripe/network boundaries and exercises state-machine
 * branches directly. These tests are designed to catch duplicate-subscription,
 * paused-trial, setup-intent, and resume regressions without making real Stripe
 * calls.
 */

const mockSubscriptionFindOne = jest.fn();
const mockSubscriptionFindByIdAndUpdate = jest.fn();
const mockGetStripeClient = jest.fn();
const mockAssertCanonical = jest.fn();
const mockRecordBillingAnomaly = jest.fn();
const mockCreateSubscriptionCheckout = jest.fn();
const mockSyncStripeSubscription = jest.fn();

jest.mock("../../src/models/subscription.js", () => ({
  __esModule: true,
  default: {
    findOne: (...args) => mockSubscriptionFindOne(...args),
    findByIdAndUpdate: (...args) => mockSubscriptionFindByIdAndUpdate(...args),
  },
}));

jest.mock("../../src/helpers/stripe/stripeClient.js", () => ({
  getStripeClient: (...args) => mockGetStripeClient(...args),
}));

jest.mock("../../src/services/subscriptionIntegrity.service.js", () => ({
  assertCanonicalIsOnlyLiveSubscription: (...args) => mockAssertCanonical(...args),
  recordBillingAnomaly: (...args) => mockRecordBillingAnomaly(...args),
}));

jest.mock("../../src/services/trialLifecycle.service.js", () => ({
  createSubscriptionCheckout: (...args) => mockCreateSubscriptionCheckout(...args),
  syncStripeSubscription: (...args) => mockSyncStripeSubscription(...args),
}));

const {
  createTrialPaymentMethodCheckout,
  completeTrialPaymentMethodCheckout,
  resumeCanonicalSubscription,
} = require("../../src/services/subscriptionActions.service.js");

const BUSINESS = { _id: "biz_123" };
const OWNER_ID = "owner_123";

const localSubscription = (overrides = {}) => ({
  _id: "local_sub_123",
  business: BUSINESS._id,
  plan: "pro",
  stripeCustomerId: "cus_123",
  stripeSubscriptionId: "sub_123",
  ...overrides,
});

const makeStripe = (overrides = {}) => {
  const stripe = {
    checkout: {
      sessions: {
        create: jest.fn().mockResolvedValue({
          id: "cs_setup_123",
          url: "https://checkout.stripe.test/setup",
        }),
      },
    },
    subscriptions: {
      retrieve: jest.fn(),
      update: jest.fn().mockResolvedValue({
        id: "sub_123",
        status: "trialing",
      }),
      resume: jest.fn().mockResolvedValue({
        id: "sub_123",
        status: "active",
      }),
    },
    setupIntents: {
      retrieve: jest.fn().mockResolvedValue({
        id: "seti_123",
        payment_method: { id: "pm_123" },
      }),
    },
    customers: {
      update: jest.fn().mockResolvedValue({ id: "cus_123" }),
    },
    ...overrides,
  };
  return stripe;
};

const expectDomainError = async (promise, code, statusCode) => {
  await expect(promise).rejects.toMatchObject({ code, statusCode });
};

describe("subscriptionActions.service billing action matrix", () => {
  const originalClientUrl = process.env.CLIENT_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CLIENT_URL = "https://app.callbackiq.test";
    mockRecordBillingAnomaly.mockResolvedValue(null);
    mockSyncStripeSubscription.mockImplementation(async ({ stripeSubscription }) => ({
      synced: stripeSubscription,
    }));
    mockCreateSubscriptionCheckout.mockResolvedValue({
      checkoutUrl: "https://checkout.stripe.test/new-subscription",
    });
  });

  afterAll(() => {
    if (originalClientUrl === undefined) delete process.env.CLIENT_URL;
    else process.env.CLIENT_URL = originalClientUrl;
  });

  describe("createTrialPaymentMethodCheckout", () => {
    test.each([
      [null],
      [localSubscription({ stripeCustomerId: "" })],
      [localSubscription({ stripeSubscriptionId: "" })],
    ])("requires a complete canonical local Stripe subscription (%#)", async (subscription) => {
      mockSubscriptionFindOne.mockResolvedValue(subscription);

      await expectDomainError(
        createTrialPaymentMethodCheckout({ business: BUSINESS, ownerId: OWNER_ID }),
        "TRIAL_SUBSCRIPTION_REQUIRED",
        409,
      );
      expect(mockGetStripeClient).not.toHaveBeenCalled();
    });

    test("fails closed when Stripe Checkout is unavailable", async () => {
      mockSubscriptionFindOne.mockResolvedValue(localSubscription());
      mockGetStripeClient.mockReturnValue({ subscriptions: {} });

      await expectDomainError(
        createTrialPaymentMethodCheckout({ business: BUSINESS, ownerId: OWNER_ID }),
        "STRIPE_NOT_CONFIGURED",
        503,
      );
    });

    test("falls back to paid checkout when the canonical trial is no longer live", async () => {
      mockSubscriptionFindOne.mockResolvedValue(localSubscription({ plan: "agency" }));
      const stripe = makeStripe();
      mockGetStripeClient.mockReturnValue(stripe);
      const stale = new Error("not live");
      stale.code = "CANONICAL_STRIPE_SUBSCRIPTION_NOT_LIVE";
      mockAssertCanonical.mockRejectedValue(stale);

      const result = await createTrialPaymentMethodCheckout({
        business: BUSINESS,
        ownerId: OWNER_ID,
      });

      expect(result).toEqual({
        checkoutUrl: "https://checkout.stripe.test/new-subscription",
      });
      expect(mockCreateSubscriptionCheckout).toHaveBeenCalledWith({
        business: BUSINESS,
        ownerId: OWNER_ID,
        plan: "agency",
        requireTrial: false,
      });
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    test("uses pro as the fallback paid plan when the local plan is absent", async () => {
      mockSubscriptionFindOne.mockResolvedValue(localSubscription({ plan: "" }));
      mockGetStripeClient.mockReturnValue(makeStripe());
      const stale = new Error("not live");
      stale.code = "CANONICAL_STRIPE_SUBSCRIPTION_NOT_LIVE";
      mockAssertCanonical.mockRejectedValue(stale);

      await createTrialPaymentMethodCheckout({ business: BUSINESS, ownerId: OWNER_ID });

      expect(mockCreateSubscriptionCheckout).toHaveBeenCalledWith(
        expect.objectContaining({ plan: "pro", requireTrial: false }),
      );
    });

    test("does not hide unrelated canonical-integrity failures", async () => {
      mockSubscriptionFindOne.mockResolvedValue(localSubscription());
      mockGetStripeClient.mockReturnValue(makeStripe());
      const duplicate = Object.assign(new Error("duplicate"), {
        code: "DUPLICATE_STRIPE_SUBSCRIPTIONS",
        statusCode: 409,
      });
      mockAssertCanonical.mockRejectedValue(duplicate);

      await expect(
        createTrialPaymentMethodCheckout({ business: BUSINESS, ownerId: OWNER_ID }),
      ).rejects.toBe(duplicate);
      expect(mockCreateSubscriptionCheckout).not.toHaveBeenCalled();
    });

    test.each(["active", "past_due", "unpaid", "canceled", "incomplete"])(
      "rejects canonical status %s for trial payment-method setup",
      async (status) => {
        mockSubscriptionFindOne.mockResolvedValue(localSubscription());
        mockGetStripeClient.mockReturnValue(makeStripe());
        mockAssertCanonical.mockResolvedValue({ id: "sub_123", status });

        await expectDomainError(
          createTrialPaymentMethodCheckout({ business: BUSINESS, ownerId: OWNER_ID }),
          "TRIAL_SUBSCRIPTION_REQUIRED",
          409,
        );
      },
    );

    test("creates an idempotent setup Checkout for an active trial", async () => {
      const subscription = localSubscription();
      const stripe = makeStripe();
      mockSubscriptionFindOne.mockResolvedValue(subscription);
      mockGetStripeClient.mockReturnValue(stripe);
      mockAssertCanonical.mockResolvedValue({ id: "sub_123", status: "trialing" });

      const result = await createTrialPaymentMethodCheckout({
        business: BUSINESS,
        ownerId: OWNER_ID,
      });

      expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "setup",
          customer: "cus_123",
          success_url:
            "https://app.callbackiq.test/billing?payment_method=added&session_id={CHECKOUT_SESSION_ID}",
          cancel_url: "https://app.callbackiq.test/billing?payment_method=cancelled",
          metadata: expect.objectContaining({
            purpose: "trial_payment_method",
            businessId: "biz_123",
            ownerId: OWNER_ID,
            stripeSubscriptionId: "sub_123",
            reactivatePausedTrial: "false",
          }),
        }),
        {
          idempotencyKey: "callbackiq:trial-payment-method:biz_123:sub_123",
        },
      );
      expect(result).toMatchObject({
        checkoutSessionId: "cs_setup_123",
        subscription,
        reactivatingPausedTrial: false,
      });
    });

    test("creates a separate idempotent reactivation setup flow for a paused trial", async () => {
      mockSubscriptionFindOne.mockResolvedValue(localSubscription());
      const stripe = makeStripe();
      mockGetStripeClient.mockReturnValue(stripe);
      mockAssertCanonical.mockResolvedValue({ id: "sub_123", status: "paused" });

      const result = await createTrialPaymentMethodCheckout({
        business: BUSINESS,
        ownerId: OWNER_ID,
      });

      expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          success_url:
            "https://app.callbackiq.test/billing?payment_method=added&reactivation=started&session_id={CHECKOUT_SESSION_ID}",
          metadata: expect.objectContaining({ reactivatePausedTrial: "true" }),
        }),
        {
          idempotencyKey:
            "callbackiq:trial-reactivation-payment-method:biz_123:sub_123",
        },
      );
      expect(result.reactivatingPausedTrial).toBe(true);
    });
  });

  describe("completeTrialPaymentMethodCheckout", () => {
    const setupSession = (overrides = {}) => ({
      id: "cs_setup_123",
      mode: "setup",
      setup_intent: { payment_method: { id: "pm_123" } },
      metadata: {
        purpose: "trial_payment_method",
        businessId: "biz_123",
        stripeSubscriptionId: "sub_123",
      },
      ...overrides,
    });

    test.each([
      [{ mode: "payment", metadata: { purpose: "trial_payment_method" } }],
      [{ mode: "setup", metadata: { purpose: "other" } }],
      [null],
    ])("ignores checkout sessions unrelated to trial payment-method setup (%#)", async (session) => {
      await expect(
        completeTrialPaymentMethodCheckout({ checkoutSession: session }),
      ).resolves.toBeNull();
      expect(mockSubscriptionFindOne).not.toHaveBeenCalled();
    });

    test("returns null when the local business subscription disappeared", async () => {
      mockSubscriptionFindOne.mockResolvedValue(null);

      await expect(
        completeTrialPaymentMethodCheckout({ checkoutSession: setupSession() }),
      ).resolves.toBeNull();
      expect(mockGetStripeClient).not.toHaveBeenCalled();
    });

    test("records and contains a mismatched setup session instead of mutating another subscription", async () => {
      const subscription = localSubscription();
      mockSubscriptionFindOne.mockResolvedValue(subscription);

      const result = await completeTrialPaymentMethodCheckout({
        checkoutSession: setupSession({
          metadata: {
            purpose: "trial_payment_method",
            businessId: "biz_123",
            stripeSubscriptionId: "sub_attacker_or_stale",
          },
        }),
      });

      expect(result).toBe(subscription);
      expect(mockRecordBillingAnomaly).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "trial_setup_subscription_mismatch",
          severity: "critical",
          canonicalSubscriptionId: "sub_123",
          observedSubscriptionId: "sub_attacker_or_stale",
          dedupeKey: "trial-setup-mismatch:cs_setup_123",
        }),
      );
      expect(mockGetStripeClient).not.toHaveBeenCalled();
    });

    test.each([
      [null],
      [{}],
      [{ subscriptions: { retrieve: jest.fn() } }],
      [{ subscriptions: { update: jest.fn() } }],
    ])("fails closed when Stripe subscription action APIs are incomplete (%#)", async (stripe) => {
      mockSubscriptionFindOne.mockResolvedValue(localSubscription());
      mockGetStripeClient.mockReturnValue(stripe);

      await expectDomainError(
        completeTrialPaymentMethodCheckout({ checkoutSession: setupSession() }),
        "STRIPE_NOT_CONFIGURED",
        503,
      );
    });

    test.each(["active", "past_due", "unpaid", "canceled"])(
      "refuses setup completion after canonical status moves to %s",
      async (status) => {
        mockSubscriptionFindOne.mockResolvedValue(localSubscription());
        mockGetStripeClient.mockReturnValue(makeStripe());
        mockAssertCanonical.mockResolvedValue({ id: "sub_123", status });

        await expectDomainError(
          completeTrialPaymentMethodCheckout({ checkoutSession: setupSession() }),
          "TRIAL_SUBSCRIPTION_REQUIRED",
          409,
        );
      },
    );

    test("fails if Stripe omitted setup_intent/payment method", async () => {
      mockSubscriptionFindOne.mockResolvedValue(localSubscription());
      mockGetStripeClient.mockReturnValue(makeStripe());
      mockAssertCanonical.mockResolvedValue({ id: "sub_123", status: "trialing" });

      await expectDomainError(
        completeTrialPaymentMethodCheckout({
          checkoutSession: setupSession({ setup_intent: null }),
        }),
        "PAYMENT_METHOD_NOT_FOUND",
        409,
      );
    });

    test("fails closed when a string setup_intent cannot be retrieved", async () => {
      mockSubscriptionFindOne.mockResolvedValue(localSubscription());
      const stripe = makeStripe({ setupIntents: {} });
      mockGetStripeClient.mockReturnValue(stripe);
      mockAssertCanonical.mockResolvedValue({ id: "sub_123", status: "trialing" });

      await expectDomainError(
        completeTrialPaymentMethodCheckout({
          checkoutSession: setupSession({ setup_intent: "seti_123" }),
        }),
        "STRIPE_SETUP_INTENT_UNAVAILABLE",
        503,
      );
    });

    test("retrieves a string setup_intent and sets both subscription and customer defaults", async () => {
      mockSubscriptionFindOne.mockResolvedValue(localSubscription());
      const stripe = makeStripe();
      stripe.setupIntents.retrieve.mockResolvedValue({ payment_method: "pm_string" });
      mockGetStripeClient.mockReturnValue(stripe);
      mockAssertCanonical.mockResolvedValue({ id: "sub_123", status: "trialing" });
      mockSubscriptionFindByIdAndUpdate.mockResolvedValue({
        ...localSubscription(),
        lastPaymentStatus: "trial_payment_method_added",
      });

      const result = await completeTrialPaymentMethodCheckout({
        checkoutSession: setupSession({ setup_intent: "seti_123" }),
      });

      expect(stripe.setupIntents.retrieve).toHaveBeenCalledWith("seti_123", {
        expand: ["payment_method"],
      });
      expect(stripe.subscriptions.update).toHaveBeenCalledWith(
        "sub_123",
        { default_payment_method: "pm_string" },
        { idempotencyKey: "callbackiq:trial-default-payment-method:cs_setup_123" },
      );
      expect(stripe.customers.update).toHaveBeenCalledWith(
        "cus_123",
        { invoice_settings: { default_payment_method: "pm_string" } },
        { idempotencyKey: "callbackiq:customer-default-payment-method:cs_setup_123" },
      );
      expect(mockSubscriptionFindByIdAndUpdate).toHaveBeenCalledWith(
        "local_sub_123",
        { $set: { lastPaymentStatus: "trial_payment_method_added" } },
        { returnDocument: "after", runValidators: true },
      );
      expect(result.lastPaymentStatus).toBe("trial_payment_method_added");
    });

    test("does not require a Stripe customer update API to complete a trial", async () => {
      mockSubscriptionFindOne.mockResolvedValue(localSubscription());
      const stripe = makeStripe({ customers: {} });
      mockGetStripeClient.mockReturnValue(stripe);
      mockAssertCanonical.mockResolvedValue({ id: "sub_123", status: "trialing" });
      mockSubscriptionFindByIdAndUpdate.mockResolvedValue(localSubscription());

      await expect(
        completeTrialPaymentMethodCheckout({ checkoutSession: setupSession() }),
      ).resolves.toBeTruthy();
      expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    });

    test("requires the Stripe resume API for paused-trial reactivation", async () => {
      mockSubscriptionFindOne.mockResolvedValue(localSubscription());
      const stripe = makeStripe();
      delete stripe.subscriptions.resume;
      mockGetStripeClient.mockReturnValue(stripe);
      mockAssertCanonical.mockResolvedValue({ id: "sub_123", status: "paused" });

      await expectDomainError(
        completeTrialPaymentMethodCheckout({ checkoutSession: setupSession() }),
        "STRIPE_SUBSCRIPTION_RESUME_UNAVAILABLE",
        503,
      );
      // Payment method is attached first; resume is the separately guarded action.
      expect(stripe.subscriptions.update).toHaveBeenCalledWith(
        "sub_123",
        { default_payment_method: "pm_123" },
        expect.any(Object),
      );
    });

    test("resumes a paused trial idempotently and synchronizes the returned Stripe state", async () => {
      mockSubscriptionFindOne.mockResolvedValue(localSubscription());
      const stripe = makeStripe();
      const resumed = { id: "sub_123", status: "active", current_period_end: 1999999999 };
      stripe.subscriptions.resume.mockResolvedValue(resumed);
      mockGetStripeClient.mockReturnValue(stripe);
      mockAssertCanonical.mockResolvedValue({ id: "sub_123", status: "paused" });

      const result = await completeTrialPaymentMethodCheckout({
        checkoutSession: setupSession(),
      });

      expect(stripe.subscriptions.resume).toHaveBeenCalledWith(
        "sub_123",
        { billing_cycle_anchor: "now" },
        { idempotencyKey: "callbackiq:trial-reactivation-resume:cs_setup_123" },
      );
      expect(mockSyncStripeSubscription).toHaveBeenCalledWith({
        stripeSubscription: resumed,
        refreshFromStripe: false,
      });
      expect(result).toEqual({ synced: resumed });
    });
  });

  describe("resumeCanonicalSubscription", () => {
    test.each([
      [null],
      [localSubscription({ stripeSubscriptionId: "" })],
      [localSubscription({ stripeCustomerId: "" })],
    ])("requires a canonical Stripe subscription (%#)", async (subscription) => {
      mockSubscriptionFindOne.mockResolvedValue(subscription);

      await expectDomainError(
        resumeCanonicalSubscription({ businessId: BUSINESS._id }),
        "ACTIVE_STRIPE_SUBSCRIPTION_NOT_FOUND",
        409,
      );
    });

    test("fails closed when Stripe subscription action APIs are unavailable", async () => {
      mockSubscriptionFindOne.mockResolvedValue(localSubscription());
      mockGetStripeClient.mockReturnValue({ subscriptions: { retrieve: jest.fn() } });

      await expectDomainError(
        resumeCanonicalSubscription({ businessId: BUSINESS._id }),
        "STRIPE_NOT_CONFIGURED",
        503,
      );
    });

    test("is idempotent when cancel_at_period_end is already false", async () => {
      mockSubscriptionFindOne.mockResolvedValue(localSubscription());
      const stripe = makeStripe();
      mockGetStripeClient.mockReturnValue(stripe);
      const remote = {
        id: "sub_123",
        status: "active",
        cancel_at_period_end: false,
      };
      mockAssertCanonical.mockResolvedValue(remote);

      const result = await resumeCanonicalSubscription({ businessId: BUSINESS._id });

      expect(stripe.subscriptions.update).not.toHaveBeenCalled();
      expect(mockSyncStripeSubscription).toHaveBeenCalledWith({
        stripeSubscription: remote,
        refreshFromStripe: false,
      });
      expect(result).toEqual({ synced: remote });
    });

    test("uncancels the exact canonical subscription with a stable idempotency key", async () => {
      mockSubscriptionFindOne.mockResolvedValue(localSubscription());
      const stripe = makeStripe();
      const remote = {
        id: "sub_123",
        status: "active",
        cancel_at_period_end: true,
        current_period_end: 1800000000,
      };
      const updated = { ...remote, cancel_at_period_end: false };
      mockGetStripeClient.mockReturnValue(stripe);
      mockAssertCanonical.mockResolvedValue(remote);
      stripe.subscriptions.update.mockResolvedValue(updated);

      const result = await resumeCanonicalSubscription({ businessId: BUSINESS._id });

      expect(stripe.subscriptions.update).toHaveBeenCalledWith(
        "sub_123",
        { cancel_at_period_end: false },
        { idempotencyKey: "callbackiq:resume:sub_123:1800000000" },
      );
      expect(mockSyncStripeSubscription).toHaveBeenCalledWith({
        stripeSubscription: updated,
        refreshFromStripe: false,
      });
      expect(result).toEqual({ synced: updated });
    });

    test("uses a deterministic fallback idempotency key if period end is absent", async () => {
      mockSubscriptionFindOne.mockResolvedValue(localSubscription());
      const stripe = makeStripe();
      mockGetStripeClient.mockReturnValue(stripe);
      mockAssertCanonical.mockResolvedValue({
        id: "sub_123",
        status: "active",
        cancel_at_period_end: true,
      });

      await resumeCanonicalSubscription({ businessId: BUSINESS._id });

      expect(stripe.subscriptions.update).toHaveBeenCalledWith(
        "sub_123",
        { cancel_at_period_end: false },
        { idempotencyKey: "callbackiq:resume:sub_123:current" },
      );
    });
  });
});
