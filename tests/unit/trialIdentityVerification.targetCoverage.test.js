const mockTwilio = jest.fn();
const mockSendEmailVerificationEmail = jest.fn();
const mockNormalizePhoneToE164 = jest.fn((value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
});

jest.mock("twilio", () => ({
  __esModule: true,
  default: (...args) => mockTwilio(...args),
}));

jest.mock("../../src/models/business.js", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
    updateOne: jest.fn(),
  },
}));

jest.mock("../../src/models/user.js", () => ({
  __esModule: true,
  default: {
    findById: jest.fn(),
    findOne: jest.fn(),
    updateOne: jest.fn(),
  },
}));

jest.mock("../../src/helpers/email/mailer.js", () => ({
  sendEmailVerificationEmail: (...args) => mockSendEmailVerificationEmail(...args),
}));

jest.mock("../../src/voice/voicePhone.service.js", () => ({
  normalizePhoneToE164: (...args) => mockNormalizePhoneToE164(...args),
}));

import Business from "../../src/models/business.js";
import User from "../../src/models/user.js";
import {
  assertTrialIdentityVerified,
  checkForwardingPhoneVerification,
  getTrialIdentityVerificationStatus,
  issueEmailVerification,
  resendEmailVerification,
  securityGateEnabled,
  startForwardingPhoneVerification,
  verifyEmailToken,
} from "../../src/services/trialIdentityVerification.service.js";

const selected = (value) => ({
  select: jest.fn().mockResolvedValue(value),
});

const makeUser = (overrides = {}) => ({
  _id: "owner-1",
  email: "owner@example.com",
  emailVerifiedAt: null,
  ...overrides,
});

const makeBusiness = (overrides = {}) => ({
  _id: "biz-1",
  owner: "owner-1",
  forwardingPhone: "+14045550123",
  forwardingPhoneVerifiedAt: null,
  forwardingPhoneVerifiedValue: "",
  ...overrides,
});

const makeVerifyClient = ({ verificationStatus = "pending", checkStatus = "approved" } = {}) => {
  const verificationCreate = jest.fn().mockResolvedValue({ status: verificationStatus });
  const verificationCheckCreate = jest.fn().mockResolvedValue({ status: checkStatus });
  const services = jest.fn(() => ({
    verifications: { create: verificationCreate },
    verificationChecks: { create: verificationCheckCreate },
  }));

  return {
    client: { verify: { v2: { services } } },
    services,
    verificationCreate,
    verificationCheckCreate,
  };
};

const setVerifyEnvironment = () => {
  Object.assign(process.env, {
    TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
    TWILIO_VERIFY_SERVICE_SID: "VA00000000000000000000000000000000",
  });
  process.env.TWILIO_AUTH_TOKEN = ["AUTH", "TEST", "TOKEN"].join("_");
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.NODE_ENV = "test";

  delete process.env.TRIAL_REQUIRE_EMAIL_VERIFICATION;
  delete process.env.TRIAL_REQUIRE_PHONE_VERIFICATION;
  delete process.env.TRIAL_TURNSTILE_REQUIRED;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_VERIFY_SERVICE_SID;

  User.updateOne.mockResolvedValue({ modifiedCount: 1 });
  Business.updateOne.mockResolvedValue({ modifiedCount: 1 });
  mockSendEmailVerificationEmail.mockResolvedValue(true);
});

afterAll(() => {
  process.env.NODE_ENV = "test";
});

describe("trial identity verification target coverage", () => {
  test("security gates honor explicit values and production defaults", () => {
    process.env.TEST_GATE = "true";
    expect(securityGateEnabled("TEST_GATE")).toBe(true);

    process.env.TEST_GATE = "false";
    expect(securityGateEnabled("TEST_GATE")).toBe(false);

    delete process.env.TEST_GATE;
    process.env.NODE_ENV = "production";
    expect(securityGateEnabled("TEST_GATE")).toBe(true);
    expect(
      securityGateEnabled("TEST_GATE", { productionDefault: false }),
    ).toBe(false);
  });

  test("email verification requires a valid account email", async () => {
    await expect(issueEmailVerification({ user: null })).rejects.toMatchObject({
      code: "EMAIL_VERIFICATION_ACCOUNT_REQUIRED",
      statusCode: 409,
    });
  });

  test("does not resend verification for an already verified email", async () => {
    await expect(
      issueEmailVerification({
        user: makeUser({ emailVerifiedAt: new Date("2026-08-20T00:00:00Z") }),
      }),
    ).resolves.toEqual({ sent: false, alreadyVerified: true });

    expect(User.updateOne).not.toHaveBeenCalled();
    expect(mockSendEmailVerificationEmail).not.toHaveBeenCalled();
  });

  test("issues, stores, and emails a short-lived verification token", async () => {
    const result = await issueEmailVerification({ user: makeUser() });

    expect(result.sent).toBe(true);
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.verificationToken).toEqual(expect.any(String));
    expect(result.verificationToken.length).toBeGreaterThan(20);
    expect(User.updateOne).toHaveBeenCalledWith(
      { _id: "owner-1" },
      {
        $set: {
          emailVerificationTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          emailVerificationExpiresAt: expect.any(Date),
        },
      },
    );
    expect(mockSendEmailVerificationEmail).toHaveBeenCalledWith({
      email: "owner@example.com",
      token: result.verificationToken,
    });
  });

  test("resend rejects a missing owner and delegates for an existing owner", async () => {
    User.findById.mockResolvedValueOnce(null);
    await expect(resendEmailVerification("missing")).rejects.toMatchObject({
      code: "USER_NOT_FOUND",
      statusCode: 404,
    });

    User.findById.mockResolvedValueOnce(makeUser());
    await expect(resendEmailVerification("owner-1")).resolves.toMatchObject({
      sent: true,
    });
    expect(mockSendEmailVerificationEmail).toHaveBeenCalled();
  });

  test.each(["", "x".repeat(513)])(
    "rejects malformed email verification token %p",
    async (token) => {
      await expect(verifyEmailToken(token)).rejects.toMatchObject({
        code: "EMAIL_VERIFICATION_TOKEN_INVALID",
        statusCode: 400,
      });
      expect(User.findOne).not.toHaveBeenCalled();
    },
  );

  test("rejects an unknown or expired email verification token", async () => {
    User.findOne.mockReturnValue(selected(null));

    await expect(verifyEmailToken("valid-looking-token")).rejects.toMatchObject({
      code: "EMAIL_VERIFICATION_TOKEN_INVALID",
    });
  });

  test("verifies a valid email token and clears one-time token state", async () => {
    User.findOne.mockReturnValue(selected(makeUser()));

    const result = await verifyEmailToken("valid-looking-token");

    expect(result).toMatchObject({ emailVerified: true });
    expect(result.emailVerifiedAt).toBeInstanceOf(Date);
    expect(User.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "owner-1" }),
      expect.objectContaining({
        $set: { emailVerifiedAt: expect.any(Date) },
        $unset: {
          emailVerificationTokenHash: 1,
          emailVerificationExpiresAt: 1,
        },
      }),
    );
  });

  test("phone verification requires both an owner and business", async () => {
    User.findById.mockResolvedValue(null);
    Business.findOne.mockResolvedValue(makeBusiness());

    await expect(
      startForwardingPhoneVerification({ ownerId: "owner-1" }),
    ).rejects.toMatchObject({ code: "USER_NOT_FOUND", statusCode: 404 });

    User.findById.mockResolvedValue(makeUser());
    Business.findOne.mockResolvedValue(null);

    await expect(
      startForwardingPhoneVerification({ ownerId: "owner-1" }),
    ).rejects.toMatchObject({ code: "BUSINESS_NOT_FOUND", statusCode: 404 });
  });

  test("phone verification requires a valid forwarding phone", async () => {
    User.findById.mockResolvedValue(makeUser());
    Business.findOne.mockResolvedValue(makeBusiness({ forwardingPhone: "" }));

    await expect(
      startForwardingPhoneVerification({ ownerId: "owner-1" }),
    ).rejects.toMatchObject({ code: "FORWARDING_PHONE_REQUIRED" });
  });

  test("phone verification fails closed when Twilio Verify is not configured", async () => {
    User.findById.mockResolvedValue(makeUser());
    Business.findOne.mockResolvedValue(makeBusiness());

    await expect(
      startForwardingPhoneVerification({ ownerId: "owner-1" }),
    ).rejects.toMatchObject({
      code: "PHONE_VERIFICATION_NOT_CONFIGURED",
      statusCode: 503,
    });
  });

  test.each([
    ["call", "call"],
    ["anything-else", "sms"],
  ])("starts %s verification through the safe %s channel", async (requested, expected) => {
    setVerifyEnvironment();
    User.findById.mockResolvedValue(makeUser());
    Business.findOne.mockResolvedValue(makeBusiness());
    const verifyState = makeVerifyClient();
    mockTwilio.mockReturnValue(verifyState.client);

    const result = await startForwardingPhoneVerification({
      ownerId: "owner-1",
      channel: requested,
    });

    expect(result).toEqual({
      status: "pending",
      channel: expected,
      phoneLast4: "0123",
    });
    expect(verifyState.verificationCreate).toHaveBeenCalledWith({
      to: "+14045550123",
      channel: expected,
    });
  });

  test("verification check validates the forwarding phone and code before Twilio", async () => {
    User.findById.mockResolvedValue(makeUser());
    Business.findOne.mockResolvedValue(makeBusiness({ forwardingPhone: "" }));

    await expect(
      checkForwardingPhoneVerification({ ownerId: "owner-1", code: "123456" }),
    ).rejects.toMatchObject({ code: "FORWARDING_PHONE_REQUIRED" });

    Business.findOne.mockResolvedValue(makeBusiness());
    await expect(
      checkForwardingPhoneVerification({ ownerId: "owner-1", code: "12ab" }),
    ).rejects.toMatchObject({ code: "PHONE_VERIFICATION_CODE_INVALID" });
  });

  test("verification check rejects a Twilio result that is not approved", async () => {
    setVerifyEnvironment();
    User.findById.mockResolvedValue(makeUser());
    Business.findOne.mockResolvedValue(makeBusiness());
    const verifyState = makeVerifyClient({ checkStatus: "pending" });
    mockTwilio.mockReturnValue(verifyState.client);

    await expect(
      checkForwardingPhoneVerification({ ownerId: "owner-1", code: "123456" }),
    ).rejects.toMatchObject({ code: "PHONE_VERIFICATION_FAILED" });
  });

  test("approved verification persists the exact normalized forwarding phone", async () => {
    setVerifyEnvironment();
    User.findById.mockResolvedValue(makeUser());
    Business.findOne.mockResolvedValue(makeBusiness());
    const verifyState = makeVerifyClient({ checkStatus: "approved" });
    mockTwilio.mockReturnValue(verifyState.client);

    const result = await checkForwardingPhoneVerification({
      ownerId: "owner-1",
      code: "123456",
    });

    expect(result).toMatchObject({ phoneVerified: true, phoneLast4: "0123" });
    expect(result.forwardingPhoneVerifiedAt).toBeInstanceOf(Date);
    expect(Business.updateOne).toHaveBeenCalledWith(
      { _id: "biz-1", owner: "owner-1" },
      {
        $set: {
          forwardingPhoneVerifiedAt: expect.any(Date),
          forwardingPhoneVerifiedValue: "+14045550123",
        },
      },
    );
  });

  test("status reports mismatched phone verification as not ready", async () => {
    process.env.TRIAL_REQUIRE_EMAIL_VERIFICATION = "true";
    process.env.TRIAL_REQUIRE_PHONE_VERIFICATION = "true";
    process.env.TRIAL_TURNSTILE_REQUIRED = "true";

    User.findById.mockResolvedValue(makeUser());
    Business.findOne.mockResolvedValue(
      makeBusiness({
        forwardingPhoneVerifiedAt: new Date("2026-08-20T00:00:00Z"),
        forwardingPhoneVerifiedValue: "+14045559999",
      }),
    );

    await expect(
      getTrialIdentityVerificationStatus("owner-1"),
    ).resolves.toEqual(
      expect.objectContaining({
        emailVerified: false,
        phoneVerified: false,
        forwardingPhoneVerifiedAt: null,
        phoneLast4: "0123",
        requirements: { email: true, phone: true, turnstile: true },
        ready: false,
      }),
    );
  });

  test("status is ready when required identity factors match", async () => {
    process.env.TRIAL_REQUIRE_EMAIL_VERIFICATION = "true";
    process.env.TRIAL_REQUIRE_PHONE_VERIFICATION = "true";

    const verifiedAt = new Date("2026-08-20T00:00:00Z");
    User.findById.mockResolvedValue(makeUser({ emailVerifiedAt: verifiedAt }));
    Business.findOne.mockResolvedValue(
      makeBusiness({
        forwardingPhoneVerifiedAt: verifiedAt,
        forwardingPhoneVerifiedValue: "+14045550123",
      }),
    );

    await expect(
      getTrialIdentityVerificationStatus("owner-1"),
    ).resolves.toMatchObject({
      emailVerified: true,
      phoneVerified: true,
      ready: true,
    });
  });

  test("assertion rejects missing identity inputs", async () => {
    await expect(
      assertTrialIdentityVerified({ ownerId: "", business: null }),
    ).rejects.toMatchObject({ code: "TRIAL_IDENTITY_REQUIRED", statusCode: 400 });
  });

  test("assertion enforces email and phone verification independently", async () => {
    process.env.TRIAL_REQUIRE_EMAIL_VERIFICATION = "true";
    process.env.TRIAL_REQUIRE_PHONE_VERIFICATION = "false";
    User.findById.mockResolvedValue(makeUser());
    Business.findOne.mockResolvedValue(makeBusiness());

    await expect(
      assertTrialIdentityVerified({ ownerId: "owner-1", business: makeBusiness() }),
    ).rejects.toMatchObject({ code: "TRIAL_EMAIL_VERIFICATION_REQUIRED", statusCode: 403 });

    process.env.TRIAL_REQUIRE_EMAIL_VERIFICATION = "false";
    process.env.TRIAL_REQUIRE_PHONE_VERIFICATION = "true";

    await expect(
      assertTrialIdentityVerified({ ownerId: "owner-1", business: makeBusiness() }),
    ).rejects.toMatchObject({ code: "TRIAL_PHONE_VERIFICATION_REQUIRED", statusCode: 403 });
  });

  test("assertion returns verified status when configured requirements are satisfied", async () => {
    process.env.TRIAL_REQUIRE_EMAIL_VERIFICATION = "true";
    process.env.TRIAL_REQUIRE_PHONE_VERIFICATION = "true";
    const verifiedAt = new Date("2026-08-20T00:00:00Z");
    User.findById.mockResolvedValue(makeUser({ emailVerifiedAt: verifiedAt }));
    Business.findOne.mockResolvedValue(
      makeBusiness({
        forwardingPhoneVerifiedAt: verifiedAt,
        forwardingPhoneVerifiedValue: "+14045550123",
      }),
    );

    await expect(
      assertTrialIdentityVerified({ ownerId: "owner-1", business: makeBusiness() }),
    ).resolves.toMatchObject({ ready: true });
  });
});
