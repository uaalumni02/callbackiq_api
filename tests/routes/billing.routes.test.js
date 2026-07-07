import request from "supertest";

import app from "../../src/app.js";
import Subscription from "../../src/models/subscription.js";
import { getStripeClient } from "../../src/helpers/stripe/stripeClient.js";
import { connectTestDB, clearTestDB, closeTestDB } from "../setup/testDb.js";

jest.mock("../../src/helpers/stripe/stripeClient.js", () => ({
  getStripeClient: jest.fn(),

  getPriceIdByPlan: jest.fn((plan) => {
    const map = {
      starter: "price_starter_test",
      pro: "price_pro_test",
      agency: "price_agency_test",
    };

    return map[plan];
  }),

  formatStripeMoney: jest.fn((amount = 0, currency = "usd") => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: String(currency).toUpperCase(),
    }).format((amount || 0) / 100);
  }),
}));

beforeAll(async () => {
  process.env.CLIENT_URL = "http://localhost:3001";
  process.env.STRIPE_SECRET_KEY = "sk_test_123";
  process.env.STRIPE_STARTER_PRICE_ID = "price_starter_test";
  process.env.STRIPE_PRO_PRICE_ID = "price_pro_test";
  process.env.STRIPE_AGENCY_PRICE_ID = "price_agency_test";

  await connectTestDB();
});

afterEach(async () => {
  jest.clearAllMocks();
  delete process.env.STRIPE_WEBHOOK_SECRET;
  await clearTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

const mockStripe = () => {
  const stripe = {
    customers: {
      create: jest.fn().mockResolvedValue({
        id: "cus_test_123",
      }),
    },

    paymentMethods: {
      list: jest.fn().mockResolvedValue({
        data: [
          {
            id: "pm_test_123",
            card: {
              brand: "visa",
              last4: "4242",
              exp_month: 12,
              exp_year: 2030,
            },
          },
        ],
      }),
    },

    invoices: {
      list: jest.fn().mockResolvedValue({
        data: [
          {
            id: "in_test_123",
            number: "INV-001",
            status: "paid",
            amount_due: 19900,
            amount_paid: 19900,
            currency: "usd",
            hosted_invoice_url: "https://invoice.stripe.com/test",
            invoice_pdf: "https://invoice.stripe.com/test.pdf",
            created: 1710000000,
            period_start: 1710000000,
            period_end: 1712592000,
          },
        ],
      }),

      retrieveUpcoming: jest.fn().mockResolvedValue({
        amount_due: 19900,
        currency: "usd",
        next_payment_attempt: 1712592000,
      }),
    },

    billingPortal: {
      sessions: {
        create: jest.fn().mockResolvedValue({
          id: "bps_test_123",
          url: "https://billing.stripe.com/session/test",
        }),
      },
    },

    checkout: {
      sessions: {
        create: jest.fn().mockResolvedValue({
          id: "cs_test_123",
          url: "https://checkout.stripe.com/test-session",
        }),
      },
    },

    subscriptions: {
      retrieve: jest.fn().mockResolvedValue({
        id: "sub_test_123",
        customer: "cus_test_123",
        status: "active",
        current_period_start: 1710000000,
        current_period_end: 1712592000,
        trial_start: null,
        trial_end: null,
        cancel_at_period_end: false,
        metadata: {
          businessId: "mock_business_id",
          plan: "agency",
        },
        items: {
          data: [
            {
              price: {
                id: "price_agency_test",
              },
            },
          ],
        },
        latest_invoice: {
          id: "in_test_123",
        },
      }),

      update: jest.fn().mockResolvedValue({
        id: "sub_test_123",
        status: "active",
        current_period_start: 1710000000,
        current_period_end: 1712592000,
        cancel_at_period_end: true,
      }),
    },

    webhooks: {
      constructEvent: jest.fn(),
    },
  };

  getStripeClient.mockReturnValue(stripe);

  return stripe;
};

const registerAndCreateBusiness = async ({
  userName = "demoowner",
  email = "owner@callbackiq.com",
  role = "owner",
  businessName = "Atlanta Pro Plumbing",
  businessPhone = "4045551234",
  businessType = "plumbing",
} = {}) => {
  const registerRes = await request(app).post("/api/auth/register").send({
    userName,
    email,
    password: "Password123",
    role,
    businessName,
    businessPhone,
    businessType,
    smsConsent: true,
    termsAccepted: true,
    privacyAccepted: true,
  });

  return {
    token: registerRes.body.data.token,
    business: registerRes.body.data.business,
    subscription: registerRes.body.data.subscription,
  };
};

const deleteAutoTrial = async (businessId) => {
  await Subscription.deleteMany({ business: businessId });
};

describe("Billing Routes", () => {
  test("POST /api/billing/create-checkout-session rejects unauthenticated request", async () => {
    const res = await request(app)
      .post("/api/billing/create-checkout-session")
      .send({
        plan: "pro",
      });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/billing/create-checkout-session creates Stripe checkout session", async () => {
    const stripe = mockStripe();

    const { token, business } = await registerAndCreateBusiness();

    const res = await request(app)
      .post("/api/billing/create-checkout-session")
      .set("Authorization", `Bearer ${token}`)
      .send({
        plan: "pro",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.checkoutUrl).toBe(
      "https://checkout.stripe.com/test-session",
    );

    expect(stripe.customers.create).toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        customer: "cus_test_123",
        line_items: [
          {
            price: "price_pro_test",
            quantity: 1,
          },
        ],
      }),
    );

    const subscription = await Subscription.findOne({
      business: business._id,
    });

    expect(subscription).toBeTruthy();
    expect(subscription.plan).toBe("pro");
    expect(subscription.status).toBe("trialing");
    expect(subscription.lastPaymentStatus).toBe("trialing");
    expect(subscription.isActive).toBe(true);
    expect(subscription.stripeCustomerId).toBe("cus_test_123");
    expect(subscription.checkoutSessionId).toBe("cs_test_123");
  });

  test("POST /api/billing/create-checkout-session rejects invalid plan", async () => {
    mockStripe();

    const { token } = await registerAndCreateBusiness();

    const res = await request(app)
      .post("/api/billing/create-checkout-session")
      .set("Authorization", `Bearer ${token}`)
      .send({
        plan: "free",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/billing/free-trial rejects unauthenticated request", async () => {
    const res = await request(app).post("/api/billing/free-trial");

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/billing/free-trial starts a 14-day free trial", async () => {
    const { token, business } = await registerAndCreateBusiness();

    await deleteAutoTrial(business._id);

    const res = await request(app)
      .post("/api/billing/free-trial")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const subscription = await Subscription.findOne({
      business: business._id,
    });

    expect(subscription).toBeTruthy();
    expect(subscription.plan).toBe("pro");
    expect(subscription.status).toBe("trialing");
    expect(subscription.isActive).toBe(true);
    expect(subscription.aiEnabled).toBe(true);
    expect(subscription.priceMonthly).toBe(199);
    expect(subscription.trialStartedAt).toBeTruthy();
    expect(subscription.trialEndsAt).toBeTruthy();
    expect(subscription.currentPeriodStart).toBeTruthy();
    expect(subscription.currentPeriodEnd).toBeTruthy();

    const trialDays = Math.round(
      (new Date(subscription.trialEndsAt) -
        new Date(subscription.trialStartedAt)) /
        (1000 * 60 * 60 * 24),
    );

    expect(trialDays).toBe(14);
  });

  test("POST /api/billing/free-trial rejects duplicate active trial", async () => {
    const { token } = await registerAndCreateBusiness();

    const res = await request(app)
      .post("/api/billing/free-trial")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("GET /api/billing/subscription returns default none subscription if missing", async () => {
    const { token, business } = await registerAndCreateBusiness();

    await deleteAutoTrial(business._id);

    const res = await request(app)
      .get("/api/billing/subscription")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("none");
  });

  test("GET /api/billing/subscription returns existing subscription", async () => {
    const { token, business } = await registerAndCreateBusiness();

    await Subscription.findOneAndUpdate(
      { business: business._id },
      {
        business: business._id,
        stripeCustomerId: "cus_test_123",
        stripeSubscriptionId: "sub_test_123",
        plan: "pro",
        status: "active",
        isActive: true,
        aiEnabled: true,
      },
      {
        upsert: true,
        returnDocument: "after",
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    const res = await request(app)
      .get("/api/billing/subscription")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.plan).toBe("pro");
    expect(res.body.data.status).toBe("active");
  });

  test("GET /api/billing/subscription returns active trial", async () => {
    const { token } = await registerAndCreateBusiness();

    const res = await request(app)
      .get("/api/billing/subscription")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.plan).toBe("pro");
    expect(res.body.data.status).toBe("trialing");
    expect(res.body.data.isActive).toBe(true);
    expect(res.body.data.aiEnabled).toBe(true);
    expect(res.body.data.trialEndsAt).toBeTruthy();
  });

  test("GET /api/billing/subscription expires old trial", async () => {
    const { token, business } = await registerAndCreateBusiness();

    await Subscription.findOneAndUpdate(
      { business: business._id },
      {
        business: business._id,
        plan: "pro",
        status: "trialing",
        trialStartedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
        trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        currentPeriodStart: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(Date.now() - 24 * 60 * 60 * 1000),
        isActive: true,
        aiEnabled: true,
        priceMonthly: 199,
      },
      {
        upsert: true,
        returnDocument: "after",
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    const res = await request(app)
      .get("/api/billing/subscription")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const subscription = await Subscription.findOne({
      business: business._id,
    });

    expect(subscription.status).toBe("expired");
    expect(subscription.isActive).toBe(false);
    expect(subscription.aiEnabled).toBe(false);
  });

  test("POST /api/billing/cancel schedules subscription cancellation", async () => {
    const stripe = mockStripe();

    const { token, business } = await registerAndCreateBusiness();

    await Subscription.findOneAndUpdate(
      { business: business._id },
      {
        business: business._id,
        stripeCustomerId: "cus_test_123",
        stripeSubscriptionId: "sub_test_123",
        plan: "pro",
        status: "active",
        isActive: true,
        aiEnabled: true,
      },
      {
        upsert: true,
        returnDocument: "after",
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    const res = await request(app)
      .post("/api/billing/cancel")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_test_123", {
      cancel_at_period_end: true,
    });

    const subscription = await Subscription.findOne({
      business: business._id,
    });

    expect(subscription.cancelAtPeriodEnd).toBe(true);
  });

  test("POST /api/billing/cancel fails if no Stripe subscription exists", async () => {
    mockStripe();

    const { token, business } = await registerAndCreateBusiness();

    await Subscription.findOneAndUpdate(
      { business: business._id },
      {
        business: business._id,
        plan: "pro",
        status: "trialing",
        stripeCustomerId: "",
        stripeSubscriptionId: "",
        isActive: true,
        aiEnabled: true,
      },
      {
        upsert: true,
        returnDocument: "after",
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    const res = await request(app)
      .post("/api/billing/cancel")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/billing/webhook handles checkout.session.completed", async () => {
    const stripe = mockStripe();

    const { business } = await registerAndCreateBusiness();

    stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: "sub_test_123",
      customer: "cus_test_123",
      status: "trialing",
      current_period_start: 1710000000,
      current_period_end: 1711209600,
      trial_start: 1710000000,
      trial_end: 1711209600,
      cancel_at_period_end: false,
      metadata: {
        businessId: business._id,
        plan: "pro",
      },
      items: {
        data: [
          {
            price: {
              id: "price_pro_test",
            },
          },
        ],
      },
      latest_invoice: {
        id: "in_test_123",
      },
    });

    const res = await request(app)
      .post("/api/billing/webhook")
      .send({
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_completed",
            customer: "cus_test_123",
            subscription: "sub_test_123",
            metadata: {
              businessId: business._id,
              plan: "pro",
            },
          },
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);

    const subscription = await Subscription.findOne({
      business: business._id,
    });

    expect(subscription).toBeTruthy();
    expect(subscription.status).toBe("trialing");
    expect(subscription.lastPaymentStatus).toBe("trialing");
    expect(subscription.isActive).toBe(true);
    expect(subscription.plan).toBe("pro");
    expect(subscription.stripeCustomerId).toBe("cus_test_123");
    expect(subscription.stripeSubscriptionId).toBe("sub_test_123");
  });

  test("POST /api/billing/webhook handles customer.subscription.updated", async () => {
    const stripe = mockStripe();

    const { business } = await registerAndCreateBusiness();

    stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: "sub_test_123",
      customer: "cus_test_123",
      status: "active",
      current_period_start: 1710000000,
      current_period_end: 1712592000,
      trial_start: null,
      trial_end: null,
      cancel_at_period_end: false,
      metadata: {
        businessId: business._id,
        plan: "agency",
      },
      items: {
        data: [
          {
            price: {
              id: "price_agency_test",
            },
          },
        ],
      },
      latest_invoice: {
        id: "in_test_123",
      },
    });

    const res = await request(app)
      .post("/api/billing/webhook")
      .send({
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_test_123",
            customer: "cus_test_123",
            status: "active",
            current_period_start: 1710000000,
            current_period_end: 1712592000,
            cancel_at_period_end: false,
            metadata: {
              businessId: business._id,
              plan: "agency",
            },
            items: {
              data: [
                {
                  price: {
                    id: "price_agency_test",
                  },
                },
              ],
            },
          },
        },
      });

    expect(res.status).toBe(200);

    const subscription = await Subscription.findOne({
      business: business._id,
    });

    expect(subscription.plan).toBe("agency");
    expect(subscription.status).toBe("active");
    expect(subscription.stripeSubscriptionId).toBe("sub_test_123");
  });

  test("POST /api/billing/webhook handles invoice.payment_failed", async () => {
    mockStripe();

    const { business } = await registerAndCreateBusiness();

    await Subscription.findOneAndUpdate(
      { business: business._id },
      {
        business: business._id,
        stripeCustomerId: "cus_test_123",
        stripeSubscriptionId: "sub_test_123",
        plan: "pro",
        status: "active",
        isActive: true,
        aiEnabled: true,
      },
      {
        upsert: true,
        returnDocument: "after",
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    const res = await request(app)
      .post("/api/billing/webhook")
      .send({
        type: "invoice.payment_failed",
        data: {
          object: {
            id: "in_test_failed",
            subscription: "sub_test_123",
          },
        },
      });

    expect(res.status).toBe(200);

    const subscription = await Subscription.findOne({
      business: business._id,
    });

    expect(subscription.status).toBe("past_due");
    expect(subscription.lastPaymentStatus).toBe("failed");
    expect(subscription.latestInvoiceId).toBe("in_test_failed");
  });
});
