const A2pCustomerRegistration = require("../../src/models/a2pCustomerRegistration.js").default;
const a2p = require("../../src/services/a2pCustomerOnboarding.service.js");

const { toPublicA2pRegistration, getRegistrationWithSecrets } = a2p;

describe("a2pCustomerOnboarding public-state target coverage", () => {
  test("null registration produces safe not-started state", () => {
    expect(toPublicA2pRegistration(null)).toMatchObject({
      status: "not_started",
      registrationType: "low_volume_standard",
      smsReady: false,
      canActivateTrial: false,
      otpRequired: false,
    });
  });

  test.each([
    ["not_started", false],
    ["action_required", false],
    ["failed", false],
    ["draft", true],
    ["submitting", true],
    ["pending", true],
    ["ready", true],
  ])("activation readiness for status %s is %s", (status, expected) => {
    const result = toPublicA2pRegistration({
      status,
      registrationType: "low_volume_standard",
      numberStatus: "PENDING",
    });
    expect(result.canActivateTrial).toBe(expected);
  });

  test.each([
    ["otp_required", true],
    ["pending", false],
    ["ready", false],
    ["failed", false],
  ])("OTP requirement for %s", (status, expected) => {
    expect(
      toPublicA2pRegistration({
        status,
        registrationType: "sole_proprietor",
        numberStatus: "PENDING",
      }).otpRequired,
    ).toBe(expected);
  });

  test.each([
    ["ready", "REGISTERED", true],
    ["ready", "registered", true],
    ["ready", "PENDING", false],
    ["pending", "REGISTERED", false],
    ["failed", "REGISTERED", false],
  ])("SMS readiness status=%s number=%s", (status, numberStatus, expected) => {
    const result = toPublicA2pRegistration({
      status,
      numberStatus,
      registrationType: "standard",
    });
    expect(result.smsReady).toBe(expected);
  });

  test("public state does not leak known secret-bearing properties", () => {
    const result = toPublicA2pRegistration({
      _id: "reg-1",
      business: "biz-1",
      status: "pending",
      registrationType: "standard",
      numberStatus: "PENDING",
      ein: "123456789",
      otpCode: "123456",
      twilioAuthToken: "secret",
      customerProfileBundleSid: "BU123",
      brandSid: "BN123",
      campaignSid: "QE123",
    });

    expect(result.ein).toBeUndefined();
    expect(result.otpCode).toBeUndefined();
    expect(result.twilioAuthToken).toBeUndefined();
    expect(result).toEqual(
      expect.objectContaining({
        status: "pending",
        registrationType: "standard",
      }),
    );
  });

  test("document serialization replaces raw provider errors with public guidance", () => {
    const providerError = "Provider rejected profile BU-private: private contact details";
    const toObject = jest.fn(() => ({
      status: "failed",
      registrationType: "standard",
      numberStatus: "PENDING",
      lastError: providerError,
      customerProfileSid: "BU-private",
      brandSid: "BN-private",
      ein: "123456789",
      otpCode: "123456",
    }));

    const result = toPublicA2pRegistration({ toObject });

    expect(toObject).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "failed",
      registrationType: "standard",
      smsReady: false,
      canActivateTrial: false,
      otpRequired: false,
      lastError: "Messaging registration needs attention. Review your details and try again, or contact support.",
    });
    for (const field of ["customerProfileSid", "brandSid", "ein", "otpCode"]) {
      expect(result).not.toHaveProperty(field);
    }
    expect(JSON.stringify(result)).not.toContain(providerError);
  });

  test("internal secret lookup stays scoped to the requested business", () => {
    const query = {};
    const select = jest.fn().mockReturnValue(query);
    const findOne = jest.spyOn(A2pCustomerRegistration, "findOne")
      .mockReturnValue({ select });
    try {
      expect(getRegistrationWithSecrets("business-private")).toBe(query);
      expect(findOne).toHaveBeenCalledTimes(1);
      expect(findOne).toHaveBeenCalledWith({ business: "business-private" });
      expect(select).toHaveBeenCalledWith(
        "+customerProfileSid +businessEndUserSid +authorizedRepresentativeSid +addressSid +addressDocumentSid +trustProductSid +messagingProfileEndUserSid +brandSid +messagingServiceSid +campaignSid",
      );
    } finally {
      findOne.mockRestore();
    }
  });

  test("getRegistrationWithSecrets is exported for internal onboarding workflows", () => {
    expect(typeof getRegistrationWithSecrets).toBe("function");
  });
});
