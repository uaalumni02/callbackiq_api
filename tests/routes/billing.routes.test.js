import request from "supertest";

import app from "../../src/app.js";
import Subscription from "../../src/models/subscription.js";
import User from "../../src/models/user.js";
import TrialRedemption from "../../src/models/trialRedemption.js";
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

  // Trial uniqueness is enforced by unique indexes, not application logic.
  // Without an explicit build, the duplicate-trial tests would pass for the
  // wrong reason: the in-memory collection would simply accept both writes.
  await TrialRedemption.init();
});

beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID = "bpc_test_restricted";
});

afterEach(async () => {
  jest.clearAllMocks();
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID;
  await clearTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

const mockStripe = () => {
  const stripe = {
    customers: {
      update: jest.fn().mockResolvedValue({ id: "cus_test_123" }),
      search: jest.fn().mockResolvedValue({ data: [] }),
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

    setupIntents: {
      retrieve: jest.fn().mockResolvedValue({ id: "seti_test_123", payment_method: "pm_test_123" }),
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
      list: jest.fn().mockResolvedValue({ data: [] }),
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
      constructEvent: jest.fn((payload) => {
        if (Buffer.isBuffer(payload)) {
          return JSON.parse(payload.toString("utf8"));
        }
        if (typeof payload === "string") {
          return JSON.parse(payload);
        }
        return payload;
      }),
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
    businessName,
    businessPhone,
    businessType,
    smsConsent: true,
    termsAccepted: true,
    privacyAccepted: true,
  });

  expect(registerRes.status).toBe(201);
  expect(registerRes.body.success).toBe(true);
  expect(registerRes.body.data).toBeDefined();

  let token = registerRes.body.data.token;
  let user = registerRes.body.data.user;

  if (role === "admin") {
    const updatedUser = await User.findOneAndUpdate(
      { email },
      { $set: { role: "admin" } },
      { returnDocument: "after", runValidators: true },
    );

    expect(updatedUser).toBeTruthy();
    expect(updatedUser.role).toBe("admin");

    /*
     * Registration correctly issues an owner JWT. After promoting this
     * test-only fixture, log in again so authorization is exercised with a
     * freshly signed token containing the stored admin role.
     */
    const loginRes = await request(app).post("/api/auth/login").send({
      login: email,
      password: "Password123",
    });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.success).toBe(true);
    expect(loginRes.body.data?.user?.role).toBe("admin");

    token = loginRes.body.data.token;
    user = loginRes.body.data.user;
  }

  return {
    token,
    user,
    userId: user._id,
    business: registerRes.body.data.business,
    subscription: registerRes.body.data.subscription,
  };
};

/*
 * Clears every trace of a granted trial.
 *
 * Deleting the Subscription alone is no longer enough: a TrialRedemption row
 * survives independently and would block the next trial at the index level.
 */
const resetTrialState = async (businessId) => {
  await Subscription.deleteMany({ business: businessId });
  await TrialRedemption.deleteMany({ business: businessId });
};

/*
 * Ages a trial out without touching trialUsedAt, mirroring what
 * expireTrialIfNeeded does on the next authenticated read.
 */
const expireTrialInPlace = async (businessId) => {
  return await Subscription.findOneAndUpdate(
    { business: businessId },
    {
      status: "expired",
      lastPaymentStatus: "trial_expired",
      isActive: false,
      aiEnabled: false,
      trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      currentPeriodEnd: new Date(Date.now() - 24 * 60 * 60 * 1000),
    },
    { returnDocument: "after" },
  );
};

const startTrial = async (token, body = undefined) => {
  const trialRequest = request(app)
    .post("/api/billing/free-trial")
    .set("Authorization", `Bearer ${token}`);
  return body === undefined ? trialRequest : trialRequest.send(body);
};

const markTrialSpent = async ({
  business,
  user,
  status = "expired",
  trialEndsAt = new Date(Date.now() - 24 * 60 * 60 * 1000),
}) => {
  const now = new Date();
  const trialStartedAt = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const active = status === "trialing" || status === "active";

  await TrialRedemption.findOneAndUpdate(
    { business: business._id },
    {
      business: business._id,
      owner: user._id,
      emailKey: String(user.email || "").trim().toLowerCase(),
      phoneKey: business.forwardingPhone || "",
      stripeSubscriptionId: "sub_trial_used",
      grantedBy: "self",
      redeemedAt: now,
    },
    {
      upsert: true,
      returnDocument: "after",
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  );

  return Subscription.findOneAndUpdate(
    { business: business._id },
    {
      business: business._id,
      plan: "pro",
      status,
      stripeCustomerId: "cus_test_123",
      stripeSubscriptionId: "sub_trial_used",
      lastPaymentStatus: status === "trialing" ? "trialing" : status,
      trialStartedAt,
      trialEndsAt,
      trialUsedAt: now,
      trialCount: 1,
      currentPeriodStart: trialStartedAt,
      currentPeriodEnd: trialEndsAt,
      isActive: active,
      aiEnabled: active,
      priceMonthly: 199,
    },
    {
      upsert: true,
      returnDocument: "after",
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  );
};

const mockStripeTrialForExtension = ({
  stripe,
  business,
  subscription,
}) => {
  const trialStart = Math.floor(
    new Date(subscription.trialStartedAt).getTime() / 1000,
  );
  const trialEnd = Math.floor(
    new Date(subscription.trialEndsAt).getTime() / 1000,
  );

  const baseStripeTrial = {
    id: "sub_trial_used",
    customer: "cus_test_123",
    status: "trialing",
    current_period_start: trialStart,
    current_period_end: trialEnd,
    trial_start: trialStart,
    trial_end: trialEnd,
    cancel_at_period_end: false,
    metadata: {
      businessId: String(business._id),
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
  };

  stripe.subscriptions.retrieve.mockResolvedValue(baseStripeTrial);
  stripe.subscriptions.update.mockImplementation(
    async (stripeSubscriptionId, update = {}) => {
      const nextTrialEnd = Number(update.trial_end || trialEnd);

      return {
        ...baseStripeTrial,
        id: stripeSubscriptionId || baseStripeTrial.id,
        trial_end: nextTrialEnd,
        current_period_end: nextTrialEnd,
      };
    },
  );
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
        metadata: expect.objectContaining({
          businessId: String(business._id),
          plan: "pro",
          trialRequested: "false",
        }),
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(":pro:paid"),
      }),
    );

    /*
     * Opening paid checkout is not entitlement. Access becomes active only
     * after a signed Stripe webhook confirms the subscription.
     */
    const subscription = await Subscription.findOne({
      business: business._id,
    });

    expect(subscription).toBeTruthy();
    expect(subscription.plan).toBe("pro");
    expect(subscription.status).toBe("incomplete");
    expect(subscription.isActive).toBe(false);
    expect(subscription.stripeCustomerId).toBe("cus_test_123");
    expect(subscription.checkoutSessionId).toBe("cs_test_123");
  });

  test("POST /api/billing/create-checkout-session does not consume the free trial", async () => {
    mockStripe();

    const { token, business } = await registerAndCreateBusiness();

    await resetTrialState(business._id);

    await request(app)
      .post("/api/billing/create-checkout-session")
      .set("Authorization", `Bearer ${token}`)
      .send({
        plan: "pro",
      });

    // Opening checkout is not a trial grant. Abandoning it must not cost the
    // customer their one lifetime trial.
    const redemptions = await TrialRedemption.countDocuments({
      business: business._id,
    });

    expect(redemptions).toBe(0);

    const subscription = await Subscription.findOne({
      business: business._id,
    });

    expect(subscription.trialUsedAt).toBeFalsy();
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

  test("POST /api/billing/free-trial creates a 14-day Stripe trial checkout without granting early access", async () => {
    const stripe = mockStripe();
    const { token, business } = await registerAndCreateBusiness();

    await resetTrialState(business._id);

    const res = await startTrial(token);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.trialOffered).toBe(true);
    expect(res.body.data.checkoutUrl).toBe(
      "https://checkout.stripe.com/test-session",
    );

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        metadata: expect.objectContaining({
          businessId: String(business._id),
          plan: "pro",
          trialRequested: "true",
        }),
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(":pro:trial"),
      }),
    );

    const subscription = await Subscription.findOne({
      business: business._id,
    });

    expect(subscription).toBeTruthy();
    expect(subscription.plan).toBe("pro");
    expect(subscription.status).toBe("incomplete");
    expect(subscription.lastPaymentStatus).toBe("trial_checkout_started");
    expect(subscription.isActive).toBe(false);
    expect(subscription.aiEnabled).toBe(false);
    expect(subscription.priceMonthly).toBe(199);
    expect(subscription.trialStartedAt).toBeFalsy();
    expect(subscription.trialEndsAt).toBeFalsy();
    expect(subscription.trialUsedAt).toBeFalsy();
    expect(subscription.trialCount).toBe(0);
  });

  test("POST /api/billing/free-trial uses setup-specific Stripe return URLs when onboarding requests them", async () => {
    const stripe = mockStripe();
    const { token, business } = await registerAndCreateBusiness();

    await resetTrialState(business._id);

    const res = await startTrial(token, { onboarding: true });
    expect(res.status).toBe(200);
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        success_url: expect.stringContaining(
          "/trial/activate/success?session_id={CHECKOUT_SESSION_ID}",
        ),
        cancel_url: expect.stringContaining(
          "/setup?step=activate&trial=cancelled",
        ),
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(":pro:trial"),
      }),
    );
  });

  test("POST /api/billing/free-trial does not consume lifetime trial usage before Stripe confirms it", async () => {
    mockStripe();

    const { token, business } = await registerAndCreateBusiness();

    await resetTrialState(business._id);

    const res = await startTrial(token);
    expect(res.status).toBe(200);

    const subscription = await Subscription.findOne({
      business: business._id,
    });

    expect(subscription.trialUsedAt).toBeFalsy();
    expect(subscription.trialCount).toBe(0);

    const redemption = await TrialRedemption.findOne({
      business: business._id,
    });

    expect(redemption).toBeNull();
  });

  test("POST /api/billing/free-trial rejects duplicate active trial", async () => {
    mockStripe();
    const customer = await registerAndCreateBusiness();

    await resetTrialState(customer.business._id);
    await markTrialSpent({
      business: customer.business,
      user: customer.user,
      status: "trialing",
      trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    const res = await startTrial(customer.token);

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/billing/free-trial rejects a second trial after the first expired", async () => {
    mockStripe();
    const customer = await registerAndCreateBusiness();

    await resetTrialState(customer.business._id);
    await markTrialSpent({
      business: customer.business,
      user: customer.user,
      status: "expired",
    });

    const second = await startTrial(customer.token);

    expect(second.status).toBe(409);
    expect(second.body.success).toBe(false);

    const subscription = await Subscription.findOne({
      business: customer.business._id,
    });

    expect(subscription.status).toBe("expired");
    expect(subscription.trialCount).toBe(1);
    expect(subscription.trialUsedAt).toBeTruthy();
    expect(subscription.isActive).toBe(false);
  });

  test("POST /api/billing/free-trial rejects a second trial after cancellation", async () => {
    mockStripe();
    const customer = await registerAndCreateBusiness();

    await resetTrialState(customer.business._id);
    await markTrialSpent({
      business: customer.business,
      user: customer.user,
      status: "canceled",
    });

    const res = await startTrial(customer.token);

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/billing/free-trial uses one Stripe idempotency key under concurrent requests", async () => {
    const stripe = mockStripe();
    const { token, business } = await registerAndCreateBusiness();

    await resetTrialState(business._id);

    const results = await Promise.all([startTrial(token), startTrial(token)]);

    expect(results.every((res) => res.status === 200)).toBe(true);

    /*
     * Checkout creation itself does not consume the lifetime trial. Stripe
     * receives the same deterministic key so concurrent requests collapse to
     * the same operation at the payment-provider boundary.
     */
    const keys = stripe.checkout.sessions.create.mock.calls.map(
      ([, options]) => options?.idempotencyKey,
    );

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(new Set(keys).size).toBe(1);

    const redemptions = await TrialRedemption.countDocuments({
      business: business._id,
    });

    expect(redemptions).toBe(0);

    const subscription = await Subscription.findOne({
      business: business._id,
    });

    expect(subscription.status).toBe("incomplete");
    expect(subscription.trialCount).toBe(0);
    expect(subscription.trialUsedAt).toBeFalsy();
  });

  test("registration blocks a second business from reusing the same forwarding phone", async () => {
    const first = await registerAndCreateBusiness({
      userName: "firstowner",
      email: "first@callbackiq.com",
      businessName: "Atlanta Pro Plumbing",
      businessPhone: "4045551234",
    });

    expect(first.token).toBeTruthy();
    expect(first.business.phone).toBeUndefined();
    expect(first.business.forwardingPhone).toBe("+14045551234");
    expect(first.business.trackingNumber.status).toBe("unassigned");

    const duplicateRegistration = await request(app)
      .post("/api/auth/register")
      .send({
        userName: "secondowner",
        email: "second@callbackiq.com",
        password: "Password123",
        role: "owner",
        businessName: "Atlanta Pro Plumbing Two",
        businessPhone: "4045551234",
        businessType: "plumbing",
        smsConsent: true,
        termsAccepted: true,
        privacyAccepted: true,
      });

    expect(duplicateRegistration.status).toBe(409);
    expect(duplicateRegistration.body.success).toBe(false);

    /*
     * Registration never consumes a trial. Rejecting the duplicate forwarding
     * phone therefore leaves the lifetime-redemption ledger untouched.
     */
    const redemptions = await TrialRedemption.countDocuments({
      phoneKey: "+14045551234",
    });

    expect(redemptions).toBe(0);
  });

  test("POST /api/billing/free-trial allows an unrelated second business", async () => {
    const first = await registerAndCreateBusiness();

    await resetTrialState(first.business._id);
    await startTrial(first.token);

    const second = await registerAndCreateBusiness({
      userName: "unrelatedowner",
      email: "unrelated@callbackiq.com",
      businessName: "Marietta Roofing",
      businessPhone: "7705559876",
    });

    await resetTrialState(second.business._id);

    const res = await startTrial(second.token);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("GET /api/billing/subscription returns default none subscription if missing", async () => {
    const { token, business } = await registerAndCreateBusiness();

    await resetTrialState(business._id);

    const res = await request(app)
      .get("/api/billing/subscription")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("none");
    expect(res.body.data.canStartTrial).toBe(true);
  });

  test("GET /api/billing/subscription reports canStartTrial false once the trial is spent", async () => {
    const customer = await registerAndCreateBusiness();

    await resetTrialState(customer.business._id);
    await markTrialSpent({
      business: customer.business,
      user: customer.user,
      status: "trialing",
      trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    const duringTrial = await request(app)
      .get("/api/billing/subscription")
      .set("Authorization", `Bearer ${customer.token}`);

    expect(duringTrial.status).toBe(200);
    expect(duringTrial.body.data.canStartTrial).toBe(false);

    await Subscription.findOneAndUpdate(
      { business: customer.business._id },
      {
        $set: {
          trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
          currentPeriodEnd: new Date(Date.now() - 24 * 60 * 60 * 1000),
        },
      },
    );

    const afterExpiry = await request(app)
      .get("/api/billing/subscription")
      .set("Authorization", `Bearer ${customer.token}`);

    expect(afterExpiry.status).toBe(200);
    expect(afterExpiry.body.data.status).toBe("expired");
    expect(afterExpiry.body.data.canStartTrial).toBe(false);
    expect(afterExpiry.body.data.trialUsedAt).toBeTruthy();
  });

  test("GET /api/billing/subscription returns existing subscription", async () => {
    mockStripe();
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
    expect(res.body.data.canStartTrial).toBe(false);
  });

  test("GET /api/billing/subscription returns active trial", async () => {
    const customer = await registerAndCreateBusiness();

    await resetTrialState(customer.business._id);
    await markTrialSpent({
      business: customer.business,
      user: customer.user,
      status: "trialing",
      trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    const res = await request(app)
      .get("/api/billing/subscription")
      .set("Authorization", `Bearer ${customer.token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.plan).toBe("pro");
    expect(res.body.data.status).toBe("trialing");
    expect(res.body.data.isActive).toBe(true);
    expect(res.body.data.aiEnabled).toBe(true);
    expect(res.body.data.trialEndsAt).toBeTruthy();
    expect(res.body.data.canStartTrial).toBe(false);
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

  test("GET /api/billing/subscription expiry does not clear lifetime trial usage", async () => {
    const customer = await registerAndCreateBusiness();

    await resetTrialState(customer.business._id);
    await markTrialSpent({
      business: customer.business,
      user: customer.user,
      status: "trialing",
      trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    const res = await request(app)
      .get("/api/billing/subscription")
      .set("Authorization", `Bearer ${customer.token}`);

    expect(res.status).toBe(200);

    const subscription = await Subscription.findOne({
      business: customer.business._id,
    });

    expect(subscription.status).toBe("expired");
    expect(subscription.trialUsedAt).toBeTruthy();
    expect(subscription.trialCount).toBe(1);

    const redemption = await TrialRedemption.findOne({
      business: customer.business._id,
    });
    expect(redemption).toBeTruthy();
  });

  test("POST /api/billing/customers/:businessId/trial-override requires admin", async () => {
    const { token, business } = await registerAndCreateBusiness();

    const res = await request(app)
      .post(`/api/billing/customers/${business._id}/trial-override`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/billing/customers/:businessId/trial-override extends an active trial", async () => {
    const stripe = mockStripe();
    const customer = await registerAndCreateBusiness();

    await resetTrialState(customer.business._id);
    const before = await markTrialSpent({
      business: customer.business,
      user: customer.user,
      status: "trialing",
      trialEndsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    });

    mockStripeTrialForExtension({
      stripe,
      business: customer.business,
      subscription: before,
    });

    const admin = await registerAndCreateBusiness({
      userName: "platformadmin",
      email: "admin@callbackiq.com",
      role: "admin",
      businessName: "CallBackIQ Internal",
      businessPhone: "6785554321",
    });

    const extension = await request(app)
      .post(`/api/billing/customers/${customer.business._id}/trial-override`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({
        days: 7,
        reason: "Customer success extension",
      });

    expect(extension.status).toBe(200);
    expect(extension.body.success).toBe(true);

    const subscription = await Subscription.findOne({
      business: customer.business._id,
    });

    expect(subscription.status).toBe("trialing");
    expect(subscription.trialCount).toBe(1);
    expect(subscription.trialUsedAt).toBeTruthy();
    expect(new Date(subscription.trialEndsAt).getTime()).toBeGreaterThan(
      new Date(before.trialEndsAt).getTime(),
    );
  });

  test("trial extension preserves the lifetime trial identity lock", async () => {
    const stripe = mockStripe();
    const customer = await registerAndCreateBusiness();

    await resetTrialState(customer.business._id);
    const activeTrial = await markTrialSpent({
      business: customer.business,
      user: customer.user,
      status: "trialing",
      trialEndsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    });

    mockStripeTrialForExtension({
      stripe,
      business: customer.business,
      subscription: activeTrial,
    });

    const admin = await registerAndCreateBusiness({
      userName: "platformadmin",
      email: "admin@callbackiq.com",
      role: "admin",
      businessName: "CallBackIQ Internal",
      businessPhone: "6785554321",
    });

    const before = await TrialRedemption.findOne({
      business: customer.business._id,
    });

    const extension = await request(app)
      .post(`/api/billing/customers/${customer.business._id}/trial-override`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({
        days: 7,
        reason: "Support extension",
      });

    expect(extension.status).toBe(200);

    const after = await TrialRedemption.findOne({
      business: customer.business._id,
    });

    expect(after).toBeTruthy();
    expect(String(after._id)).toBe(String(before._id));

    const redemptions = await TrialRedemption.countDocuments({
      business: customer.business._id,
    });
    expect(redemptions).toBe(1);
  });

  test("registration preserves lifetime trial eligibility without consuming it", async () => {
    const { business, subscription } = await registerAndCreateBusiness();

    expect(subscription?.status).toBe("none");
    expect(subscription?.trialUsedAt).toBeFalsy();
    expect(subscription?.trialCount).toBe(0);

    const stored = await Subscription.findOne({
      business: business._id,
    });

    expect(stored).toBeTruthy();
    expect(stored.status).toBe("none");
    expect(stored.trialUsedAt).toBeFalsy();
    expect(stored.trialCount).toBe(0);

    const redemption = await TrialRedemption.findOne({
      business: business._id,
    });

    expect(redemption).toBeNull();
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
      .set("stripe-signature", "test_signature")
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

  test("POST /api/billing/webhook marks a Stripe-side trial as used", async () => {
    const stripe = mockStripe();

    const { business } = await registerAndCreateBusiness();

    await resetTrialState(business._id);

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

    await request(app)
      .post("/api/billing/webhook")
      .set("stripe-signature", "test_signature")
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

    // A trial configured on the Stripe price is still a free trial.
    const subscription = await Subscription.findOne({
      business: business._id,
    });

    expect(subscription.trialUsedAt).toBeTruthy();
    expect(subscription.trialCount).toBe(1);
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
      .set("stripe-signature", "test_signature")
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
    const stripe = mockStripe();

    const { business } = await registerAndCreateBusiness();

    stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: "sub_test_123",
      customer: "cus_test_123",
      status: "past_due",
      current_period_start: 1710000000,
      current_period_end: 1712592000,
      trial_start: null,
      trial_end: null,
      cancel_at_period_end: false,
      metadata: {
        businessId: String(business._id),
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
        id: "in_test_failed",
      },
    });

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
      .set("stripe-signature", "test_signature")
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
