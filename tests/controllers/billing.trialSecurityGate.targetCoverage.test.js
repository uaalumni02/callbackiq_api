const mockAssertTrialIdentityVerified = jest.fn();
const mockSecurityGateEnabled = jest.fn();
const mockEnforceTrialActivationRisk = jest.fn();
const mockVerifyTurnstileToken = jest.fn();

jest.mock("../../src/db/db.js", () => ({
  __esModule: true,
  default: {
    getBusinessByOwner: jest.fn(),
    upsertSubscriptionByBusiness: jest.fn(),
  },
}));

jest.mock("../../src/models/business.js", () => ({
  __esModule: true,
  default: {
    findById: jest.fn(),
    findOne: jest.fn(),
    findByIdAndUpdate: jest.fn(),
  },
}));

jest.mock("../../src/models/subscription.js", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    updateOne: jest.fn(),
  },
}));

jest.mock("../../src/models/trialRedemption.js", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("../../src/validator/billing.js", () => ({
  checkoutSchema: { validateAsync: jest.fn() },
}));

jest.mock("../../src/helpers/stripe/stripeClient.js", () => ({
  getStripeClient: jest.fn(),
  getPriceIdByPlan: jest.fn(),
}));

jest.mock("../../src/helpers/response/response.js", () => ({
  responseBadAuth: jest.fn((res, message = "Unauthorized") =>
    res.status(401).json({ success: false, message }),
  ),
  responseInvalidInput: jest.fn((res, message = "Invalid input") =>
    res.status(400).json({ success: false, message }),
  ),
  responseOk: jest.fn((res, data, message = "OK") =>
    res.status(200).json({ success: true, data, message }),
  ),
  responseServerError: jest.fn((res, message = "Server error") =>
    res.status(500).json({ success: false, message }),
  ),
}));

jest.mock("../../src/services/trialLifecycle.service.js", () => ({
  createSubscriptionCheckout: jest.fn(),
  extendTrialByAdmin: jest.fn(),
  sendTrialLifecycleMessage: jest.fn(),
  syncCheckoutSession: jest.fn(),
  syncStripeSubscription: jest.fn(),
}));

jest.mock("../../src/helpers/billing/trial.js", () => ({
  getTrialEligibility: jest.fn(),
}));

jest.mock("../../src/services/billingEvent.service.js", () => ({
  processStripeEventOnce: jest.fn(),
}));

jest.mock("../../src/services/subscriptionActions.service.js", () => ({
  createTrialPaymentMethodCheckout: jest.fn(),
  completeTrialPaymentMethodCheckout: jest.fn(),
  resumeCanonicalSubscription: jest.fn(),
}));

jest.mock("../../src/services/subscriptionIntegrity.service.js", () => ({
  assertCanonicalIsOnlyLiveSubscription: jest.fn(),
  guardInvoiceAgainstCanonicalSubscription: jest.fn(),
}));

jest.mock("../../src/services/subscriptionAccess.service.js", () => ({
  ACCESS_LEVELS: { FULL: "full" },
  getSubscriptionAccess: jest.fn(),
}));

jest.mock("../../src/services/trialIdentityVerification.service.js", () => ({
  assertTrialIdentityVerified: (...args) => mockAssertTrialIdentityVerified(...args),
  securityGateEnabled: (...args) => mockSecurityGateEnabled(...args),
}));

jest.mock("../../src/services/trialRisk.service.js", () => ({
  enforceTrialActivationRisk: (...args) => mockEnforceTrialActivationRisk(...args),
}));

jest.mock("../../src/helpers/security/turnstile.js", () => ({
  verifyTurnstileToken: (...args) => mockVerifyTurnstileToken(...args),
}));

import BillingController from "../../src/controllers/billing.js";
import db from "../../src/db/db.js";
import {
  createSubscriptionCheckout,
} from "../../src/services/trialLifecycle.service.js";

const makeRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.send = jest.fn(() => res);
  return res;
};

const business = {
  _id: "biz-1",
  owner: "owner-1",
  businessName: "Atlanta Pro Plumbing & Drain",
  email: "owner@example.com",
  forwardingPhone: "+14045550999",
};

const makeReq = (overrides = {}) => ({
  user: { userId: "owner-1" },
  business,
  body: { onboarding: true, securityChallengeToken: "turnstile-test-token" },
  headers: {},
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockAssertTrialIdentityVerified.mockResolvedValue({ ready: true });
  mockSecurityGateEnabled.mockReturnValue(false);
  mockEnforceTrialActivationRisk.mockResolvedValue({ allowed: true });
  mockVerifyTurnstileToken.mockResolvedValue({ success: true });
  createSubscriptionCheckout.mockResolvedValue({
    checkoutUrl: "https://checkout.stripe.test/session",
    checkoutSessionId: "cs_test",
    trialOffered: true,
  });
});

describe("billing trial security gate target coverage", () => {
  test("requires an authenticated owner before running trial security gates", async () => {
    const res = makeRes();

    await BillingController.startFreeTrial(
      makeReq({ user: null }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockAssertTrialIdentityVerified).not.toHaveBeenCalled();
  });

  test("requires a business before running trial security gates", async () => {
    const res = makeRes();
    const req = makeReq({ business: null });
    db.getBusinessByOwner.mockResolvedValue(null);

    await BillingController.startFreeTrial(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockAssertTrialIdentityVerified).not.toHaveBeenCalled();
  });

  test("runs identity and risk gates when Turnstile is disabled", async () => {
    mockSecurityGateEnabled.mockReturnValue(false);
    const res = makeRes();

    await BillingController.startFreeTrial(makeReq(), res);

    expect(mockAssertTrialIdentityVerified).toHaveBeenCalledWith({
      ownerId: "owner-1",
      business,
    });
    expect(mockVerifyTurnstileToken).not.toHaveBeenCalled();
    expect(mockEnforceTrialActivationRisk).toHaveBeenCalledWith({ business });
    expect(createSubscriptionCheckout).toHaveBeenCalledWith({
      business,
      ownerId: "owner-1",
      plan: "pro",
      requireTrial: true,
      returnToSetup: true,
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test("rejects trial activation when the Turnstile challenge fails", async () => {
    mockSecurityGateEnabled.mockReturnValue(true);
    mockVerifyTurnstileToken.mockResolvedValue({ success: false });
    const res = makeRes();
    const req = makeReq();

    await BillingController.startFreeTrial(req, res);

    expect(mockVerifyTurnstileToken).toHaveBeenCalledWith(
      "turnstile-test-token",
      req,
      { expectedAction: "trial_activation" },
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      code: "TRIAL_SECURITY_CHALLENGE_REQUIRED",
      message: "Complete the security check before activating the free trial.",
    });
    expect(mockEnforceTrialActivationRisk).not.toHaveBeenCalled();
    expect(createSubscriptionCheckout).not.toHaveBeenCalled();
  });

  test("continues through risk checks after a successful Turnstile challenge", async () => {
    mockSecurityGateEnabled.mockReturnValue(true);
    mockVerifyTurnstileToken.mockResolvedValue({ success: true });
    const res = makeRes();

    await BillingController.startFreeTrial(makeReq(), res);

    expect(mockEnforceTrialActivationRisk).toHaveBeenCalledWith({ business });
    expect(createSubscriptionCheckout).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test.each([
    ["TRIAL_EMAIL_VERIFICATION_REQUIRED", 403, "Verify email"],
    ["TRIAL_PHONE_VERIFICATION_REQUIRED", 403, "Verify phone"],
    ["TRIAL_RISK_REJECTED", 429, "Try again later"],
  ])("maps domain security error %s to its status code", async (code, statusCode, message) => {
    const error = Object.assign(new Error(message), { code, statusCode });
    if (code === "TRIAL_RISK_REJECTED") {
      mockEnforceTrialActivationRisk.mockRejectedValue(error);
    } else {
      mockAssertTrialIdentityVerified.mockRejectedValue(error);
    }
    const res = makeRes();

    await BillingController.startFreeTrial(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(statusCode);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      code,
      message,
    });
    expect(createSubscriptionCheckout).not.toHaveBeenCalled();
  });
});
