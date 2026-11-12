jest.mock('../../src/services/distributedLease.service.js', () => ({ assertDistributedLeaseActive: jest.fn(), withDistributedLease: jest.fn(async (_key, run) => ({ acquired: true, value: await run() })) }));
jest.mock('../../src/models/trialLifecycleDelivery.js', () => ({ __esModule: true, default: {
  findOneAndUpdate: jest.fn(async (_filter, update) => ({ _id: 'notice', status: 'queued', sentAt: new Date(), ...update.$set })),
  updateOne: jest.fn(), updateMany: jest.fn(), find: jest.fn(() => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) })),
} }));
import Business from "../../src/models/business.js";
import Subscription from "../../src/models/subscription.js";
import TrialExtensionGrant from "../../src/models/trialExtensionGrant.js";
import { getStripeClient, getPriceIdByPlan } from "../../src/helpers/stripe/stripeClient.js";
import { getTrialEligibility } from "../../src/helpers/billing/trial.js";
import {
  assertStripeCustomerHasNoCompetingSubscriptions,
  findExistingStripeCustomerForBusiness,
} from "../../src/services/subscriptionIntegrity.service.js";
import { getSubscriptionAccess } from "../../src/services/subscriptionAccess.service.js";
import {
  sendTrialWelcomeEmail,
  sendTrialReminderEmail,
  sendTrialExpiredEmail,
  sendTrackingNumberReleasedEmail,
} from "../../src/helpers/email/mailer.js";
import {
  createSubscriptionCheckout,
  extendTrialByAdmin,
  sendTrialLifecycleMessage,
  syncCheckoutSession,
  syncStripeSubscription,
} from "../../src/services/trialLifecycle.service.js";

jest.mock("mongoose", () => ({
  __esModule: true,
  default: { ...jest.requireActual("mongoose"), startSession: jest.fn() },
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
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    findById: jest.fn(),
    countDocuments: jest.fn(),
    updateOne: jest.fn(),
    find: jest.fn(),
  },
}));

jest.mock("../../src/models/trialRedemption.js", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
    create: jest.fn(),
  },
}));

jest.mock("../../src/models/trialExtensionGrant.js", () => ({
  __esModule: true,
  default: {
    find: jest.fn(), findOne: jest.fn().mockResolvedValue(null), findOneAndUpdate: jest.fn(),
    create: jest.fn(),
  },
}));

jest.mock("../../src/helpers/billing/trial.js", () => ({
  TRIAL_DAYS: 14,
  TRIAL_PRICE_MONTHLY: 199,
  buildTrialIdentity: jest.fn(() => ({
    ownerId: "owner-1",
    emailKey: "owner@example.com",
    phoneKey: "+14045550000",
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

const populated = (value) => ({
  populate: jest.fn().mockResolvedValue(value),
});

const selectedLean = (value) => ({
  select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(value) })),
});

const makeStripe = () => ({
  customers: {
    create: jest.fn().mockResolvedValue({ id: "cus_new" }),
  },
  checkout: {
    sessions: {
      create: jest.fn().mockResolvedValue({
        id: "cs_test",
        url: "https://checkout.stripe.test/session",
      }),
    },
  },
  subscriptions: {
    retrieve: jest.fn(),
    update: jest.fn().mockResolvedValue({
      id: "sub_remote",
      status: "trialing",
      trial_end: Math.floor(Date.now() / 1000) + 86400,
    }),
    cancel: jest.fn().mockResolvedValue({ id: "sub_remote", status: "canceled" }),
  },
});

const checkoutInput = (overrides = {}) => ({
  business: {
    _id: "biz-1",
    owner: "owner-1",
    businessName: "Atlanta Pro Plumbing & Drain",
    email: "owner@example.com",
    forwardingPhone: "+14045550000",
  },
  ownerId: "owner-1",
  plan: "pro",
  requireTrial: true,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();

  delete process.env.TRIAL_MAX_NEW_TRIALS_PER_DAY;
  delete process.env.TRIAL_MAX_CONCURRENT_ACTIVE;
  delete process.env.TRIAL_MAX_TRACKING_NUMBERS_HELD;
  delete process.env.TRIAL_MAX_ADMIN_EXTENSION_DAYS;
  process.env.CLIENT_URL = "https://app.callbackiq.test";

  getPriceIdByPlan.mockReturnValue("price_pro");
  getTrialEligibility.mockResolvedValue({ eligible: true });
  getSubscriptionAccess.mockReturnValue({
    level: "none",
    status: "none",
    reason: "no_subscription",
  });

  Subscription.findOne.mockResolvedValue(null);
  Subscription.findOneAndUpdate.mockResolvedValue({
    _id: "local-sub",
    business: "biz-1",
    status: "incomplete",
  });
  Subscription.countDocuments.mockResolvedValue(0);
  Subscription.updateOne.mockResolvedValue({ modifiedCount: 1 });

  findExistingStripeCustomerForBusiness.mockResolvedValue(null);
  assertStripeCustomerHasNoCompetingSubscriptions.mockResolvedValue(undefined);

  getStripeClient.mockReturnValue(makeStripe());

  sendTrialWelcomeEmail.mockResolvedValue({ messageId: "synthetic-mail-receipt" });
  sendTrialReminderEmail.mockResolvedValue({ messageId: "synthetic-mail-receipt" });
  sendTrialExpiredEmail.mockResolvedValue({ messageId: "synthetic-mail-receipt" });
  sendTrackingNumberReleasedEmail.mockResolvedValue({ messageId: "synthetic-mail-receipt" });
});

describe("trial lifecycle branch hardening", () => {
  test("fails before Stripe when the selected plan has no configured price", async () => {
    getPriceIdByPlan.mockReturnValue(null);

    await expect(createSubscriptionCheckout(checkoutInput())).rejects.toMatchObject({
      code: "STRIPE_PRICE_NOT_CONFIGURED",
    });

    expect(getStripeClient).not.toHaveBeenCalled();
  });

  test.each([
    ["trialing", "TRIAL_ALREADY_ACTIVE"],
    ["active", "SUBSCRIPTION_ALREADY_ACTIVE"],
  ])("blocks duplicate full-access checkout state %s", async (status, code) => {
    Subscription.findOne.mockResolvedValue({ status });
    getSubscriptionAccess.mockReturnValue({ level: "full", status, reason: "full" });

    await expect(createSubscriptionCheckout(checkoutInput())).rejects.toMatchObject({ code });
    expect(getStripeClient).not.toHaveBeenCalled();
  });

  test.each([
    [{ eligible: false, reason: "disposable_email" }, "TRIAL_EMAIL_NOT_ELIGIBLE"],
    [{ eligible: false, reason: "already_redeemed" }, "TRIAL_ALREADY_USED"],
  ])("maps trial ineligibility to a stable domain error", async (eligibility, code) => {
    getTrialEligibility.mockResolvedValue(eligibility);

    await expect(createSubscriptionCheckout(checkoutInput())).rejects.toMatchObject({ code });
  });

  test("enforces daily trial activation capacity", async () => {
    process.env.TRIAL_MAX_NEW_TRIALS_PER_DAY = "1";
    process.env.TRIAL_MAX_CONCURRENT_ACTIVE = "20";
    process.env.TRIAL_MAX_TRACKING_NUMBERS_HELD = "20";
    Subscription.countDocuments
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    await expect(createSubscriptionCheckout(checkoutInput())).rejects.toMatchObject({
      code: "TRIAL_DAILY_CAPACITY_REACHED",
    });
  });

  test("enforces concurrent active-trial capacity", async () => {
    process.env.TRIAL_MAX_NEW_TRIALS_PER_DAY = "10";
    process.env.TRIAL_MAX_CONCURRENT_ACTIVE = "1";
    process.env.TRIAL_MAX_TRACKING_NUMBERS_HELD = "20";
    Subscription.countDocuments
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);

    await expect(createSubscriptionCheckout(checkoutInput())).rejects.toMatchObject({
      code: "TRIAL_CONCURRENT_CAPACITY_REACHED",
    });
  });

  test("enforces trial tracking-number inventory capacity", async () => {
    process.env.TRIAL_MAX_NEW_TRIALS_PER_DAY = "10";
    process.env.TRIAL_MAX_CONCURRENT_ACTIVE = "20";
    process.env.TRIAL_MAX_TRACKING_NUMBERS_HELD = "2";
    Subscription.countDocuments
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);

    await expect(createSubscriptionCheckout(checkoutInput())).rejects.toMatchObject({
      code: "TRIAL_NUMBER_INVENTORY_CAPACITY_REACHED",
    });
  });

  test("fails closed when Stripe checkout is unavailable", async () => {
    getStripeClient.mockReturnValue(null);

    await expect(createSubscriptionCheckout(checkoutInput())).rejects.toMatchObject({
      code: "STRIPE_NOT_CONFIGURED",
    });
  });

  // Behavioral persistence contract: tests/integration/checkoutCompletion.rootCause.test.js.

  // Behavioral persistence contract: tests/integration/checkoutCompletion.rootCause.test.js.

  test.each([
    [null, "welcome"],
    [{ _id: "sub-1" }, "not-a-kind"],
  ])("returns false for un-sendable lifecycle messages", async (subscription, kind) => {
    await expect(sendTrialLifecycleMessage(subscription, kind)).resolves.toBe(false);
  });

  test("does not resend a lifecycle email already marked sent", async () => {
    await expect(
      sendTrialLifecycleMessage(
        { _id: "sub-1", business: "biz-1", trialWelcomeSentAt: new Date() },
        "welcome",
      ),
    ).resolves.toBe(false);

    expect(Business.findById).not.toHaveBeenCalled();
  });

  test("does not send lifecycle mail when the business is missing", async () => {
    Business.findById.mockReturnValue(populated(null));

    await expect(
      sendTrialLifecycleMessage({ _id: "sub-1", business: "biz-1" }, "welcome"),
    ).resolves.toBe(false);
  });

  test("does not send lifecycle mail without a recipient address", async () => {
    Business.findById.mockReturnValue(
      populated({ _id: "biz-1", email: "", owner: { email: "" } }),
    );

    await expect(
      sendTrialLifecycleMessage({ _id: "sub-1", business: "biz-1" }, "welcome"),
    ).resolves.toBe(false);
  });

  test.each([
    ["welcome", "trialWelcomeSentAt", sendTrialWelcomeEmail, null],
    ["three_day", "trialReminder3dSentAt", sendTrialReminderEmail, 3],
    ["one_day", "trialReminder1dSentAt", sendTrialReminderEmail, 1],
    ["expired", "trialExpiredNotifiedAt", sendTrialExpiredEmail, null],
    ["number_released", "trialNumberReleasedNotifiedAt", sendTrackingNumberReleasedEmail, null],
  ])("dispatches %s through the matching mailer and records it", async (kind, field, mailer, days) => {
    Business.findById.mockReturnValue(
      populated({
        _id: "biz-1",
        businessName: "Atlanta Pro Plumbing & Drain",
        email: "",
        owner: { email: "owner@example.com" },
      }),
    );
    const subscription = {
      _id: "sub-1",
      business: "biz-1",
      trialEndsAt: new Date(Date.now() + 86400000),
    };

    await expect(sendTrialLifecycleMessage(subscription, kind)).resolves.toBe(true);

    expect(mailer).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "owner@example.com",
        businessName: "Atlanta Pro Plumbing & Drain",
        ...(days ? { daysRemaining: days } : {}),
      }),
    );
    expect(Subscription.updateOne).toHaveBeenCalledWith(
      { _id: "sub-1", business: "biz-1", [field]: null },
      { $set: { [field]: expect.any(Date) } },
    );
  });

  // Contract moved to real MongoDB: tests/integration/trialExtension.contract.test.js.

  // Contract moved to real MongoDB: tests/integration/trialExtension.contract.test.js.

  // Contract moved to real MongoDB: tests/integration/trialExtension.contract.test.js.

  // Contract moved to real MongoDB: tests/integration/trialExtension.contract.test.js.

  test("syncCheckoutSession exits safely when Stripe has not attached a subscription", async () => {
    await expect(
      syncCheckoutSession({ id: "cs_pending", subscription: null, metadata: {} }),
    ).resolves.toBeNull();

    expect(getStripeClient().subscriptions.retrieve).not.toHaveBeenCalled();
  });

  test("syncStripeSubscription ignores remote subscriptions without a business identity", async () => {
    await expect(
      syncStripeSubscription({
        stripeSubscription: {
          id: "sub_orphan",
          status: "active",
          customer: "cus_1",
          metadata: {},
        },
        refreshFromStripe: false,
      }),
    ).resolves.toBeNull();

    expect(Business.findById).not.toHaveBeenCalled();
  });
});
