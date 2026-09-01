const {
  getTwilioClient,
  numberLifecycleRank,
  resolveNumberLifecycleStatus,
  shouldIgnoreNumberLifecycleEvent,
  startA2pCustomerRegistration,
} = require("../../src/services/a2pCustomerOnboarding.service.js");

const validInput = (overrides = {}) => {
  const {
    contact: contactOverrides = {},
    campaign: campaignOverrides = {},
    ...topLevelOverrides
  } = overrides;

  return {
    registrationType: "low_volume_standard",
    legalBusinessName: "Atlanta Pro Plumbing",
    ...topLevelOverrides,
    contact: {
      email: "owner@example.com",
      phone: "+14045550123",
      firstName: "Alex",
      lastName: "Owner",
      ...contactOverrides,
    },
    campaign: {
      messageFlow:
        "Customers call the business and may opt in to receive missed-call recovery and customer-care SMS follow-up.",
      privacyPolicyUrl: "https://example.com/privacy",
      termsAndConditionsUrl: "https://example.com/terms",
      ...campaignOverrides,
    },
  };
};

describe("A2P onboarding lifecycle and validation - provider-free coverage", () => {
  test.each([
    ["number-registration.successful", "", "REGISTERED"],
    ["number-registration.pending", "", "PENDING_REGISTRATION"],
    ["number-registration.failed", "", "FAILURE"],
    ["number-deregistration.successful", "", "DEREGISTERED"],
    ["number-deregistration.pending", "", "PENDING_DEREGISTRATION"],
    ["number-deregistration.failure", "", "DEREGISTRATION_FAILED"],
    ["number-registration.pending", "REGISTERED", "REGISTERED"],
    ["unknown-event", "", "PENDING_REGISTRATION"],
  ])("resolves %s / %s to %s", (eventType, externalStatus, expected) => {
    expect(resolveNumberLifecycleStatus({ eventType, externalStatus })).toBe(expected);
  });

  test.each([
    ["DEREGISTERED", 100],
    ["DEREGISTRATION_FAILED", 96],
    ["PENDING_DEREGISTRATION", 95],
    ["FAILED", 90],
    ["FAILURE", 90],
    ["REGISTERED", 80],
    ["PENDING_REGISTRATION", 10],
  ])("ranks lifecycle state %s", (status, expected) => {
    expect(numberLifecycleRank(status)).toBe(expected);
  });

  test("rejects duplicate lifecycle events", () => {
    expect(
      shouldIgnoreNumberLifecycleEvent({
        lastEventId: "EV1",
        eventId: "EV1",
        lastEventAt: "2026-08-31T12:00:00Z",
        eventAt: "2026-08-31T12:01:00Z",
        lastEventRank: 80,
        eventRank: 100,
      }),
    ).toBe("duplicate");
  });

  test("rejects older and same-time lower-rank events", () => {
    expect(
      shouldIgnoreNumberLifecycleEvent({
        lastEventAt: "2026-08-31T12:00:00Z",
        eventAt: "2026-08-31T11:59:59Z",
        lastEventRank: 80,
        eventRank: 100,
      }),
    ).toBe("stale");

    expect(
      shouldIgnoreNumberLifecycleEvent({
        lastEventAt: 1_800_000_000,
        eventAt: 1_800_000_000,
        lastEventRank: 100,
        eventRank: 80,
      }),
    ).toBe("stale");
  });

  test("fails closed on malformed/missing timestamps that would downgrade state", () => {
    expect(
      shouldIgnoreNumberLifecycleEvent({
        lastEventRank: 100,
        eventRank: 10,
        eventAt: "not-a-date",
      }),
    ).toBe("stale");
  });

  test("accepts a newer stronger lifecycle event", () => {
    expect(
      shouldIgnoreNumberLifecycleEvent({
        lastEventAt: "2026-08-31T12:00:00Z",
        eventAt: "2026-08-31T12:01:00Z",
        lastEventRank: 80,
        eventRank: 100,
      }),
    ).toBe("");
  });

  test.each([
    [{ registrationType: "unsupported" }, "Unsupported A2P registration type"],
    [{ legalBusinessName: "" }, "Legal business name is required"],
    [{ contact: { email: "invalid" } }, "A valid business contact email is required"],
    [{ contact: { phone: "123" } }, "A valid business contact phone is required"],
    [{ campaign: { messageFlow: "too short" } }, "Describe how customers consent"],
    [{ campaign: { privacyPolicyUrl: "javascript:alert(1)" } }, "A valid customer Privacy Policy URL is required"],
    [{ campaign: { termsAndConditionsUrl: "not-a-url" } }, "A valid customer Terms & Conditions URL is required"],
  ])("rejects invalid onboarding input without calling Twilio: %j", async (overrides, message) => {
    await expect(
      startA2pCustomerRegistration({
        businessId: "business-test",
        input: validInput(overrides),
        client: { shouldNeverBeUsed: true },
      }),
    ).rejects.toThrow(message);
  });

  test("getTwilioClient fails before provider creation when required credentials are absent", () => {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    try {
      expect(() => getTwilioClient()).toThrow(
        "TWILIO_ACCOUNT_SID is required for automated A2P onboarding.",
      );
    } finally {
      if (sid === undefined) delete process.env.TWILIO_ACCOUNT_SID;
      else process.env.TWILIO_ACCOUNT_SID = sid;
      if (token === undefined) delete process.env.TWILIO_AUTH_TOKEN;
      else process.env.TWILIO_AUTH_TOKEN = token;
    }
  });
});
