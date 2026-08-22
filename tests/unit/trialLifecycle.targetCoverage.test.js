import Business from "../../src/models/business.js";
import Subscription from "../../src/models/subscription.js";
import { getStripeClient } from "../../src/helpers/stripe/stripeClient.js";
import {
  provisionTrackingNumber,
  releaseTrackingNumber,
} from "../../src/services/trackingNumberProvisioning.service.js";
import { getSubscriptionAccess } from "../../src/services/subscriptionAccess.service.js";
import {
  sendTrialExpiredEmail,
  sendTrialReminderEmail,
  sendTrackingNumberReleasedEmail,
} from "../../src/helpers/email/mailer.js";
import { processTrialLifecycle } from "../../src/services/trialLifecycle.service.js";

jest.mock("mongoose", () => ({
  __esModule: true,
  default: { startSession: jest.fn() },
}));

jest.mock("../../src/models/business.js", () => ({
  __esModule: true,
  default: {
    findById: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    updateOne: jest.fn(),
  },
}));

jest.mock("../../src/models/subscription.js", () => ({
  __esModule: true,
  default: {
    find: jest.fn(),
    findById: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    countDocuments: jest.fn(),
    updateOne: jest.fn(),
  },
}));

jest.mock("../../src/models/trialRedemption.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn(), create: jest.fn() },
}));

jest.mock("../../src/models/trialExtensionGrant.js", () => ({
  __esModule: true,
  default: { find: jest.fn(), create: jest.fn() },
}));

jest.mock("../../src/helpers/billing/trial.js", () => ({
  TRIAL_DAYS: 14,
  TRIAL_PRICE_MONTHLY: 199,
  buildTrialIdentity: jest.fn(() => ({
    ownerId: "owner-1",
    emailKey: "owner@example.com",
    phoneKey: "+14045550999",
  })),
  getTrialEligibility: jest.fn(),
}));

jest.mock("../../src/helpers/stripe/stripeClient.js", () => ({
  getStripeClient: jest.fn(),
  getPriceIdByPlan: jest.fn(),
}));

jest.mock("../../src/services/trackingNumberProvisioning.service.js", () => ({
  provisionTrackingNumber: jest.fn(),
  releaseTrackingNumber: jest.fn(),
}));

jest.mock("../../src/services/subscriptionAccess.service.js", () => ({
  ACCESS_LEVELS: { FULL: "full" },
  getSubscriptionAccess: jest.fn(),
}));

jest.mock("../../src/services/subscriptionIntegrity.service.js", () => ({
  assertStripeCustomerHasNoCompetingSubscriptions: jest.fn(),
  findExistingStripeCustomerForBusiness: jest.fn(),
  guardCanonicalStripeSubscription: jest.fn().mockResolvedValue({ allowed: true }),
}));

jest.mock("../../src/helpers/email/mailer.js", () => ({
  sendTrialWelcomeEmail: jest.fn(),
  sendTrialReminderEmail: jest.fn(),
  sendTrialExpiredEmail: jest.fn(),
  sendTrackingNumberReleasedEmail: jest.fn(),
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-21T18:00:00.000Z");

const selectedLean = (value) => ({
  select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(value) })),
});

const populated = (value) => ({
  populate: jest.fn().mockResolvedValue(value),
});

const makeSubscription = (overrides = {}) => ({
  _id: "sub-1",
  business: "biz-1",
  status: "trialing",
  trialUsedAt: new Date("2026-08-07T18:00:00.000Z"),
  trialEndsAt: new Date(NOW.getTime() + DAY_MS),
  trialNumberReleaseAt: null,
  stripeSubscriptionId: "sub_remote",
  ...overrides,
});

const businessForEmail = {
  _id: "biz-1",
  businessName: "Atlanta Pro Plumbing & Drain",
  email: "owner@example.com",
  owner: { email: "owner@example.com" },
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.TRIAL_NUMBER_RELEASE_GRACE_DAYS;
  delete process.env.TRIAL_NO_PAYMENT_METHOD_NUMBER_RELEASE_GRACE_HOURS;

  Business.findByIdAndUpdate.mockResolvedValue({ _id: "biz-1" });
  Subscription.updateOne.mockResolvedValue({ modifiedCount: 1 });
  provisionTrackingNumber.mockResolvedValue({ _id: "biz-1", phone: "+14045550123" });
  releaseTrackingNumber.mockResolvedValue({ _id: "biz-1", phone: "" });
  sendTrialReminderEmail.mockResolvedValue(true);
  sendTrialExpiredEmail.mockResolvedValue(true);
  sendTrackingNumberReleasedEmail.mockResolvedValue(true);
  getSubscriptionAccess.mockReturnValue({
    level: "none",
    status: "expired",
    reason: "expired",
  });
  getStripeClient.mockReturnValue({
    subscriptions: {
      retrieve: jest.fn(),
    },
  });
});

describe("trial lifecycle worker target coverage", () => {
  test("processes an empty lifecycle batch", async () => {
    Subscription.find.mockResolvedValue([]);

    await expect(processTrialLifecycle(NOW)).resolves.toEqual({ processed: 0 });
  });

  test("repairs telecom readiness for full-access trials and sends the one-day reminder", async () => {
    const subscription = makeSubscription({
      trialEndsAt: new Date(NOW.getTime() + 12 * 60 * 60 * 1000),
    });
    Subscription.find.mockResolvedValue([subscription]);
    Subscription.findById.mockResolvedValue(subscription);
    getSubscriptionAccess.mockReturnValue({
      level: "full",
      status: "trialing",
      reason: "full",
    });

    Business.findById
      .mockReturnValueOnce(
        selectedLean({
          _id: "biz-1",
          phone: "",
          trackingNumber: { status: "unassigned" },
        }),
      )
      .mockReturnValueOnce(populated(businessForEmail));

    await expect(processTrialLifecycle(NOW)).resolves.toEqual({ processed: 1 });

    expect(provisionTrackingNumber).toHaveBeenCalledWith("biz-1");
    expect(sendTrialReminderEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "owner@example.com",
        daysRemaining: 1,
      }),
    );
    expect(Subscription.updateOne).toHaveBeenCalledWith(
      { _id: "sub-1", trialReminder1dSentAt: null },
      { $set: { trialReminder1dSentAt: expect.any(Date) } },
    );
  });

  test("sends the three-day reminder without reprovisioning an already active number", async () => {
    const subscription = makeSubscription({
      trialEndsAt: new Date(NOW.getTime() + 2 * DAY_MS),
    });
    Subscription.find.mockResolvedValue([subscription]);
    Subscription.findById.mockResolvedValue(subscription);
    getSubscriptionAccess.mockReturnValue({
      level: "full",
      status: "trialing",
      reason: "full",
    });
    Business.findById
      .mockReturnValueOnce(
        selectedLean({
          _id: "biz-1",
          phone: "+14045550123",
          trackingNumber: { status: "active" },
        }),
      )
      .mockReturnValueOnce(populated(businessForEmail));

    await processTrialLifecycle(NOW);

    expect(provisionTrackingNumber).not.toHaveBeenCalled();
    expect(sendTrialReminderEmail).toHaveBeenCalledWith(
      expect.objectContaining({ daysRemaining: 3 }),
    );
  });

  test("fails safe on expired-trial Stripe reconciliation and schedules the short paused-trial release grace", async () => {
    process.env.TRIAL_NO_PAYMENT_METHOD_NUMBER_RELEASE_GRACE_HOURS = "48";
    const subscription = makeSubscription({
      trialEndsAt: new Date(NOW.getTime() - 1000),
      trialNumberReleaseAt: null,
    });
    const expectedReleaseAt = new Date(NOW.getTime() + 48 * 60 * 60 * 1000);
    const refreshed = {
      ...subscription,
      status: "expired",
      isActive: false,
      aiEnabled: false,
      trialNumberReleaseAt: expectedReleaseAt,
    };

    Subscription.find.mockResolvedValue([subscription]);
    Subscription.findById.mockResolvedValue(refreshed);
    Business.findById.mockReturnValue(populated(businessForEmail));
    const stripe = {
      subscriptions: {
        retrieve: jest.fn().mockRejectedValue(new Error("stripe unavailable")),
      },
    };
    getStripeClient.mockReturnValue(stripe);

    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(processTrialLifecycle(NOW)).resolves.toEqual({ processed: 1 });
    spy.mockRestore();

    expect(Subscription.updateOne).toHaveBeenCalledWith(
      { _id: "sub-1" },
      {
        $set: expect.objectContaining({
          status: "expired",
          isActive: false,
          aiEnabled: false,
          lastPaymentStatus: "trial_expired_reconcile_pending",
          trialNumberReleaseAt: expectedReleaseAt,
        }),
      },
    );
    expect(Business.findByIdAndUpdate).toHaveBeenCalled();
    expect(sendTrialExpiredEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "owner@example.com" }),
    );
  });

  test("postpones number release when final Stripe reconciliation is unavailable", async () => {
    const releaseAt = new Date(NOW.getTime() - 1000);
    const subscription = makeSubscription({
      status: "expired",
      trialEndsAt: new Date(NOW.getTime() - DAY_MS),
      trialNumberReleaseAt: releaseAt,
    });
    Subscription.find.mockResolvedValue([subscription]);
    Subscription.findById.mockResolvedValue(subscription);
    getStripeClient.mockReturnValue({
      subscriptions: {
        retrieve: jest.fn().mockRejectedValue(new Error("stripe unavailable")),
      },
    });

    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    await processTrialLifecycle(NOW);
    spy.mockRestore();

    expect(Subscription.updateOne).toHaveBeenCalledWith(
      { _id: "sub-1" },
      {
        $set: {
          trialNumberReleaseAt: new Date(NOW.getTime() + DAY_MS),
        },
      },
    );
    expect(releaseTrackingNumber).not.toHaveBeenCalled();
  });

  test("releases a due trial number with no remote subscription and sends the release notice", async () => {
    const subscription = makeSubscription({
      status: "expired",
      stripeSubscriptionId: "",
      trialEndsAt: new Date(NOW.getTime() - DAY_MS),
      trialNumberReleaseAt: new Date(NOW.getTime() - 1000),
    });
    const afterRelease = { ...subscription, trialNumberReleaseAt: null };

    Subscription.find.mockResolvedValue([subscription]);
    Subscription.findById
      .mockResolvedValueOnce(subscription)
      .mockResolvedValueOnce(afterRelease);
    Business.findById.mockReturnValue(populated(businessForEmail));

    await expect(processTrialLifecycle(NOW)).resolves.toEqual({ processed: 1 });

    expect(releaseTrackingNumber).toHaveBeenCalledWith("biz-1");
    expect(Subscription.updateOne).toHaveBeenCalledWith(
      { _id: "sub-1" },
      { $set: { trialNumberReleaseAt: null } },
    );
    expect(sendTrackingNumberReleasedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "owner@example.com",
        businessName: "Atlanta Pro Plumbing & Drain",
      }),
    );
  });

  test("keeps the release schedule when carrier release fails", async () => {
    const subscription = makeSubscription({
      status: "expired",
      stripeSubscriptionId: "",
      trialEndsAt: new Date(NOW.getTime() - DAY_MS),
      trialNumberReleaseAt: new Date(NOW.getTime() - 1000),
    });
    Subscription.find.mockResolvedValue([subscription]);
    Subscription.findById.mockResolvedValue(subscription);
    releaseTrackingNumber.mockRejectedValue(new Error("Twilio unavailable"));

    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    await processTrialLifecycle(NOW);
    spy.mockRestore();

    expect(Subscription.updateOne).not.toHaveBeenCalledWith(
      { _id: "sub-1" },
      { $set: { trialNumberReleaseAt: null } },
    );
  });
});
