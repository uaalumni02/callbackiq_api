import { requirePaidServiceReady } from "../../src/services/billing/paidReadiness.service.js";
import { normalizeSafetyLanguage } from "../../src/helpers/ai/safetyLanguage.js";
import { buildRegistrationCampaign } from "../../src/services/a2pRegistrationInput.policy.js";
import voiceProviderEntitlement from "../../src/middleware/voice-provider-entitlement.js";
import { resolveTwilioNumberContext } from "../../src/services/twilioBusinessResolver.service.js";
import { readProviderEntitlement } from "../../src/services/providerEntitlement.service.js";
jest.mock("../../src/services/twilioBusinessResolver.service.js", () => ({
  resolveTwilioNumberContext: jest.fn(),
}));
jest.mock("../../src/services/providerEntitlement.service.js", () => ({
  readProviderEntitlement: jest.fn(),
}));
const ready = () => ({
  isActive: true,
  forwardingPhone: "+14045550100",
  forwardingPhoneVerifiedValue: "+14045550100",
  forwardingPhoneVerifiedAt: new Date(),
  phone: "+14045550101",
  trackingNumber: { providerSid: "PN_SYNTHETIC", status: "active" },
  messagingCompliance: { smsReady: true },
});
const query = (value) => ({
  select: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(value),
});
test.each([
  ["missing business", () => null],
  ["inactive", (b) => ({ ...b, isActive: false })],
  ["deleting", (b) => ({ ...b, accountLifecycle: { status: "deleting" } })],
  ["invalid forwarding", (b) => ({ ...b, forwardingPhone: "bad" })],
  ["unverified forwarding", (b) => ({ ...b, forwardingPhoneVerifiedAt: null })],
  [
    "changed forwarding",
    (b) => ({ ...b, forwardingPhoneVerifiedValue: "+14045550109" }),
  ],
  ["missing number", (b) => ({ ...b, phone: "" })],
  [
    "missing provider receipt",
    (b) => ({ ...b, trackingNumber: { status: "active" } }),
  ],
  [
    "inactive number",
    (b) => ({
      ...b,
      trackingNumber: { providerSid: "PN_SYNTHETIC", status: "released" },
    }),
  ],
])(
  "B06 %s rejects paid service before a checkout can be attempted",
  async (_label, change) => {
    const BusinessModel = { findOne: jest.fn(() => query(change(ready()))) },
      UserModel = {
        findById: jest.fn(() => query({ emailVerifiedAt: new Date() })),
      };
    await expect(
      requirePaidServiceReady(
        { businessId: "tenant", ownerId: "owner" },
        { BusinessModel, UserModel },
      ),
    ).rejects.toMatchObject({ code: "PAID_SERVICE_NOT_READY" });
    expect(BusinessModel.findOne).toHaveBeenCalledWith({
      _id: "tenant",
      owner: "owner",
    });
  },
);
test.each([null, {}, { emailVerifiedAt: null }])(
  "B06 missing or unverified owner cannot pay: %p",
  async (owner) => {
    await expect(
      requirePaidServiceReady(
        { businessId: "tenant", ownerId: "owner" },
        {
          BusinessModel: { findOne: () => query(ready()) },
          UserModel: { findById: () => query(owner) },
        },
      ),
    ).rejects.toMatchObject({ code: "PAID_SERVICE_NOT_READY" });
  },
);
test.each([true, false])(
  "B06 ready service preserves the honest SMS readiness disclosure: %p",
  async (smsReady) => {
    const b = ready();
    b.messagingCompliance.smsReady = smsReady;
    await expect(
      requirePaidServiceReady(
        { businessId: "tenant", ownerId: "owner" },
        {
          BusinessModel: { findOne: () => query(b) },
          UserModel: { findById: () => query({ emailVerifiedAt: new Date() }) },
        },
      ),
    ).resolves.toMatchObject({ smsPending: !smsReady });
  },
);
test("B01 empty or corrupt input does not invent hazard wording and bounded input remains bounded", () => {
  expect(normalizeSafetyLanguage()).toBe("");
  expect(normalizeSafetyLanguage(null)).toBe("");
  expect(normalizeSafetyLanguage("Á".repeat(5000))).toHaveLength(4000);
});
test.each(["", "Owner approved service messages"])(
  "M01 registration retry persists an explicit description or the executed default: %p",
  (description) => {
    const result = buildRegistrationCampaign({
      input: { campaign: { description } },
      common: {
        legalBusinessName: "Example HVAC",
        campaign: {
          messageFlow: "Recorded permission",
          privacyPolicyUrl: "https://example.com/privacy",
          termsAndConditionsUrl: "https://example.com/terms",
        },
      },
      useCase: "CUSTOMER_CARE",
    });
    expect(result.description).toBe(
      description ||
        "Example HVAC uses MeekCall for missed-call recovery and customer-care messaging.",
    );
    expect(result.messageSamples.every((s) => s.includes("STOP"))).toBe(true);
  },
);
test.each(["lookup failure", "entitlement outage", "inactive"])(
  "B04 voice ingress speaks and hangs up on %s without starting relay",
  async (mode) => {
    resolveTwilioNumberContext.mockReset();
    readProviderEntitlement.mockReset();
    if (mode === "lookup failure")
      resolveTwilioNumberContext.mockRejectedValue(new Error("offline"));
    else
      resolveTwilioNumberContext.mockResolvedValue({
        business: { _id: "tenant" },
      });
    if (mode === "entitlement outage")
      readProviderEntitlement.mockRejectedValue(new Error("offline"));
    else readProviderEntitlement.mockResolvedValue({ allowed: false });
    const res = {
        status: jest.fn().mockReturnThis(),
        type: jest.fn().mockReturnThis(),
        send: jest.fn(),
      },
      next = jest.fn();
    await voiceProviderEntitlement(
      { body: { Called: "+14045550101" } },
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith(
      expect.stringMatching(/<Say>.*unavailable.*<Hangup\/>/),
    );
    expect(res.send.mock.calls[0][0]).not.toMatch(/Relay|<Message/);
  },
);
test.each([null, {}, { business: { _id: "tenant" } }])(
  "B04 unassigned numbers defer to existing routing while paid service can advance: %p",
  async (context) => {
    resolveTwilioNumberContext.mockResolvedValue(context);
    readProviderEntitlement.mockResolvedValue({ allowed: true });
    const next = jest.fn();
    await voiceProviderEntitlement({ body: { To: "+14045550101" } }, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
  },
);
test("M01 pre-migration registration payload without optional campaign description receives the same approved default", () => {
  const result = buildRegistrationCampaign({
    input: {},
    common: {
      legalBusinessName: "Example Electrical",
      campaign: { messageFlow: "Saved permission" },
    },
    useCase: "CUSTOMER_CARE",
  });
  expect(result.description).toBe(
    "Example Electrical uses MeekCall for missed-call recovery and customer-care messaging.",
  );
});
test("H03 legacy plain-object call settings retain pilot limits and disable live transfer on save", async () => {
  const { applyOwnerCallSettings } =
    await import("../../src/services/ownerSettingsVoice.service.js");
  const set = jest.fn();
  const business = {
    _id: "tenant",
    businessName: "Example Roofing",
    features: { voiceAiEnabled: true },
    voiceSettings: {},
    set,
  };
  applyOwnerCallSettings({
    business,
    values: { answerMode: "always", missedCallSmsEnabled: true },
  });
  expect(set).toHaveBeenCalledWith(
    "voiceSettings",
    expect.objectContaining({
      dailyVoiceMinutes: 30,
      monthlyVoiceMinutes: 300,
      liveTransferEnabled: false,
      liveTransferPhone: "",
    }),
  );
});
