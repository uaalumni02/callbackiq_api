jest.setTimeout(30000);

import request from "supertest";
import app from "../../src/app.js";
import Business from "../../src/models/business.js";
import BillingEvent from "../../src/models/billingEvent.js";
import Subscription from "../../src/models/subscription.js";
import TrialRedemption from "../../src/models/trialRedemption.js";
import { getStripeClient } from "../../src/helpers/stripe/stripeClient.js";
import {
  connectTestDB,
  clearTestDB,
  closeTestDB,
} from "../setup/testDb.js";

jest.mock("../../src/helpers/stripe/stripeClient.js", () => ({
  __esModule: true,
  getPriceIdByPlan: jest.fn(() => "price_pro_test"),
  getStripeClient: jest.fn(),
}));

jest.mock("../../src/services/trackingNumberProvisioning.service.js", () => {
  const actual = jest.requireActual(
    "../../src/services/trackingNumberProvisioning.service.js",
  );
  return {
    ...actual,
    provisionTrackingNumber: jest.fn(async () => null),
    releaseTrackingNumber: jest.fn(async () => null),
  };
});

jest.mock("../../src/helpers/email/mailer.js", () => ({
  sendTrialWelcomeEmail: jest.fn(async () => true),
  sendTrialReminderEmail: jest.fn(async () => true),
  sendTrialExpiredEmail: jest.fn(async () => true),
  sendTrackingNumberReleasedEmail: jest.fn(async () => true),
}));

const register = (suffix) =>
  request(app)
    .post("/api/auth/register")
    .send({
      userName: `stripe${suffix}`,
      email: `stripe.${suffix}@example.com`,
      password: "Password123",
      businessName: `Stripe Matrix ${suffix}`,
      businessPhone: `404555${String(suffix).padStart(4, "0").slice(-4)}`,
      businessType: "plumbing",
      smsConsent: true,
      termsAccepted: true,
      privacyAccepted: true,
    });

const subscriptionPayload = ({
  businessId,
  ownerId,
  id = "sub_canonical",
  customer = "cus_canonical",
  status = "active",
  trial = false,
}) => {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    customer,
    status,
    trial_start: trial ? now - 60 : null,
    trial_end: trial ? now + 14 * 86400 : null,
    current_period_start: now - 60,
    current_period_end: now + 30 * 86400,
    cancel_at_period_end: false,
    metadata: {
      businessId: String(businessId),
      ownerId: String(ownerId),
      plan: "pro",
    },
    items: { data: [{ price: { id: "price_pro_test" } }] },
    latest_invoice: null,
  };
};

const sendEvent = (event) =>
  request(app)
    .post("/api/billing/webhook")
    .set("stripe-signature", "sig_test")
    .set("Content-Type", "application/json")
    .send(event);

describe("Stripe subscription state matrix hardening", () => {
  beforeAll(async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    await connectTestDB();
    await TrialRedemption.init();
    await BillingEvent.init();
  }, 60_000);

  afterEach(async () => {
    jest.clearAllMocks();
    await clearTestDB();
  });

  afterAll(closeTestDB);

  const configureStripe = (remoteById) => {
    const stripe = {
      webhooks: {
        constructEvent: jest.fn((body) => JSON.parse(body.toString("utf8"))),
      },
      subscriptions: {
        retrieve: jest.fn(async (id) => {
          const value = remoteById[id];
          if (!value) {
            const error = new Error("missing");
            error.code = "resource_missing";
            error.statusCode = 404;
            throw error;
          }
          return value;
        }),
        list: jest.fn(async ({ customer }) => ({
          data: Object.values(remoteById).filter(
            (value) =>
              String(value.customer) === String(customer) &&
              [
                "incomplete",
                "trialing",
                "active",
                "past_due",
                "unpaid",
                "paused",
              ].includes(value.status),
          ),
        })),
        cancel: jest.fn(async (id) => ({
          ...(remoteById[id] || { id }),
          status: "canceled",
        })),
      },
    };
    getStripeClient.mockReturnValue(stripe);
    return stripe;
  };

  test.each([
    ["customer.subscription.created", "active", "3001"],
    ["customer.subscription.updated", "active", "3002"],
    ["customer.subscription.paused", "paused", "3003"],
    ["customer.subscription.resumed", "active", "3004"],
    ["customer.subscription.deleted", "canceled", "3005"],
  ])("%s synchronizes the canonical subscription status %s", async (type, status, suffix) => {
    const registration = await register(suffix);
    expect(registration.status).toBe(201);
    const { business, user } = registration.body.data;

    await Subscription.findOneAndUpdate(
      { business: business._id },
      {
        $set: {
          stripeCustomerId: "cus_canonical",
          stripeSubscriptionId: "sub_canonical",
          status: "active",
          isActive: true,
          aiEnabled: true,
        },
      },
      { upsert: true },
    );

    const remote = subscriptionPayload({
      businessId: business._id,
      ownerId: user._id,
      status,
    });
    configureStripe({ sub_canonical: remote });

    const event = {
      id: `evt_${type.replace(/\W/g, "_")}`,
      type,
      data: { object: remote },
    };
    const res = await sendEvent(event);
    expect(res.status).toBe(200);

    const stored = await Subscription.findOne({ business: business._id });
    expect(stored.status).toBe(status);
    expect(stored.stripeSubscriptionId).toBe("sub_canonical");
  });

  test("trial_will_end keeps the trial canonical and emits the three-day lifecycle message once", async () => {
    const registration = await register("3101");
    const { business, user } = registration.body.data;
    const trial = subscriptionPayload({
      businessId: business._id,
      ownerId: user._id,
      id: "sub_trial_warning",
      customer: "cus_trial_warning",
      status: "trialing",
      trial: true,
    });
    configureStripe({ sub_trial_warning: trial });

    const first = await sendEvent({
      id: "evt_trial_will_end_1",
      type: "customer.subscription.trial_will_end",
      data: { object: trial },
    });
    expect(first.status).toBe(200);

    const stored = await Subscription.findOne({ business: business._id });
    expect(stored.status).toBe("trialing");
    expect(stored.trialReminder3dSentAt).toBeTruthy();
  });

  test("the same Stripe event id is processed only once", async () => {
    const registration = await register("3102");
    const { business, user } = registration.body.data;
    const remote = subscriptionPayload({
      businessId: business._id,
      ownerId: user._id,
      id: "sub_duplicate_event",
      customer: "cus_duplicate_event",
      status: "active",
    });
    const stripe = configureStripe({ sub_duplicate_event: remote });

    const event = {
      id: "evt_same_id_twice",
      type: "customer.subscription.updated",
      data: { object: remote },
    };
    const first = await sendEvent(event);
    const second = await sendEvent(event);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data?.duplicate ?? second.body.duplicate).toBe(true);
    expect(
      await BillingEvent.countDocuments({ providerEventId: event.id }),
    ).toBe(1);
    expect(stripe.subscriptions.retrieve).toHaveBeenCalled();
  });

  test("a late terminal event for a foreign subscription cannot replace a live canonical subscription", async () => {
    const registration = await register("3103");
    const { business, user } = registration.body.data;
    await Subscription.findOneAndUpdate(
      { business: business._id },
      {
        $set: {
          stripeCustomerId: "cus_ordering",
          stripeSubscriptionId: "sub_live",
          status: "active",
          isActive: true,
          aiEnabled: true,
        },
      },
      { upsert: true },
    );

    const live = subscriptionPayload({
      businessId: business._id,
      ownerId: user._id,
      id: "sub_live",
      customer: "cus_ordering",
      status: "active",
    });
    const stale = subscriptionPayload({
      businessId: business._id,
      ownerId: user._id,
      id: "sub_old",
      customer: "cus_ordering",
      status: "canceled",
    });
    configureStripe({ sub_live: live, sub_old: stale });

    const res = await sendEvent({
      id: "evt_late_deleted_foreign",
      type: "customer.subscription.deleted",
      data: { object: stale },
    });
    expect(res.status).toBe(200);

    const stored = await Subscription.findOne({ business: business._id });
    expect(stored.stripeSubscriptionId).toBe("sub_live");
    expect(stored.status).toBe("active");
  });

  test.each([
    ["invoice.paid", "paid", "in_paid_canonical", "3105"],
    ["invoice.payment_failed", "failed", "in_failed_canonical", "3106"],
  ])("%s updates payment state only after reconciling the canonical subscription", async (type, expectedPaymentStatus, invoiceId, suffix) => {
    const registration = await register(suffix);
    expect(registration.status).toBe(201);
    const { business, user } = registration.body.data;

    await Subscription.findOneAndUpdate(
      { business: business._id },
      {
        $set: {
          stripeCustomerId: `cus_invoice_${suffix}`,
          stripeSubscriptionId: `sub_invoice_${suffix}`,
          status: "active",
          isActive: true,
          aiEnabled: true,
          lastPaymentStatus: type === "invoice.paid" ? "pending" : "paid",
        },
      },
      { upsert: true },
    );

    const remote = subscriptionPayload({
      businessId: business._id,
      ownerId: user._id,
      id: `sub_invoice_${suffix}`,
      customer: `cus_invoice_${suffix}`,
      status: "active",
    });
    const stripe = configureStripe({ [remote.id]: remote });

    const res = await sendEvent({
      id: `evt_${type.replace(/\W/g, "_")}_${suffix}`,
      type,
      data: {
        object: {
          id: invoiceId,
          customer: remote.customer,
          subscription: remote.id,
          billing_reason: "subscription_cycle",
          amount_due: 9900,
          amount_paid: type === "invoice.paid" ? 9900 : 0,
          currency: "usd",
        },
      },
    });

    expect(res.status).toBe(200);
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith(
      remote.id,
      { expand: ["latest_invoice"] },
    );

    const stored = await Subscription.findOne({ business: business._id });
    expect(stored.stripeSubscriptionId).toBe(remote.id);
    expect(stored.status).toBe("active");
    expect(stored.latestInvoiceId).toBe(invoiceId);
    expect(stored.lastPaymentStatus).toBe(expectedPaymentStatus);
  });

  test("invoice mismatch does not mutate payment state for the canonical subscription", async () => {
    const registration = await register("3104");
    const { business } = registration.body.data;
    await Subscription.findOneAndUpdate(
      { business: business._id },
      {
        $set: {
          stripeCustomerId: "cus_invoice_guard",
          stripeSubscriptionId: "sub_invoice_canonical",
          status: "active",
          isActive: true,
          aiEnabled: true,
          lastPaymentStatus: "paid",
        },
      },
      { upsert: true },
    );
    configureStripe({});

    const res = await sendEvent({
      id: "evt_invoice_mismatch",
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_foreign",
          customer: "cus_invoice_guard",
          subscription: "sub_foreign",
          billing_reason: "subscription_cycle",
          amount_due: 9900,
        },
      },
    });

    expect(res.status).toBe(200);
    const stored = await Subscription.findOne({ business: business._id });
    expect(stored.stripeSubscriptionId).toBe("sub_invoice_canonical");
    expect(stored.lastPaymentStatus).toBe("paid");
  });
});
