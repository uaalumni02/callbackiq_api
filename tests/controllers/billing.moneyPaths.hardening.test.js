/*
 * Billing controller money-path hardening.
 * Tests authentication/ownership boundaries, checkout reconciliation races,
 * Stripe webhook verification/idempotency, invoice canonical guards, and
 * portal/cancellation paths without making network calls.
 */

const mockGetBusinessByOwner = jest.fn();
const mockUpsertSubscriptionByBusiness = jest.fn();
const mockSubscriptionFindOne = jest.fn();
const mockSubscriptionFindByIdAndUpdate = jest.fn();
const mockValidateCheckout = jest.fn();
const mockGetStripeClient = jest.fn();
const mockCreateSubscriptionCheckout = jest.fn();
const mockSyncCheckoutSession = jest.fn();
const mockSyncStripeSubscription = jest.fn();
const mockSendTrialLifecycleMessage = jest.fn();
const mockGetTrialEligibility = jest.fn();
const mockProcessStripeEventOnce = jest.fn();
const mockCreateTrialPaymentMethodCheckout = jest.fn();
const mockCompleteTrialPaymentMethodCheckout = jest.fn();
const mockResumeCanonicalSubscription = jest.fn();
const mockAssertCanonical = jest.fn();
const mockGuardInvoice = jest.fn();
const mockGetSubscriptionAccess = jest.fn();

jest.mock("../../src/db/db.js", () => ({
  __esModule: true,
  default: {
    getBusinessByOwner: (...args) => mockGetBusinessByOwner(...args),
    upsertSubscriptionByBusiness: (...args) => mockUpsertSubscriptionByBusiness(...args),
  },
}));

jest.mock("../../src/models/business.js", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("../../src/models/subscription.js", () => ({
  __esModule: true,
  default: {
    findOne: (...args) => mockSubscriptionFindOne(...args),
    findByIdAndUpdate: (...args) => mockSubscriptionFindByIdAndUpdate(...args),
  },
}));

jest.mock("../../src/models/trialRedemption.js", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("../../src/validator/billing.js", () => ({
  checkoutSchema: {
    validateAsync: (...args) => mockValidateCheckout(...args),
  },
}));

jest.mock("../../src/helpers/stripe/stripeClient.js", () => ({
  getStripeClient: (...args) => mockGetStripeClient(...args),
  getPriceIdByPlan: jest.fn(() => "price_test"),
}));

jest.mock("../../src/helpers/response/response.js", () => ({
  responseOk: jest.fn((res, data, message) =>
    res.status(200).json({ success: true, data, message }),
  ),
  responseBadAuth: jest.fn((res, message) =>
    res.status(401).json({ success: false, message }),
  ),
  responseInvalidInput: jest.fn((res, message) =>
    res.status(400).json({ success: false, message }),
  ),
  responseServerError: jest.fn((res) =>
    res.status(500).json({ success: false, message: "Internal server error" }),
  ),
}));

jest.mock("../../src/services/trialLifecycle.service.js", () => ({
  createSubscriptionCheckout: (...args) => mockCreateSubscriptionCheckout(...args),
  extendTrialByAdmin: jest.fn(),
  sendTrialLifecycleMessage: (...args) => mockSendTrialLifecycleMessage(...args),
  syncCheckoutSession: (...args) => mockSyncCheckoutSession(...args),
  syncStripeSubscription: (...args) => mockSyncStripeSubscription(...args),
}));

jest.mock("../../src/helpers/billing/trial.js", () => ({
  getTrialEligibility: (...args) => mockGetTrialEligibility(...args),
}));

jest.mock("../../src/services/billingEvent.service.js", () => ({
  processStripeEventOnce: (...args) => mockProcessStripeEventOnce(...args),
}));

jest.mock("../../src/services/subscriptionActions.service.js", () => ({
  createTrialPaymentMethodCheckout: (...args) =>
    mockCreateTrialPaymentMethodCheckout(...args),
  completeTrialPaymentMethodCheckout: (...args) =>
    mockCompleteTrialPaymentMethodCheckout(...args),
  resumeCanonicalSubscription: (...args) => mockResumeCanonicalSubscription(...args),
}));

jest.mock("../../src/services/subscriptionIntegrity.service.js", () => ({
  assertCanonicalIsOnlyLiveSubscription: (...args) => mockAssertCanonical(...args),
  guardInvoiceAgainstCanonicalSubscription: (...args) => mockGuardInvoice(...args),
}));

jest.mock("../../src/services/subscriptionAccess.service.js", () => ({
  ACCESS_LEVELS: { FULL: "full", LIMITED: "limited", NONE: "none" },
  getSubscriptionAccess: (...args) => mockGetSubscriptionAccess(...args),
}));

const BillingController = require("../../src/controllers/billing.js").default;

const makeRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn((body) => body);
  return res;
};

const makeReq = (overrides = {}) => ({
  user: { userId: "owner_123" },
  body: {},
  headers: {},
  ...overrides,
});

const BUSINESS = { _id: "biz_123", email: "owner@example.com" };
const LOCAL = {
  _id: "local_123",
  business: "biz_123",
  checkoutSessionId: "cs_owned",
  stripeCustomerId: "cus_123",
  stripeSubscriptionId: "sub_123",
  status: "trialing",
  toObject() {
    return { ...this, toObject: undefined };
  },
};

const makeCheckoutSession = (overrides = {}) => ({
  id: "cs_owned",
  mode: "subscription",
  status: "complete",
  customer: "cus_123",
  subscription: "sub_123",
  metadata: { businessId: "biz_123", ownerId: "owner_123" },
  ...overrides,
});

const makeStripe = (overrides = {}) => ({
  checkout: {
    sessions: {
      retrieve: jest.fn().mockResolvedValue(makeCheckoutSession()),
    },
  },
  subscriptions: {
    retrieve: jest.fn().mockResolvedValue({ id: "sub_123", status: "active" }),
    update: jest.fn().mockResolvedValue({
      id: "sub_123",
      status: "active",
      cancel_at_period_end: true,
      current_period_start: 1800000000,
      current_period_end: 1802592000,
    }),
  },
  webhooks: {
    constructEvent: jest.fn(),
  },
  billingPortal: {
    sessions: {
      create: jest.fn().mockResolvedValue({ url: "https://billing.stripe.test/portal" }),
    },
  },
  invoices: {
    list: jest.fn().mockResolvedValue({ data: [] }),
  },
  ...overrides,
});

const expectResponse = (res, status, partial) => {
  expect(res.status).toHaveBeenCalledWith(status);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining(partial));
};

describe("BillingController money paths", () => {
  const originalWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const originalPortalConfig = process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID = "bpc_restricted";
    mockGetBusinessByOwner.mockResolvedValue(BUSINESS);
    mockSubscriptionFindOne.mockResolvedValue(LOCAL);
    mockValidateCheckout.mockResolvedValue({});
    mockCreateSubscriptionCheckout.mockResolvedValue({
      checkoutUrl: "https://checkout.stripe.test/subscription",
      trialOffered: false,
    });
    mockGetSubscriptionAccess.mockReturnValue({
      status: "trialing",
      level: "full",
      reason: "trial",
      automationAllowed: true,
      providerActionsAllowed: true,
    });
    mockGetTrialEligibility.mockResolvedValue({ eligible: true });
    mockAssertCanonical.mockResolvedValue({ id: "sub_123", status: "active" });
    mockGuardInvoice.mockResolvedValue({ allowed: true, subscription: LOCAL });
    mockSyncStripeSubscription.mockResolvedValue(LOCAL);
    mockSyncCheckoutSession.mockResolvedValue(LOCAL);
    mockCreateTrialPaymentMethodCheckout.mockResolvedValue({ checkoutUrl: "setup" });
    mockResumeCanonicalSubscription.mockResolvedValue(LOCAL);
    mockProcessStripeEventOnce.mockResolvedValue({ duplicate: false, handled: true });
    mockGetStripeClient.mockReturnValue(makeStripe());
  });

  afterAll(() => {
    if (originalWebhookSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = originalWebhookSecret;
    if (originalPortalConfig === undefined) {
      delete process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID;
    } else {
      process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID = originalPortalConfig;
    }
  });

  describe("startFreeTrial/createCheckoutSession", () => {
    test("rejects unauthenticated trial activation before touching billing state", async () => {
      const req = makeReq({ user: undefined });
      const res = makeRes();

      await BillingController.startFreeTrial(req, res);

      expectResponse(res, 401, { success: false });
      expect(mockGetBusinessByOwner).not.toHaveBeenCalled();
      expect(mockCreateSubscriptionCheckout).not.toHaveBeenCalled();
    });

    test("starts a Stripe-native pro trial with onboarding intent preserved", async () => {
      const req = makeReq({ body: { onboarding: true } });
      const res = makeRes();

      await BillingController.startFreeTrial(req, res);

      expect(mockCreateSubscriptionCheckout).toHaveBeenCalledWith({
        business: BUSINESS,
        ownerId: "owner_123",
        plan: "pro",
        requireTrial: true,
        returnToSetup: true,
      });
      expectResponse(res, 200, { success: true });
    });

    test("propagates billing domain errors with their code/status", async () => {
      mockCreateSubscriptionCheckout.mockRejectedValue(
        Object.assign(new Error("Trial already used"), {
          code: "TRIAL_ALREADY_USED",
          statusCode: 409,
        }),
      );
      const res = makeRes();

      await BillingController.startFreeTrial(makeReq(), res);

      expectResponse(res, 409, {
        success: false,
        code: "TRIAL_ALREADY_USED",
        message: "Trial already used",
      });
    });

    test("contains checkout schema failures before creating Stripe sessions", async () => {
      mockValidateCheckout.mockRejectedValue(
        Object.assign(new Error("plan is required"), { isJoi: true }),
      );
      const res = makeRes();

      await BillingController.createCheckoutSession(
        makeReq({ body: { plan: "invalid" } }),
        res,
      );

      expectResponse(res, 400, { success: false, message: "plan is required" });
      expect(mockCreateSubscriptionCheckout).not.toHaveBeenCalled();
    });

    test("creates paid checkout without spending another trial", async () => {
      const res = makeRes();
      await BillingController.createCheckoutSession(
        makeReq({ body: { plan: "agency" } }),
        res,
      );

      expect(mockCreateSubscriptionCheckout).toHaveBeenCalledWith({
        business: BUSINESS,
        ownerId: "owner_123",
        plan: "agency",
        requireTrial: false,
      });
      expectResponse(res, 200, { success: true });
    });
  });

  describe("confirmCheckoutSession ownership + reconciliation", () => {
    test.each(["", "bad", `cs_${"x".repeat(254)}`])(
      "rejects malformed checkout session id %j",
      async (sessionId) => {
        const res = makeRes();
        await BillingController.confirmCheckoutSession(
          makeReq({ body: { sessionId } }),
          res,
        );
        expectResponse(res, 400, { code: "INVALID_CHECKOUT_SESSION" });
        expect(mockGetStripeClient).not.toHaveBeenCalled();
      },
    );

    test("requires the local checkout session id to match before asking Stripe", async () => {
      mockSubscriptionFindOne.mockResolvedValue({ ...LOCAL, checkoutSessionId: "cs_other" });
      const res = makeRes();

      await BillingController.confirmCheckoutSession(
        makeReq({ body: { sessionId: "cs_owned" } }),
        res,
      );

      expectResponse(res, 403, { code: "CHECKOUT_SESSION_MISMATCH" });
    });

    test("fails closed if Checkout retrieval is not configured", async () => {
      mockGetStripeClient.mockReturnValue({});
      const res = makeRes();

      await BillingController.confirmCheckoutSession(
        makeReq({ body: { sessionId: "cs_owned" } }),
        res,
      );

      expectResponse(res, 503, { code: "STRIPE_NOT_CONFIGURED" });
    });

    test.each([
      [Object.assign(new Error("missing"), { code: "resource_missing" })],
      [Object.assign(new Error("missing"), { statusCode: 404 })],
    ])("maps missing Stripe sessions to a stable 404 (%#)", async (error) => {
      const stripe = makeStripe();
      stripe.checkout.sessions.retrieve.mockRejectedValue(error);
      mockGetStripeClient.mockReturnValue(stripe);
      const res = makeRes();

      await BillingController.confirmCheckoutSession(
        makeReq({ body: { sessionId: "cs_owned" } }),
        res,
      );

      expectResponse(res, 404, { code: "CHECKOUT_SESSION_NOT_FOUND" });
    });

    test.each([
      [{ metadata: { businessId: "biz_other", ownerId: "owner_123" } }],
      [{ metadata: { businessId: "biz_123", ownerId: "owner_other" } }],
      [{ customer: "cus_other" }],
    ])("rejects a Stripe session that fails a second ownership boundary (%#)", async (patch) => {
      const stripe = makeStripe();
      stripe.checkout.sessions.retrieve.mockResolvedValue(
        makeCheckoutSession(patch),
      );
      mockGetStripeClient.mockReturnValue(stripe);
      const res = makeRes();

      await BillingController.confirmCheckoutSession(
        makeReq({ body: { session_id: "cs_owned" } }),
        res,
      );

      expectResponse(res, 403, { code: "CHECKOUT_SESSION_OWNERSHIP_MISMATCH" });
      expect(mockSyncCheckoutSession).not.toHaveBeenCalled();
    });

    test("permits an owned Checkout if the local customer id has not been persisted yet", async () => {
      mockSubscriptionFindOne
        .mockResolvedValueOnce({ ...LOCAL, stripeCustomerId: "" })
        .mockResolvedValueOnce({ ...LOCAL, stripeCustomerId: "", status: "active" });
      const stripe = makeStripe();
      stripe.checkout.sessions.retrieve.mockResolvedValue(
        makeCheckoutSession({ customer: "cus_from_stripe" }),
      );
      mockGetStripeClient.mockReturnValue(stripe);
      mockGetSubscriptionAccess.mockReturnValue({ status: "active", level: "full", reason: "paid" });
      const res = makeRes();

      await BillingController.confirmCheckoutSession(
        makeReq({ body: { sessionId: "cs_owned" } }),
        res,
      );

      expectResponse(res, 200, { success: true });
    });

    test.each([
      [{ mode: "setup" }, 400, "CHECKOUT_MODE_INVALID"],
      [{ status: "open" }, 409, "CHECKOUT_NOT_COMPLETE"],
      [{ subscription: null }, 409, "CHECKOUT_SUBSCRIPTION_MISSING"],
    ])("contains invalid Stripe checkout state (%#)", async (patch, status, code) => {
      const stripe = makeStripe();
      stripe.checkout.sessions.retrieve.mockResolvedValue(makeCheckoutSession(patch));
      mockGetStripeClient.mockReturnValue(stripe);
      const res = makeRes();

      await BillingController.confirmCheckoutSession(
        makeReq({ body: { sessionId: "cs_owned" } }),
        res,
      );

      expectResponse(res, status, { code });
      expect(mockSyncCheckoutSession).not.toHaveBeenCalled();
    });

    test("does not repeat checkout lifecycle side effects when the webhook already granted full access", async () => {
      mockSubscriptionFindOne
        .mockResolvedValueOnce(LOCAL)
        .mockResolvedValueOnce({ ...LOCAL, status: "active" });
      mockGetSubscriptionAccess.mockReturnValue({
        status: "active",
        level: "full",
        reason: "paid",
      });
      const res = makeRes();

      await BillingController.confirmCheckoutSession(
        makeReq({ body: { sessionId: "cs_owned" } }),
        res,
      );

      expect(mockSyncCheckoutSession).not.toHaveBeenCalled();
      expectResponse(res, 200, { success: true });
    });

    test("reconciles exactly once when full access has not arrived from the webhook", async () => {
      mockSubscriptionFindOne
        .mockResolvedValueOnce(LOCAL)
        .mockResolvedValueOnce({ ...LOCAL, status: "incomplete" });
      mockGetSubscriptionAccess
        .mockReturnValueOnce({ status: "incomplete", level: "limited", reason: "pending" })
        .mockReturnValueOnce({ status: "active", level: "full", reason: "paid" });
      const reconciled = { ...LOCAL, status: "active" };
      mockSyncCheckoutSession.mockResolvedValue(reconciled);
      const res = makeRes();

      await BillingController.confirmCheckoutSession(
        makeReq({ body: { sessionId: "cs_owned" } }),
        res,
      );

      expect(mockSyncCheckoutSession).toHaveBeenCalledTimes(1);
      expect(reqSubscriptionFromLastResponse(res)).toMatchObject({ status: "active" });
    });

    test("returns a retryable pending state if reconciliation has not materialized locally", async () => {
      mockSubscriptionFindOne
        .mockResolvedValueOnce(LOCAL)
        .mockResolvedValueOnce({ ...LOCAL, status: "incomplete" });
      mockGetSubscriptionAccess.mockReturnValue({
        status: "incomplete",
        level: "limited",
        reason: "pending",
      });
      mockSyncCheckoutSession.mockResolvedValue(null);
      const res = makeRes();

      await BillingController.confirmCheckoutSession(
        makeReq({ body: { sessionId: "cs_owned" } }),
        res,
      );

      expectResponse(res, 409, { code: "CHECKOUT_RECONCILIATION_PENDING" });
    });
  });

  describe("trial payment method/resume endpoints", () => {
    test("surfaces payment-method action domain errors", async () => {
      mockCreateTrialPaymentMethodCheckout.mockRejectedValue(
        Object.assign(new Error("not eligible"), {
          code: "TRIAL_SUBSCRIPTION_REQUIRED",
          statusCode: 409,
        }),
      );
      const res = makeRes();

      await BillingController.createTrialPaymentMethodSession(makeReq(), res);

      expectResponse(res, 409, { code: "TRIAL_SUBSCRIPTION_REQUIRED" });
    });

    test("delegates resume to the canonical-subscription action", async () => {
      const res = makeRes();
      await BillingController.resumeSubscription(makeReq(), res);

      expect(mockResumeCanonicalSubscription).toHaveBeenCalledWith({ businessId: "biz_123" });
      expectResponse(res, 200, { success: true });
    });
  });

  describe("billing portal/cancellation", () => {
    test("refuses an unrestricted portal when the restricted configuration id is missing", async () => {
      delete process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID;
      const res = makeRes();

      await BillingController.createBillingPortalSession(makeReq(), res);

      expect(mockAssertCanonical).toHaveBeenCalled();
      expectResponse(res, 503, { code: "STRIPE_PORTAL_CONFIGURATION_REQUIRED" });
    });

    test("validates canonical subscription before opening the restricted portal", async () => {
      const stripe = makeStripe();
      mockGetStripeClient.mockReturnValue(stripe);
      const res = makeRes();

      await BillingController.createBillingPortalSession(makeReq(), res);

      expect(mockAssertCanonical).toHaveBeenCalledWith({
        stripe,
        subscription: LOCAL,
        source: "billing_portal",
      });
      expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: "cus_123",
          configuration: "bpc_restricted",
        }),
      );
      expectResponse(res, 200, { success: true });
    });

    test("schedules cancellation only on the canonical local Stripe id and persists returned period state", async () => {
      const stripe = makeStripe();
      mockGetStripeClient.mockReturnValue(stripe);
      mockUpsertSubscriptionByBusiness.mockResolvedValue({
        ...LOCAL,
        cancelAtPeriodEnd: true,
      });
      const res = makeRes();

      await BillingController.cancelSubscription(makeReq(), res);

      expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_123", {
        cancel_at_period_end: true,
      });
      expect(mockUpsertSubscriptionByBusiness).toHaveBeenCalledWith(
        expect.anything(),
        "biz_123",
        expect.objectContaining({ cancelAtPeriodEnd: true, status: "active" }),
      );
      expectResponse(res, 200, { success: true });
    });
  });

  describe("Stripe webhook verification/idempotency", () => {
    test("fails closed when webhook verification is not configured", async () => {
      delete process.env.STRIPE_WEBHOOK_SECRET;
      const res = makeRes();

      await BillingController.handleStripeWebhook(
        makeReq({ headers: { "stripe-signature": "sig" }, body: Buffer.from("{}") }),
        res,
      );

      expectResponse(res, 503, { success: false });
      expect(mockGetStripeClient).not.toHaveBeenCalled();
    });

    test("requires a Stripe signature", async () => {
      const res = makeRes();
      await BillingController.handleStripeWebhook(makeReq(), res);
      expectResponse(res, 400, { success: false, message: "Stripe signature is required" });
    });

    test("passes signed events with ids through the durable idempotency processor", async () => {
      const stripe = makeStripe();
      const event = {
        id: "evt_123",
        type: "customer.subscription.updated",
        data: { object: { id: "sub_123" } },
      };
      stripe.webhooks.constructEvent.mockReturnValue(event);
      mockGetStripeClient.mockReturnValue(stripe);
      mockProcessStripeEventOnce.mockResolvedValue({ duplicate: true, handled: true });
      const req = makeReq({
        id: "req_123",
        headers: { "stripe-signature": "sig_123" },
        body: Buffer.from("raw"),
      });
      const res = makeRes();

      await BillingController.handleStripeWebhook(req, res);

      expect(stripe.webhooks.constructEvent).toHaveBeenCalledWith(
        req.body,
        "sig_123",
        "whsec_test",
      );
      expect(mockProcessStripeEventOnce).toHaveBeenCalledWith(
        expect.objectContaining({ event, requestId: "req_123", handlers: expect.any(Object) }),
      );
      expectResponse(res, 200, { success: true, received: true, duplicate: true });
    });

    test("directly dispatches a supported event only when Stripe supplied no event id", async () => {
      const stripe = makeStripe();
      stripe.webhooks.constructEvent.mockReturnValue({
        type: "checkout.session.completed",
        data: { object: { id: "cs_legacy" } },
      });
      mockGetStripeClient.mockReturnValue(stripe);
      const checkoutSpy = jest
        .spyOn(BillingController, "handleCheckoutCompleted")
        .mockResolvedValue({ ok: true });
      const res = makeRes();

      await BillingController.handleStripeWebhook(
        makeReq({ headers: { "stripe-signature": "sig" }, body: Buffer.from("raw") }),
        res,
      );

      expect(mockProcessStripeEventOnce).not.toHaveBeenCalled();
      expect(checkoutSpy).toHaveBeenCalledWith({ id: "cs_legacy" });
      expectResponse(res, 200, { duplicate: false });
      checkoutSpy.mockRestore();
    });

    test("rejects invalid webhook signatures/constructEvent failures", async () => {
      const stripe = makeStripe();
      stripe.webhooks.constructEvent.mockImplementation(() => {
        throw new Error("No signatures found matching the expected signature");
      });
      mockGetStripeClient.mockReturnValue(stripe);
      const res = makeRes();

      await BillingController.handleStripeWebhook(
        makeReq({ headers: { "stripe-signature": "bad" }, body: Buffer.from("raw") }),
        res,
      );

      expectResponse(res, 400, {
        success: false,
        message: "Webhook Error: No signatures found matching the expected signature",
      });
    });
  });

  describe("checkout/invoice event handlers", () => {
    test("routes trial setup completion to the payment-method action", async () => {
      const session = {
        id: "cs_setup",
        mode: "setup",
        metadata: { purpose: "trial_payment_method" },
      };
      mockCompleteTrialPaymentMethodCheckout.mockResolvedValue({ done: true });

      await expect(BillingController.handleCheckoutCompleted(session)).resolves.toEqual({
        done: true,
      });
      expect(mockCompleteTrialPaymentMethodCheckout).toHaveBeenCalledWith({
        checkoutSession: session,
      });
      expect(mockSyncCheckoutSession).not.toHaveBeenCalled();
    });

    test("routes ordinary checkout completion through lifecycle sync", async () => {
      const session = { id: "cs_sub", mode: "subscription", metadata: {} };
      await BillingController.handleCheckoutCompleted(session);
      expect(mockSyncCheckoutSession).toHaveBeenCalledWith(session);
    });

    test.each([
      ["handleInvoicePaid", "invoice.paid", "paid"],
      ["handleInvoicePaymentFailed", "invoice.payment_failed", "failed"],
    ])("%s ignores invoices without subscription ids", async (method) => {
      await expect(BillingController[method]({ id: "in_123" }, "evt_123")).resolves.toBeNull();
      expect(mockGuardInvoice).not.toHaveBeenCalled();
    });

    test.each([
      ["handleInvoicePaid", "invoice.paid", "paid"],
      ["handleInvoicePaymentFailed", "invoice.payment_failed", "failed"],
    ])("%s obeys the canonical invoice guard", async (method, source) => {
      const guardedSubscription = { ...LOCAL, marker: "guarded" };
      mockGuardInvoice.mockResolvedValue({ allowed: false, subscription: guardedSubscription });
      const stripe = makeStripe();
      mockGetStripeClient.mockReturnValue(stripe);

      const result = await BillingController[method](
        { id: "in_123", subscription: "sub_foreign" },
        "evt_123",
      );

      expect(mockGuardInvoice).toHaveBeenCalledWith({
        invoice: { id: "in_123", subscription: "sub_foreign" },
        eventId: "evt_123",
        source,
      });
      expect(result).toBe(guardedSubscription);
      expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    });

    test.each([
      ["handleInvoicePaid", "paid"],
      ["handleInvoicePaymentFailed", "failed"],
    ])("%s retrieves, syncs and stamps the canonical invoice outcome", async (method, outcome) => {
      const stripe = makeStripe();
      const remote = { id: "sub_123", status: outcome === "paid" ? "active" : "past_due" };
      stripe.subscriptions.retrieve.mockResolvedValue(remote);
      mockGetStripeClient.mockReturnValue(stripe);
      mockSyncStripeSubscription.mockResolvedValue(LOCAL);
      mockSubscriptionFindByIdAndUpdate.mockResolvedValue({
        ...LOCAL,
        latestInvoiceId: "in_123",
        lastPaymentStatus: outcome,
      });

      const result = await BillingController[method](
        { id: "in_123", subscription: "sub_123" },
        "evt_123",
      );

      expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith("sub_123", {
        expand: ["latest_invoice"],
      });
      expect(mockSyncStripeSubscription).toHaveBeenCalledWith({
        stripeSubscription: remote,
        refreshFromStripe: false,
      });
      expect(mockSubscriptionFindByIdAndUpdate).toHaveBeenCalledWith(
        "local_123",
        { $set: { latestInvoiceId: "in_123", lastPaymentStatus: outcome } },
        { returnDocument: "after", runValidators: true },
      );
      expect(result.lastPaymentStatus).toBe(outcome);
    });
  });
});

function reqSubscriptionFromLastResponse(res) {
  const body = res.json.mock.calls.at(-1)?.[0];
  return body?.data?.subscription || null;
}
