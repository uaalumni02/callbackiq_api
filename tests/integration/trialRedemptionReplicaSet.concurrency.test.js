jest.setTimeout(30000);

import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";

import app from "../../src/app.js";
import Subscription from "../../src/models/subscription.js";
import TrialRedemption from "../../src/models/trialRedemption.js";
import { getStripeClient } from "../../src/helpers/stripe/stripeClient.js";
import { syncStripeSubscription } from "../../src/services/trialLifecycle.service.js";

jest.mock("../../src/helpers/stripe/stripeClient.js", () => ({
  __esModule: true,
  getPriceIdByPlan: jest.fn(() => "price_pro_test"),
  getStripeClient: jest.fn(),
}));

jest.mock("../../src/services/trackingNumberProvisioning.service.js", () => ({
  provisionTrackingNumber: jest.fn(async () => null),
  releaseTrackingNumber: jest.fn(async () => null),
}));

jest.mock("../../src/helpers/email/mailer.js", () => ({
  sendTrialWelcomeEmail: jest.fn(async () => true),
  sendTrialReminderEmail: jest.fn(async () => true),
  sendTrialExpiredEmail: jest.fn(async () => true),
  sendTrackingNumberReleasedEmail: jest.fn(async () => true),
}));

describe("replica-set trial redemption concurrency", () => {
  let replSet;

  beforeAll(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replSet.getUri());
    await TrialRedemption.init();
  }, 60000);

  afterEach(async () => {
    const collections = mongoose.connection.collections;
    for (const collection of Object.values(collections)) {
      await collection.deleteMany({});
    }
    jest.clearAllMocks();
  });

  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    if (replSet) await replSet.stop();
  }, 60000);

  test("concurrent delivery of the same Stripe trial spends exactly one lifetime redemption", async () => {
    const registration = await request(app)
      .post("/api/auth/register")
      .send({
        userName: "repltrial",
        email: "repl.trial@example.com",
        password: "Password123",
        businessName: "Replica Plumbing",
        businessPhone: "4045551212",
        businessType: "plumbing",
        smsConsent: true,
        termsAccepted: true,
        privacyAccepted: true,
      });
    expect(registration.status).toBe(201);
    const { business, user } = registration.body.data;

    const now = Math.floor(Date.now() / 1000);
    const remote = {
      id: "sub_repl_trial_once",
      customer: "cus_repl_trial_once",
      status: "trialing",
      trial_start: now,
      trial_end: now + 14 * 86400,
      current_period_start: now,
      current_period_end: now + 14 * 86400,
      cancel_at_period_end: false,
      metadata: {
        businessId: String(business._id),
        ownerId: String(user._id),
        plan: "pro",
      },
      items: { data: [{ price: { id: "price_pro_test" } }] },
      latest_invoice: null,
    };

    getStripeClient.mockReturnValue({
      subscriptions: {
        retrieve: jest.fn().mockResolvedValue(remote),
        cancel: jest.fn().mockResolvedValue({ ...remote, status: "canceled" }),
      },
    });

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        syncStripeSubscription({
          stripeSubscription: remote,
          checkoutSessionId: "cs_repl_trial_once",
          refreshFromStripe: false,
        }),
      ),
    );

    const rejected = results.filter((result) => result.status === "rejected");
    expect(
      rejected.map((result) => result.reason?.message || String(result.reason)),
    ).toEqual([]);
    expect(results).toHaveLength(8);

    expect(
      await TrialRedemption.countDocuments({
        business: business._id,
      }),
    ).toBe(1);

    const stored = await Subscription.findOne({ business: business._id });
    expect(stored.status).toBe("trialing");
    expect(stored.trialCount).toBe(1);
    expect(stored.stripeSubscriptionId).toBe(remote.id);
  }, 30000);
});
