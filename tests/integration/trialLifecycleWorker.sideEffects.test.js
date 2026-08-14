jest.setTimeout(30000);

import request from "supertest";

import app from "../../src/app.js";
import Business from "../../src/models/business.js";
import Subscription from "../../src/models/subscription.js";
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
    __esModule: true,
    ...actual,
    provisionTrackingNumber: jest.fn(),
    releaseTrackingNumber: jest.fn(),
  };
});

jest.mock("../../src/helpers/email/mailer.js", () => {
  const actual = jest.requireActual("../../src/helpers/email/mailer.js");
  return {
    __esModule: true,
    ...actual,
    sendTrialWelcomeEmail: jest.fn(),
    sendTrialReminderEmail: jest.fn(),
    sendTrialExpiredEmail: jest.fn(),
    sendTrackingNumberReleasedEmail: jest.fn(),
  };
});

import {
  provisionTrackingNumber,
  releaseTrackingNumber,
} from "../../src/services/trackingNumberProvisioning.service.js";
import {
  sendTrialWelcomeEmail,
  sendTrialReminderEmail,
  sendTrialExpiredEmail,
  sendTrackingNumberReleasedEmail,
} from "../../src/helpers/email/mailer.js";
import { runTrialLifecycleOnce } from "../../src/workers/trialLifecycle.worker.js";

const mockProvisionTrackingNumber = provisionTrackingNumber;
const mockReleaseTrackingNumber = releaseTrackingNumber;
const mockSendTrialWelcomeEmail = sendTrialWelcomeEmail;
const mockSendTrialReminderEmail = sendTrialReminderEmail;
const mockSendTrialExpiredEmail = sendTrialExpiredEmail;
const mockSendTrackingNumberReleasedEmail = sendTrackingNumberReleasedEmail;

describe("trialLifecycle.worker real lifecycle side effects", () => {
  beforeAll(connectTestDB);

  beforeEach(() => {
    jest.clearAllMocks();
    mockProvisionTrackingNumber.mockResolvedValue(null);
    mockReleaseTrackingNumber.mockImplementation(async (businessId) => ({
      _id: businessId,
      trackingNumber: { status: "released" },
    }));
    mockSendTrialWelcomeEmail.mockResolvedValue(true);
    mockSendTrialReminderEmail.mockResolvedValue(true);
    mockSendTrialExpiredEmail.mockResolvedValue(true);
    mockSendTrackingNumberReleasedEmail.mockResolvedValue(true);
  });

  afterEach(clearTestDB);
  afterAll(closeTestDB);

  test("expired trial is reconciled, access is removed, then a due number is released", async () => {
    const registration = await request(app)
      .post("/api/auth/register")
      .send({
        userName: "trialsideeffects",
        email: "trial.side.effects@example.com",
        password: "Password123",
        businessName: "Lifecycle Plumbing",
        businessPhone: "4045558181",
        businessType: "plumbing",
        smsConsent: true,
        termsAccepted: true,
        privacyAccepted: true,
      });
    expect(registration.status).toBe(201);
    const { business, user } = registration.body.data;

    const now = new Date("2026-08-14T16:00:00.000Z");
    const trialStart = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000);
    const trialEnd = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const dueReleaseAt = new Date(now.getTime() - 60 * 1000);

    await Business.findByIdAndUpdate(business._id, {
      $set: {
        phone: "+16785558181",
        phoneLookup: "+16785558181",
        "trackingNumber.status": "active",
        "trialCostControls.enabled": true,
        "setupProgress.subscriptionActivated": true,
      },
    });

    await Subscription.findOneAndUpdate(
      { business: business._id },
      {
        $set: {
          stripeCustomerId: "cus_lifecycle_side_effects",
          stripeSubscriptionId: "sub_lifecycle_side_effects",
          status: "trialing",
          lastPaymentStatus: "trialing",
          plan: "pro",
          trialStartedAt: trialStart,
          trialEndsAt: trialEnd,
          trialUsedAt: trialStart,
          trialCount: 1,
          currentPeriodStart: trialStart,
          currentPeriodEnd: trialEnd,
          trialNumberReleaseAt: dueReleaseAt,
          isActive: true,
          aiEnabled: true,
        },
      },
      { upsert: true, returnDocument: "after" },
    );

    const remoteCanceled = {
      id: "sub_lifecycle_side_effects",
      customer: "cus_lifecycle_side_effects",
      status: "canceled",
      trial_start: Math.floor(trialStart.getTime() / 1000),
      trial_end: Math.floor(trialEnd.getTime() / 1000),
      current_period_start: Math.floor(trialStart.getTime() / 1000),
      current_period_end: Math.floor(trialEnd.getTime() / 1000),
      cancel_at_period_end: false,
      metadata: {
        businessId: String(business._id),
        ownerId: String(user._id),
        plan: "pro",
      },
      items: { data: [{ price: { id: "price_pro_test" } }] },
      latest_invoice: null,
    };
    const retrieve = jest.fn().mockResolvedValue(remoteCanceled);
    getStripeClient.mockReturnValue({
      subscriptions: {
        retrieve,
        cancel: jest.fn().mockResolvedValue(remoteCanceled),
      },
    });

    await expect(runTrialLifecycleOnce()).resolves.toEqual({ processed: 1 });

    const stored = await Subscription.findOne({ business: business._id });
    const storedBusiness = await Business.findById(business._id);

    expect(stored.status).toBe("canceled");
    expect(stored.isActive).toBe(false);
    expect(stored.aiEnabled).toBe(false);
    expect(stored.trialNumberReleaseAt).toBeNull();
    expect(stored.trialExpiredNotifiedAt).toBeTruthy();
    expect(stored.trialNumberReleasedNotifiedAt).toBeTruthy();

    // Business.isActive is intentionally an account/suspension flag and remains true.
    expect(storedBusiness.isActive).toBe(true);
    expect(storedBusiness.trialCostControls.enabled).toBe(false);
    expect(storedBusiness.setupProgress.subscriptionActivated).toBe(false);

    expect(retrieve).toHaveBeenCalled();
    expect(mockProvisionTrackingNumber).not.toHaveBeenCalled();
    expect(String(mockReleaseTrackingNumber.mock.calls[0][0])).toBe(
      String(business._id),
    );
    expect(mockSendTrialExpiredEmail).toHaveBeenCalledTimes(1);
    expect(mockSendTrackingNumberReleasedEmail).toHaveBeenCalledTimes(1);
  });
});
