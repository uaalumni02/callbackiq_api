import mongoose from "mongoose";
import request from "supertest";

import app from "../../src/app.js";
import Business from "../../src/models/business.js";
import Subscription from "../../src/models/subscription.js";
import TrialRedemption from "../../src/models/trialRedemption.js";
import TrialExtensionGrant from "../../src/models/trialExtensionGrant.js";
import User from "../../src/models/user.js";
import { getStripeClient } from "../../src/helpers/stripe/stripeClient.js";
import { connectTestDB, clearTestDB, closeTestDB } from "../setup/testDb.js";

jest.mock("../../src/helpers/stripe/stripeClient.js", () => ({
  __esModule: true,
  getPriceIdByPlan: jest.fn(() => "price_pro_test"),
  getStripeClient: jest.fn(),
}));

jest.mock("../../src/services/trackingNumberProvisioning.service.js", () => {
  const actual = jest.requireActual(
    "../../src/services/trackingNumberProvisioning.service.js",
  );
  const BusinessModel = jest.requireActual(
    "../../src/models/business.js",
  ).default;

  return {
    ...actual,
    provisionTrackingNumber: jest.fn(async (businessId) =>
      BusinessModel.findByIdAndUpdate(
        businessId,
        {
          $set: {
            phone: "+16785550123",
            phoneLookup: "+16785550123",
            "trackingNumber.status": "active",
            "setupProgress.trackingNumberAssigned": true,
            "setupProgress.trackingNumberVerified": true,
            "setupProgress.trackingNumberActive": true,
          },
        },
        { returnDocument: "after" },
      ),
    ),
    releaseTrackingNumber: jest.fn(async (businessId) =>
      BusinessModel.findById(businessId),
    ),
  };
});

const register = (overrides = {}) =>
  request(app)
    .post("/api/auth/register")
    .send({
      userName: "trialowner",
      email: "trial.owner@gmail.com",
      password: "Password123",
      businessName: "Trial Plumbing",
      businessPhone: "4045551212",
      businessType: "plumbing",
      smsConsent: true,
      termsAccepted: true,
      privacyAccepted: true,
      ...overrides,
    });

const stripeSubscription = (businessId, ownerId, id = "sub_trial_1") => ({
  id,
  customer: "cus_trial_1",
  status: "trialing",
  trial_start: Math.floor(Date.now() / 1000),
  trial_end: Math.floor((Date.now() + 14 * 24 * 60 * 60 * 1000) / 1000),
  current_period_start: Math.floor(Date.now() / 1000),
  current_period_end: Math.floor((Date.now() + 14 * 24 * 60 * 60 * 1000) / 1000),
  cancel_at_period_end: false,
  metadata: {
    businessId: String(businessId),
    ownerId: String(ownerId),
    plan: "pro",
  },
  items: { data: [{ price: { id: "price_pro_test" } }] },
  latest_invoice: null,
});

describe("Stripe-native trial lifecycle regression", () => {
  beforeAll(async () => {
    process.env.CLIENT_URL = "http://localhost:3001";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    await connectTestDB();
    await TrialRedemption.init();
  });

  afterEach(async () => {
    jest.clearAllMocks();
    delete process.env.TRIAL_MAX_NEW_TRIALS_PER_DAY;
    delete process.env.TRIAL_MAX_CONCURRENT_ACTIVE;
    delete process.env.TRIAL_MAX_TRACKING_NUMBERS_HELD;
    delete process.env.TRIAL_MAX_ADMIN_EXTENSION_DAYS;
    await clearTestDB();
  });

  afterAll(async () => {
    await closeTestDB();
  });

  test("registration creates no telecom entitlement and does not spend the trial", async () => {
    const res = await register();

    expect(res.status).toBe(201);
    expect(res.body.data.business.phone).toBeUndefined();
    expect(res.body.data.business.trackingNumber.status).toBe("unassigned");
    expect(res.body.data.business.isActive).toBe(true);
    expect(res.body.data.subscription.status).toBe("none");
    expect(res.body.data.trialEligible).toBe(true);
    expect(await TrialRedemption.countDocuments()).toBe(0);
  });

  test("trial activation creates no-card Stripe Checkout but still does not spend the trial", async () => {
    const registration = await register();
    const { token, business } = registration.body.data;

    const stripe = {
      customers: {
        create: jest.fn().mockResolvedValue({ id: "cus_trial_1" }),
      },
      checkout: {
        sessions: {
          create: jest.fn().mockResolvedValue({
            id: "cs_trial_1",
            url: "https://checkout.stripe.test/trial",
          }),
        },
      },
    };
    getStripeClient.mockReturnValue(stripe);

    const res = await request(app)
      .post("/api/billing/free-trial")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.checkoutUrl).toBe(
      "https://checkout.stripe.test/trial",
    );
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        payment_method_collection: "if_required",
        subscription_data: expect.objectContaining({
          trial_period_days: 14,
          trial_settings: {
            end_behavior: { missing_payment_method: "pause" },
          },
        }),
      }),
      expect.any(Object),
    );

    expect(await TrialRedemption.countDocuments({ business: business._id })).toBe(
      0,
    );
    const stored = await Subscription.findOne({ business: business._id });
    expect(stored.status).toBe("incomplete");
  });

  test("only a signed completed Stripe trial spends the lifetime trial", async () => {
    const registration = await register();
    const { business, user } = registration.body.data;
    const remote = stripeSubscription(business._id, user._id);

    const stripe = {
      webhooks: {
        constructEvent: jest.fn((body) => JSON.parse(body.toString("utf8"))),
      },
      subscriptions: {
        retrieve: jest.fn().mockResolvedValue(remote),
        cancel: jest.fn().mockResolvedValue({ id: remote.id, status: "canceled" }),
      },
    };
    getStripeClient.mockReturnValue(stripe);

    const event = {
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_trial_1",
          customer: remote.customer,
          subscription: remote.id,
          metadata: remote.metadata,
        },
      },
    };

    const res = await request(app)
      .post("/api/billing/webhook")
      .set("stripe-signature", "sig_test")
      .set("Content-Type", "application/json")
      .send(event);

    expect(res.status).toBe(200);

    const subscription = await Subscription.findOne({
      business: business._id,
    });
    const redemption = await TrialRedemption.findOne({
      business: business._id,
    });
    const activatedBusiness = await Business.findById(business._id);

    expect(subscription.status).toBe("trialing");
    expect(subscription.trialUsedAt).toBeTruthy();
    expect(subscription.trialCount).toBe(1);
    expect(redemption).toBeTruthy();
    expect(redemption.phoneKey).toBe("+14045551212");
    expect(activatedBusiness.isActive).toBe(true);
    expect(activatedBusiness.trialCostControls.enabled).toBe(true);
  });

  test("a zero-dollar invoice.paid event does not promote a Stripe trial to paid active status", async () => {
    const registration = await register({
      userName: "invoiceowner",
      email: "invoice-trial@example.com",
      businessPhone: "4045557777",
    });
    const { business, user } = registration.body.data;
    const remote = stripeSubscription(
      business._id,
      user._id,
      "sub_trial_invoice_paid",
    );

    const stripe = {
      webhooks: {
        constructEvent: jest.fn((body) => JSON.parse(body.toString("utf8"))),
      },
      subscriptions: {
        retrieve: jest.fn().mockResolvedValue(remote),
        cancel: jest.fn().mockResolvedValue({ status: "canceled" }),
      },
    };
    getStripeClient.mockReturnValue(stripe);

    await request(app)
      .post("/api/billing/webhook")
      .set("stripe-signature", "sig_test")
      .set("Content-Type", "application/json")
      .send({
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_trial_invoice_paid",
            subscription: remote.id,
            metadata: remote.metadata,
          },
        },
      });

    const invoiceRes = await request(app)
      .post("/api/billing/webhook")
      .set("stripe-signature", "sig_test")
      .set("Content-Type", "application/json")
      .send({
        type: "invoice.paid",
        data: {
          object: {
            id: "in_zero_trial",
            subscription: remote.id,
          },
        },
      });

    expect(invoiceRes.status).toBe(200);

    const subscription = await Subscription.findOne({ business: business._id });
    const trialBusiness = await Business.findById(business._id);
    expect(subscription.status).toBe("trialing");
    expect(subscription.lastPaymentStatus).toBe("paid");
    expect(subscription.trialCount).toBe(1);
    expect(trialBusiness.trialCostControls.enabled).toBe(true);
  });

  test("global daily activation ceiling blocks additional trial checkout before telecom spend", async () => {
    process.env.TRIAL_MAX_NEW_TRIALS_PER_DAY = "1";
    process.env.TRIAL_MAX_CONCURRENT_ACTIVE = "100";

    await Subscription.create({
      business: new mongoose.Types.ObjectId(),
      plan: "pro",
      status: "trialing",
      trialStartedAt: new Date(),
      trialEndsAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      trialUsedAt: new Date(),
      trialCount: 1,
      isActive: true,
      aiEnabled: true,
    });

    const registration = await register({
      userName: "capacityowner",
      email: "capacity@example.com",
      businessPhone: "4045559898",
    });
    const stripe = {
      customers: { create: jest.fn() },
      checkout: { sessions: { create: jest.fn() } },
    };
    getStripeClient.mockReturnValue(stripe);

    const res = await request(app)
      .post("/api/billing/free-trial")
      .set("Authorization", `Bearer ${registration.body.data.token}`);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("TRIAL_DAILY_CAPACITY_REACHED");
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test("global trial tracking-number inventory ceiling includes post-trial grace holds", async () => {
    process.env.TRIAL_MAX_NEW_TRIALS_PER_DAY = "100";
    process.env.TRIAL_MAX_CONCURRENT_ACTIVE = "100";
    process.env.TRIAL_MAX_TRACKING_NUMBERS_HELD = "1";

    await Subscription.create({
      business: new mongoose.Types.ObjectId(),
      plan: "pro",
      status: "expired",
      trialStartedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      trialEndsAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
      trialUsedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      trialNumberReleaseAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      trialCount: 1,
      isActive: false,
      aiEnabled: false,
    });

    const registration = await register({
      userName: "inventoryowner",
      email: "inventory@example.com",
      businessPhone: "6785559898",
    });
    const stripe = {
      customers: { create: jest.fn() },
      checkout: { sessions: { create: jest.fn() } },
    };
    getStripeClient.mockReturnValue(stripe);

    const res = await request(app)
      .post("/api/billing/free-trial")
      .set("Authorization", `Bearer ${registration.body.data.token}`);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("TRIAL_NUMBER_INVENTORY_CAPACITY_REACHED");
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test("forwarding-phone reuse cannot obtain a second lifetime trial after the original business is removed", async () => {
    const first = await register({
      userName: "phoneowner1",
      email: "first-phone-owner@example.com",
      businessPhone: "4045551212",
    });
    const { business, user } = first.body.data;
    const remote = stripeSubscription(business._id, user._id, "sub_phone_lock_1");

    const stripe = {
      webhooks: {
        constructEvent: jest.fn((body) => JSON.parse(body.toString("utf8"))),
      },
      subscriptions: {
        retrieve: jest.fn().mockResolvedValue(remote),
        cancel: jest.fn().mockResolvedValue({ status: "canceled" }),
      },
    };
    getStripeClient.mockReturnValue(stripe);

    await request(app)
      .post("/api/billing/webhook")
      .set("stripe-signature", "sig_test")
      .set("Content-Type", "application/json")
      .send({
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_phone_lock_1",
            subscription: remote.id,
            metadata: remote.metadata,
          },
        },
      });

    await Business.deleteMany({});

    const second = await register({
      userName: "phoneowner2",
      email: "second-phone-owner@example.com",
      businessName: "Trial Plumbing Two",
      businessPhone: "4045551212",
    });

    expect(second.status).toBe(201);
    expect(second.body.data.trialEligible).toBe(false);
    expect(second.body.data.trialDeniedReason).toBe("trial_already_used");
  });

  test("admin extension preserves one lifetime redemption and trialCount remains one", async () => {
    process.env.TRIAL_MAX_ADMIN_EXTENSION_DAYS = "14";

    const registration = await register({
      userName: "extensionowner",
      email: "extension@example.com",
      businessPhone: "4705551212",
    });
    const { business, user, token } = registration.body.data;
    const remote = stripeSubscription(business._id, user._id, "sub_extension_1");

    const stripe = {
      webhooks: {
        constructEvent: jest.fn((body) => JSON.parse(body.toString("utf8"))),
      },
      subscriptions: {
        retrieve: jest.fn().mockResolvedValue(remote),
        cancel: jest.fn().mockResolvedValue({ status: "canceled" }),
        update: jest.fn().mockImplementation(async (subscriptionId, params) => ({
          ...remote,
          id: subscriptionId,
          trial_end: params.trial_end,
          current_period_end: params.trial_end,
        })),
      },
    };
    getStripeClient.mockReturnValue(stripe);

    await request(app)
      .post("/api/billing/webhook")
      .set("stripe-signature", "sig_test")
      .set("Content-Type", "application/json")
      .send({
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_extension_1",
            subscription: remote.id,
            metadata: remote.metadata,
          },
        },
      });

    await User.findByIdAndUpdate(user._id, { $set: { role: "admin" } });

    const res = await request(app)
      .post(`/api/billing/customers/${business._id}/trial-override`)
      .set("Authorization", `Bearer ${token}`)
      .send({ days: 7, reason: "Support-approved pilot extension" });

    expect(res.status).toBe(200);
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(await TrialRedemption.countDocuments({ business: business._id })).toBe(1);
    expect(await TrialExtensionGrant.countDocuments({ business: business._id })).toBe(1);

    const subscription = await Subscription.findOne({ business: business._id });
    expect(subscription.trialCount).toBe(1);
    expect(subscription.trialUsedAt).toBeTruthy();
  });

  test("Gmail aliases cannot obtain a second lifetime trial", async () => {
    const first = await register();
    const { business, user } = first.body.data;
    const remote = stripeSubscription(business._id, user._id);

    const stripe = {
      webhooks: {
        constructEvent: jest.fn((body) => JSON.parse(body.toString("utf8"))),
      },
      subscriptions: {
        retrieve: jest.fn().mockResolvedValue(remote),
        cancel: jest.fn().mockResolvedValue({ status: "canceled" }),
      },
    };
    getStripeClient.mockReturnValue(stripe);

    await request(app)
      .post("/api/billing/webhook")
      .set("stripe-signature", "sig_test")
      .set("Content-Type", "application/json")
      .send({
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_trial_1",
            subscription: remote.id,
            metadata: remote.metadata,
          },
        },
      });

    // Simulate a new account after the original customer record was removed.
    // TrialRedemption intentionally survives account lifecycle cleanup.
    await Business.deleteMany({});
    const second = await register({
      userName: "trialowner2",
      email: "t.r.i.a.l.owner+again@gmail.com",
      businessName: "Trial Plumbing 2",
      businessPhone: "7705553434",
    });

    expect(second.status).toBe(201);
    expect(second.body.data.trialEligible).toBe(false);
  });
});
