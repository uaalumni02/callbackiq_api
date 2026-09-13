import request from "supertest";

import app from "../../src/app.js";
import Subscription from "../../src/models/subscription.js";
import { getStripeClient } from "../../src/helpers/stripe/stripeClient.js";
import { syncCheckoutSession } from "../../src/services/trialLifecycle.service.js";
import { connectTestDB, clearTestDB, closeTestDB } from "../setup/testDb.js";

jest.mock("../../src/helpers/stripe/stripeClient.js", () => ({
  getStripeClient: jest.fn(),
  getPriceIdByPlan: jest.fn(() => "price_pro_test"),
}));

jest.mock("../../src/services/trialLifecycle.service.js", () => {
  const actual = jest.requireActual(
    "../../src/services/trialLifecycle.service.js",
  );

  return {
    ...actual,
    syncCheckoutSession: jest.fn(),
  };
});

const registerCustomer = async () => {
  const response = await request(app).post("/api/auth/register").send({
    userName: "reconcileowner",
    email: "reconcile@callbackiq.com",
    password: "Password123",
    businessName: "Reconcile Plumbing",
    businessPhone: "4045550199",
    businessType: "plumbing",
    smsConsent: true,
    termsAccepted: true,
    privacyAccepted: true,
  });

  expect(response.status).toBe(201);

  return {
    token: response.body.data.token,
    user: response.body.data.user,
    business: response.body.data.business,
  };
};

const makeStripe = () => {
  const stripe = {
    checkout: {
      sessions: {
        retrieve: jest.fn(),
      },
    },
  };

  getStripeClient.mockReturnValue(stripe);
  return stripe;
};

const putCheckoutInProgress = async ({ business, sessionId = "cs_test_123" }) =>
  Subscription.findOneAndUpdate(
    { business: business._id },
    {
      $set: {
        status: "incomplete",
        checkoutSessionId: sessionId,
        stripeCustomerId: "cus_test_123",
        lastPaymentStatus: "trial_checkout_started",
        isActive: false,
        aiEnabled: false,
      },
    },
    { returnDocument: "after", runValidators: true },
  );

beforeAll(async () => {
  await connectTestDB();
}, 60_000);

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(async () => {
  await clearTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

describe("billing checkout confirmation and access routes", () => {
  test("POST /api/billing/confirm-checkout rejects unauthenticated requests", async () => {
    const response = await request(app)
      .post("/api/billing/confirm-checkout")
      .send({ sessionId: "cs_test_123" });

    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
  });

  test("GET /api/billing/access returns the lightweight entitlement state", async () => {
    const { token } = await registerCustomer();

    const response = await request(app)
      .get("/api/billing/access")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toEqual(
      expect.objectContaining({
        status: "none",
        accessLevel: "read_only",
        reason: "inactive_none",
      }),
    );
  });

  test("rejects a Checkout session ID that is not the one stored for the business", async () => {
    const stripe = makeStripe();
    const customer = await registerCustomer();
    await putCheckoutInProgress({
      business: customer.business,
      sessionId: "cs_test_expected",
    });

    const response = await request(app)
      .post("/api/billing/confirm-checkout")
      .set("Authorization", `Bearer ${customer.token}`)
      .send({ sessionId: "cs_test_other" });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("CHECKOUT_SESSION_MISMATCH");
    expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
    expect(syncCheckoutSession).not.toHaveBeenCalled();
  });

  test("rejects a Stripe session whose metadata does not belong to the authenticated business", async () => {
    const stripe = makeStripe();
    const customer = await registerCustomer();
    await putCheckoutInProgress({ business: customer.business });

    stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_test_123",
      mode: "subscription",
      status: "complete",
      customer: "cus_test_123",
      subscription: "sub_test_123",
      metadata: {
        businessId: "another_business",
        ownerId: String(customer.user._id),
        plan: "pro",
      },
    });

    const response = await request(app)
      .post("/api/billing/confirm-checkout")
      .set("Authorization", `Bearer ${customer.token}`)
      .send({ sessionId: "cs_test_123" });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("CHECKOUT_SESSION_OWNERSHIP_MISMATCH");
    expect(syncCheckoutSession).not.toHaveBeenCalled();
  });

  test("retrieves, verifies, and reconciles the authenticated business Checkout session", async () => {
    const stripe = makeStripe();
    const customer = await registerCustomer();
    await putCheckoutInProgress({ business: customer.business });

    const checkoutSession = {
      id: "cs_test_123",
      mode: "subscription",
      status: "complete",
      customer: "cus_test_123",
      subscription: "sub_test_123",
      metadata: {
        businessId: String(customer.business._id),
        ownerId: String(customer.user._id),
        plan: "pro",
        trialRequested: "true",
      },
    };
    stripe.checkout.sessions.retrieve.mockResolvedValue(checkoutSession);

    const trialStartedAt = new Date();
    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    syncCheckoutSession.mockImplementation(async () =>
      Subscription.findOneAndUpdate(
        { business: customer.business._id },
        {
          $set: {
            status: "trialing",
            checkoutSessionId: "cs_test_123",
            stripeCustomerId: "cus_test_123",
            stripeSubscriptionId: "sub_test_123",
            lastPaymentStatus: "trialing",
            trialStartedAt,
            trialEndsAt,
            trialUsedAt: trialStartedAt,
            trialCount: 1,
            currentPeriodStart: trialStartedAt,
            currentPeriodEnd: trialEndsAt,
            priceMonthly: 99,
            isActive: true,
            aiEnabled: true,
          },
        },
        { returnDocument: "after", runValidators: true },
      ),
    );

    const response = await request(app)
      .post("/api/billing/confirm-checkout")
      .set("Authorization", `Bearer ${customer.token}`)
      .send({ sessionId: "cs_test_123" });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toEqual(
      expect.objectContaining({
        checkoutSessionId: "cs_test_123",
        status: "trialing",
        accessLevel: "full",
      }),
    );
    expect(stripe.checkout.sessions.retrieve).toHaveBeenCalledWith(
      "cs_test_123",
    );
    expect(syncCheckoutSession).toHaveBeenCalledWith(checkoutSession);
  });
});
