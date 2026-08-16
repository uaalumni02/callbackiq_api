import BillingController from "../../src/controllers/billing.js";
import db from "../../src/db/db.js";
import Business from "../../src/models/business.js";
import Subscription from "../../src/models/subscription.js";
import { getStripeClient } from "../../src/helpers/stripe/stripeClient.js";
import {
  syncCheckoutSession,
  syncStripeSubscription,
} from "../../src/services/trialLifecycle.service.js";
import { guardInvoiceAgainstCanonicalSubscription } from "../../src/services/subscriptionIntegrity.service.js";
import { getSubscriptionAccess } from "../../src/services/subscriptionAccess.service.js";

jest.mock("../../src/db/db.js", () => ({
  __esModule: true,
  default: {
    getBusinessByOwner: jest.fn(),
    upsertSubscriptionByBusiness: jest.fn(),
  },
}));

jest.mock("../../src/models/business.js", () => ({
  __esModule: true,
  default: {
    findById: jest.fn(),
    findOne: jest.fn(),
    findByIdAndUpdate: jest.fn(),
  },
}));

jest.mock("../../src/models/subscription.js", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    updateOne: jest.fn(),
  },
}));

jest.mock("../../src/models/trialRedemption.js", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("../../src/validator/billing.js", () => ({
  checkoutSchema: {
    validateAsync: jest.fn(),
  },
}));

jest.mock("../../src/helpers/stripe/stripeClient.js", () => ({
  getStripeClient: jest.fn(),
  getPriceIdByPlan: jest.fn(),
}));

jest.mock("../../src/helpers/response/response.js", () => ({
  responseBadAuth: jest.fn((res, message = "Unauthorized") =>
    res.status(401).json({ success: false, message }),
  ),
  responseInvalidInput: jest.fn((res, message = "Invalid input") =>
    res.status(400).json({ success: false, message }),
  ),
  responseOk: jest.fn((res, data, message = "OK") =>
    res.status(200).json({ success: true, data, message }),
  ),
  responseServerError: jest.fn((res, message = "Server error") =>
    res.status(500).json({ success: false, message }),
  ),
}));

jest.mock("../../src/services/trialLifecycle.service.js", () => ({
  createSubscriptionCheckout: jest.fn(),
  extendTrialByAdmin: jest.fn(),
  sendTrialLifecycleMessage: jest.fn(),
  syncCheckoutSession: jest.fn(),
  syncStripeSubscription: jest.fn(),
}));

jest.mock("../../src/helpers/billing/trial.js", () => ({
  getTrialEligibility: jest.fn(),
}));

jest.mock("../../src/services/billingEvent.service.js", () => ({
  processStripeEventOnce: jest.fn(),
}));

jest.mock("../../src/services/subscriptionActions.service.js", () => ({
  createTrialPaymentMethodCheckout: jest.fn(),
  completeTrialPaymentMethodCheckout: jest.fn(),
  resumeCanonicalSubscription: jest.fn(),
}));

jest.mock("../../src/services/subscriptionIntegrity.service.js", () => ({
  assertCanonicalIsOnlyLiveSubscription: jest.fn(),
  guardInvoiceAgainstCanonicalSubscription: jest.fn(),
}));

jest.mock("../../src/services/subscriptionAccess.service.js", () => ({
  ACCESS_LEVELS: { FULL: "full" },
  getSubscriptionAccess: jest.fn(),
}));

const makeRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.send = jest.fn(() => res);
  return res;
};

const makeCheckout = (overrides = {}) => ({
  id: "cs_remote",
  mode: "subscription",
  status: "complete",
  customer: "cus_local",
  subscription: "sub_remote",
  metadata: {
    businessId: "biz-1",
    ownerId: "owner-1",
  },
  ...overrides,
});

const makeRequest = (overrides = {}) => ({
  user: { userId: "owner-1" },
  business: { _id: "biz-1" },
  subscription: {
    _id: "local-sub",
    business: "biz-1",
    stripeCustomerId: "cus_local",
    checkoutSessionId: "cs_remote",
    status: "incomplete",
  },
  body: { sessionId: "cs_remote" },
  headers: {},
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_PORTAL_CONFIGURATION_ID;

  getSubscriptionAccess.mockReturnValue({
    level: "none",
    status: "incomplete",
    reason: "checkout_pending",
  });

  Subscription.findOne.mockResolvedValue({
    _id: "local-sub",
    business: "biz-1",
    stripeCustomerId: "cus_local",
    checkoutSessionId: "cs_remote",
    status: "incomplete",
  });

  syncCheckoutSession.mockResolvedValue({
    _id: "local-sub",
    status: "active",
    business: "biz-1",
  });

  syncStripeSubscription.mockResolvedValue({
    _id: "local-sub",
    status: "active",
    business: "biz-1",
  });

  guardInvoiceAgainstCanonicalSubscription.mockResolvedValue({ allowed: true });
});

describe("billing controller branch hardening", () => {
  test("rejects malformed checkout session ids before calling Stripe", async () => {
    const res = makeRes();
    const stripe = {
      checkout: { sessions: { retrieve: jest.fn() } },
    };
    getStripeClient.mockReturnValue(stripe);

    await BillingController.confirmCheckoutSession(
      makeRequest({ body: { sessionId: "not-a-checkout-session" } }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
  });

  test("rejects a checkout session that conflicts with the locally recorded session", async () => {
    const res = makeRes();
    getStripeClient.mockReturnValue({
      checkout: { sessions: { retrieve: jest.fn() } },
    });

    await BillingController.confirmCheckoutSession(
      makeRequest({
        subscription: {
          _id: "local-sub",
          business: "biz-1",
          stripeCustomerId: "cus_local",
          checkoutSessionId: "cs_expected",
        },
        body: { sessionId: "cs_different" },
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
  });

  test("fails closed when Stripe checkout retrieval is unavailable", async () => {
    const res = makeRes();
    getStripeClient.mockReturnValue({});

    await BillingController.confirmCheckoutSession(makeRequest(), res);

    expect(res.status).toHaveBeenCalledWith(503);
  });

  test("maps Stripe resource_missing checkout lookups to not found", async () => {
    const res = makeRes();
    getStripeClient.mockReturnValue({
      checkout: {
        sessions: {
          retrieve: jest
            .fn()
            .mockRejectedValue(Object.assign(new Error("missing"), { code: "resource_missing" })),
        },
      },
    });

    await BillingController.confirmCheckoutSession(makeRequest(), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test("rejects a remotely retrieved checkout owned by another business", async () => {
    const res = makeRes();
    getStripeClient.mockReturnValue({
      checkout: {
        sessions: {
          retrieve: jest.fn().mockResolvedValue(
            makeCheckout({
              metadata: { businessId: "biz-other", ownerId: "owner-1" },
            }),
          ),
        },
      },
    });

    await BillingController.confirmCheckoutSession(makeRequest(), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(syncCheckoutSession).not.toHaveBeenCalled();
  });

  test.each([
    ["payment", "complete", "sub_remote", 400],
    ["subscription", "open", "sub_remote", 409],
    ["subscription", "complete", null, 409],
  ])(
    "rejects unusable checkout state mode=%s status=%s subscription=%s",
    async (mode, status, subscription, expectedStatus) => {
      const res = makeRes();
      getStripeClient.mockReturnValue({
        checkout: {
          sessions: {
            retrieve: jest
              .fn()
              .mockResolvedValue(makeCheckout({ mode, status, subscription })),
          },
        },
      });

      await BillingController.confirmCheckoutSession(makeRequest(), res);

      expect(res.status).toHaveBeenCalledWith(expectedStatus);
      expect(syncCheckoutSession).not.toHaveBeenCalled();
    },
  );

  test("returns conflict when Stripe checkout is complete but reconciliation is still pending", async () => {
    const res = makeRes();
    getStripeClient.mockReturnValue({
      checkout: {
        sessions: { retrieve: jest.fn().mockResolvedValue(makeCheckout()) },
      },
    });
    syncCheckoutSession.mockResolvedValue(null);

    await BillingController.confirmCheckoutSession(makeRequest(), res);

    expect(syncCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cs_remote", subscription: "sub_remote" }),
    );
    expect(res.status).toHaveBeenCalledWith(409);
  });

  test("fails closed when webhook secret is not configured", async () => {
    const res = makeRes();

    await BillingController.handleStripeWebhook(
      { headers: { "stripe-signature": "sig" }, body: Buffer.from("{}") },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(503);
  });

  test("rejects webhook requests without a Stripe signature", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    const res = makeRes();
    getStripeClient.mockReturnValue({
      webhooks: { constructEvent: jest.fn() },
    });

    await BillingController.handleStripeWebhook({ headers: {}, body: Buffer.from("{}") }, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("rejects webhook payloads that fail Stripe signature verification", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    const res = makeRes();
    getStripeClient.mockReturnValue({
      webhooks: {
        constructEvent: jest.fn(() => {
          throw new Error("bad signature");
        }),
      },
    });

    await BillingController.handleStripeWebhook(
      { headers: { "stripe-signature": "sig" }, body: Buffer.from("{}") },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("invoice handlers ignore events that do not reference a subscription", async () => {
    await expect(
      BillingController.handleInvoicePaid({ id: "in_paid", subscription: null }),
    ).resolves.toBeNull();
    await expect(
      BillingController.handleInvoicePaymentFailed({ id: "in_failed", subscription: null }),
    ).resolves.toBeNull();

    expect(guardInvoiceAgainstCanonicalSubscription).not.toHaveBeenCalled();
    expect(syncStripeSubscription).not.toHaveBeenCalled();
  });

  test("invoice handlers stop before syncing a noncanonical subscription", async () => {
    guardInvoiceAgainstCanonicalSubscription.mockResolvedValue({
      allowed: false,
      reason: "noncanonical_subscription",
    });

    await expect(
      BillingController.handleInvoicePaid({
        id: "in_paid",
        subscription: "sub_noncanonical",
        customer: "cus_local",
      }),
    ).resolves.toBeNull();

    expect(guardInvoiceAgainstCanonicalSubscription).toHaveBeenCalled();
    expect(syncStripeSubscription).not.toHaveBeenCalled();
  });

  test("keeps request-scoped business lookup isolated from unrelated owners", async () => {
    db.getBusinessByOwner.mockResolvedValue(null);
    const res = makeRes();

    await BillingController.getMySubscription(
      { user: { userId: "owner-without-business" } },
      res,
    );

    expect(db.getBusinessByOwner).toHaveBeenCalledWith(
      Business,
      "owner-without-business",
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(Business.findById).not.toHaveBeenCalled();
  });
});
