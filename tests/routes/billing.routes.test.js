import request from "supertest";

import app from "../../src/app.js";
import Subscription from "../../src/models/subscription.js";
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

  expect(registerRes.status).toBe(201);
  expect(registerRes.body.success).toBe(true);
  expect(registerRes.body.data).toBeDefined();

  return {
    token: registerRes.body.data.token,
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

const startTrial = async (token) =>
  request(app)
    .post("/api/billing/free-trial")
    .set("Authorization", `Bearer ${token}`);

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

  test("POST /api/billing/free-trial starts a 14-day free trial", async () => {
    const { token, business } = await registerAndCreateBusiness();

    await resetTrialState(business._id);

    const res = await startTrial(token);

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

  test("POST /api/billing/free-trial records lifetime trial usage", async () => {
    const { token, business } = await registerAndCreateBusiness();

    await resetTrialState(business._id);

    await startTrial(token);

    const subscription = await Subscription.findOne({
      business: business._id,
    });

    expect(subscription.trialUsedAt).toBeTruthy();
    expect(subscription.trialCount).toBe(1);
    expect(subscription.trialOverrideGrantedAt).toBeFalsy();

    const redemption = await TrialRedemption.findOne({
      business: business._id,
    });

    expect(redemption).toBeTruthy();
    expect(redemption.grantedBy).toBe("self");
    expect(redemption.emailKey).toBe("owner@callbackiq.com");
    expect(redemption.phoneKey).toBe("+14045551234");
  });

  test("POST /api/billing/free-trial rejects duplicate active trial", async () => {
    const { token } = await registerAndCreateBusiness();

    const res = await startTrial(token);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/billing/free-trial rejects a second trial after the first expired", async () => {
    const { token, business } = await registerAndCreateBusiness();

    await resetTrialState(business._id);

    const first = await startTrial(token);

    expect(first.status).toBe(200);

    await expireTrialInPlace(business._id);

    // The regression this whole feature exists for. Status is now "expired",
    // which the old eligibility check treated as trial-eligible.
    const second = await startTrial(token);

    expect(second.status).toBe(400);
    expect(second.body.success).toBe(false);

    const subscription = await Subscription.findOne({
      business: business._id,
    });

    expect(subscription.status).toBe("expired");
    expect(subscription.trialCount).toBe(1);
    expect(subscription.isActive).toBe(false);
  });

  test("POST /api/billing/free-trial rejects a second trial after cancellation", async () => {
    const { token, business } = await registerAndCreateBusiness();

    await resetTrialState(business._id);

    await startTrial(token);

    await Subscription.findOneAndUpdate(
      { business: business._id },
      {
        status: "canceled",
        lastPaymentStatus: "canceled",
        isActive: false,
        aiEnabled: false,
      },
    );

    const res = await startTrial(token);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/billing/free-trial is idempotent under concurrent requests", async () => {
    const { token, business } = await registerAndCreateBusiness();

    await resetTrialState(business._id);

    // Two in-flight requests both pass the "already trialed?" read before
    // either writes. Only the unique index can settle this.
    const results = await Promise.all([startTrial(token), startTrial(token)]);

    const accepted = results.filter((res) => res.status === 200);

    expect(accepted).toHaveLength(1);

    const redemptions = await TrialRedemption.countDocuments({
      business: business._id,
    });

    expect(redemptions).toBe(1);

    const subscription = await Subscription.findOne({
      business: business._id,
    });

    expect(subscription.trialCount).toBe(1);
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
     * The rejected registration must not create another trial redemption for
     * the same tracking phone.
     */
    const redemptions = await TrialRedemption.countDocuments({
      phoneKey: "+14045551234",
    });

    expect(redemptions).toBe(1);
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
    const { token, business } = await registerAndCreateBusiness();

    await resetTrialState(business._id);
    await startTrial(token);

    const duringTrial = await request(app)
      .get("/api/billing/subscription")
      .set("Authorization", `Bearer ${token}`);

    // Access is active, so the CTA must be hidden even before expiry.
    expect(duringTrial.body.data.canStartTrial).toBe(false);

    await expireTrialInPlace(business._id);

    const afterExpiry = await request(app)
      .get("/api/billing/subscription")
      .set("Authorization", `Bearer ${token}`);

    expect(afterExpiry.body.data.status).toBe("expired");
    expect(afterExpiry.body.data.canStartTrial).toBe(false);
    expect(afterExpiry.body.data.trialUsedAt).toBeTruthy();
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

  test("GET /api/billing/subscription expiry does not clear lifetime trial usage", async () => {
    const { token, business } = await registerAndCreateBusiness();

    await resetTrialState(business._id);
    await startTrial(token);

    await Subscription.findOneAndUpdate(
      { business: business._id },
      {
        trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    );

    await request(app)
      .get("/api/billing/subscription")
      .set("Authorization", `Bearer ${token}`);

    const subscription = await Subscription.findOne({
      business: business._id,
    });

    // expireTrialIfNeeded rewrites status and access flags. It must leave
    // trialUsedAt alone or the lifetime limit silently resets.
    expect(subscription.status).toBe("expired");
    expect(subscription.trialUsedAt).toBeTruthy();
    expect(subscription.trialCount).toBe(1);
  });

  test("POST /api/billing/customers/:businessId/trial-override requires admin", async () => {
    const { token, business } = await registerAndCreateBusiness();

    const res = await request(app)
      .post(`/api/billing/customers/${business._id}/trial-override`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/billing/customers/:businessId/trial-override grants one more trial", async () => {
    const customer = await registerAndCreateBusiness();

    await resetTrialState(customer.business._id);
    await startTrial(customer.token);
    await expireTrialInPlace(customer.business._id);

    const blocked = await startTrial(customer.token);

    expect(blocked.status).toBe(400);

    const admin = await registerAndCreateBusiness({
      userName: "platformadmin",
      email: "admin@callbackiq.com",
      role: "admin",
      businessName: "CallBackIQ Internal",
      businessPhone: "6785554321",
    });

    const override = await request(app)
      .post(`/api/billing/customers/${customer.business._id}/trial-override`)
      .set("Authorization", `Bearer ${admin.token}`);

    expect(override.status).toBe(200);
    expect(override.body.success).toBe(true);

    // The override must release the identity-level locks too, or the
    // unique index rejects the regranted trial.
    const redemptions = await TrialRedemption.countDocuments({
      business: customer.business._id,
    });

    expect(redemptions).toBe(0);

    const regranted = await startTrial(customer.token);

    expect(regranted.status).toBe(200);

    const subscription = await Subscription.findOne({
      business: customer.business._id,
    });

    expect(subscription.status).toBe("trialing");
    expect(subscription.trialCount).toBe(2);
    expect(subscription.trialOverrideGrantedAt).toBeFalsy();
  });

  test("trial override is single use", async () => {
    const customer = await registerAndCreateBusiness();

    await resetTrialState(customer.business._id);
    await startTrial(customer.token);
    await expireTrialInPlace(customer.business._id);

    const admin = await registerAndCreateBusiness({
      userName: "platformadmin",
      email: "admin@callbackiq.com",
      role: "admin",
      businessName: "CallBackIQ Internal",
      businessPhone: "6785554321",
    });

    await request(app)
      .post(`/api/billing/customers/${customer.business._id}/trial-override`)
      .set("Authorization", `Bearer ${admin.token}`);

    await startTrial(customer.token);
    await expireTrialInPlace(customer.business._id);

    const res = await startTrial(customer.token);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("registration-granted trial is recorded as used", async () => {
    const { business, subscription } = await registerAndCreateBusiness();

    // Registration provisions a trial without going through startFreeTrial,
    // so it bypasses both the trialUsedAt stamp and the redemption row.
    // Until the auth controller records the grant, an expired signup trial
    // still looks unused and a second trial can be claimed.
    expect(subscription?.status).toBe("trialing");

    const stored = await Subscription.findOne({ business: business._id });

    expect(stored.trialUsedAt).toBeTruthy();
    expect(stored.trialCount).toBe(1);

    const redemption = await TrialRedemption.findOne({
      business: business._id,
    });

    expect(redemption).toBeTruthy();
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
