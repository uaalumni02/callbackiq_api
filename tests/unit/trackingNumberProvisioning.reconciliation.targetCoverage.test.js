const mockTwilio = jest.fn();
const mockSecurityGateEnabled = jest.fn(() => false);
const mockProvisioningBudgetEnabled = jest.fn(() => false);
const mockAssertAutomaticProvisioningBudget = jest.fn();

jest.mock("twilio", () => ({
  __esModule: true,
  default: (...args) => mockTwilio(...args),
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
  default: { findOne: jest.fn() },
}));

jest.mock("../../src/services/a2pMessagingRegistration.service.js", () => ({
  attachPhoneNumberToBusinessMessagingRegistration: jest.fn(),
  toMessagingComplianceUpdate: jest.fn(),
}));

jest.mock("../../src/services/operationLease.service.js", () => ({
  acquireOperationLease: jest.fn(),
  releaseOperationLease: jest.fn(),
}));

jest.mock("../../src/services/trialTelecomGuard.service.js", () => ({
  assertAutomaticProvisioningBudget: (...args) =>
    mockAssertAutomaticProvisioningBudget(...args),
  provisioningBudgetEnabled: (...args) => mockProvisioningBudgetEnabled(...args),
}));

jest.mock("../../src/services/trialIdentityVerification.service.js", () => ({
  securityGateEnabled: (...args) => mockSecurityGateEnabled(...args),
}));

jest.mock("../../src/voice/voicePhone.service.js", () => ({
  normalizePhoneToE164: jest.fn((value) => {
    const digits = String(value || "").replace(/\D/g, "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return "";
  }),
}));

import Business from "../../src/models/business.js";
import Subscription from "../../src/models/subscription.js";
import {
  acquireOperationLease,
  releaseOperationLease,
} from "../../src/services/operationLease.service.js";
import {
  assignTrackingNumber,
  isTrackingNumberStateInconsistent,
  reconcileExistingTrackingNumber,
} from "../../src/services/trackingNumberProvisioning.service.js";

const selected = (value) => ({
  select: jest.fn().mockResolvedValue(value),
});

const lean = (value) => ({
  lean: jest.fn().mockResolvedValue(value),
});

const makeBusiness = (overrides = {}) => ({
  _id: "biz-1",
  businessName: "Atlanta Pro Plumbing & Drain",
  forwardingPhone: "+14045550999",
  forwardingPhoneVerifiedAt: null,
  forwardingPhoneVerifiedValue: "",
  phone: "+14045550123",
  trackingNumber: {
    status: "unassigned",
    provider: "twilio",
    providerSid: "",
    assignedAt: null,
    verifiedAt: null,
    activatedAt: null,
    lastError: "",
  },
  messagingCompliance: {},
  ...overrides,
});

const expectedWebhookState = {
  voiceUrl: "https://api.callbackiq.test/api/twilio/voice",
  smsUrl: "https://api.callbackiq.test/api/twilio/sms",
  statusCallback: "https://api.callbackiq.test/api/twilio/status",
};

const makeIncoming = (overrides = {}) => ({
  sid: "PN123",
  phoneNumber: "+14045550123",
  dateCreated: new Date("2026-08-01T12:00:00.000Z"),
  ...expectedWebhookState,
  ...overrides,
});

const makeClient = ({ candidates = [makeIncoming()] } = {}) => {
  const list = jest.fn().mockResolvedValue(candidates);
  const update = jest.fn().mockResolvedValue(makeIncoming());
  const remove = jest.fn().mockResolvedValue(true);
  const fetch = jest.fn().mockResolvedValue(makeIncoming());
  const create = jest.fn();

  const incomingPhoneNumbers = jest.fn(() => ({ update, remove, fetch }));
  incomingPhoneNumbers.list = list;
  incomingPhoneNumbers.create = create;

  const availableList = jest.fn();
  const client = {
    incomingPhoneNumbers,
    availablePhoneNumbers: jest.fn(() => ({
      local: { list: availableList },
    })),
  };

  return {
    client,
    list,
    update,
    remove,
    fetch,
    create,
    availableList,
    incomingPhoneNumbers,
  };
};

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(process.env, {
    TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
    TWILIO_WEBHOOK_BASE_URL: "https://api.callbackiq.test",
  });
  process.env.TWILIO_AUTH_TOKEN = ["AUTH", "TEST", "TOKEN"].join("_");

  Subscription.findOne.mockReturnValue(
    lean({
      _id: "sub-1",
      business: "biz-1",
      status: "active",
      isActive: true,
      stripeSubscriptionId: "sub_remote",
    }),
  );
  acquireOperationLease.mockResolvedValue({
    key: "tracking-number:biz-1",
    token: "lease-token",
  });
  releaseOperationLease.mockResolvedValue(true);
  Business.updateOne.mockResolvedValue({ modifiedCount: 1 });
  mockSecurityGateEnabled.mockReturnValue(false);
  mockProvisioningBudgetEnabled.mockReturnValue(false);
  mockAssertAutomaticProvisioningBudget.mockResolvedValue(undefined);
});

describe("tracking number reconciliation target coverage", () => {
  test.each([
    [null, false],
    [{ phone: "", trackingNumber: { status: "unassigned", providerSid: "" } }, false],
    [{ phone: "+14045550123", trackingNumber: { status: "unassigned", providerSid: "" } }, true],
    [{ phone: "+14045550123", trackingNumber: { status: "active", providerSid: "" } }, true],
    [{ phone: "+14045550123", trackingNumber: { status: "verified", providerSid: "PN123" } }, false],
  ])("detects inconsistent persisted provider state %#", (business, expected) => {
    expect(isTrackingNumberStateInconsistent(business)).toBe(expected);
  });

  test("rejects an invalid persisted phone without touching Twilio inventory", async () => {
    const state = makeClient();

    await expect(
      reconcileExistingTrackingNumber({
        business: makeBusiness({ phone: "invalid" }),
        client: state.client,
      }),
    ).rejects.toMatchObject({
      code: "TRACKING_NUMBER_STATE_INCONSISTENT",
      statusCode: 409,
    });

    expect(state.list).not.toHaveBeenCalled();
  });

  test("fails closed when the stored phone cannot be found in the configured Twilio account", async () => {
    const state = makeClient({ candidates: [] });

    await expect(
      reconcileExistingTrackingNumber({
        business: makeBusiness(),
        client: state.client,
      }),
    ).rejects.toMatchObject({ code: "TRACKING_NUMBER_STATE_INCONSISTENT" });

    expect(state.list).toHaveBeenCalledWith({
      phoneNumber: "+14045550123",
      limit: 20,
    });
    expect(state.create).not.toHaveBeenCalled();
  });

  test("falls back to account inventory when filtered Twilio lookup is unavailable", async () => {
    const state = makeClient();
    state.list
      .mockRejectedValueOnce(new Error("filtered lookup unsupported"))
      .mockResolvedValueOnce([
        makeIncoming({ phoneNumber: "+14045550000" }),
        makeIncoming(),
      ]);
    const updated = makeBusiness({
      trackingNumber: { status: "active", providerSid: "PN123" },
    });
    Business.findByIdAndUpdate.mockReturnValue(selected(updated));

    await expect(
      reconcileExistingTrackingNumber({ business: makeBusiness(), client: state.client }),
    ).resolves.toBe(updated);

    expect(state.list).toHaveBeenNthCalledWith(1, {
      phoneNumber: "+14045550123",
      limit: 20,
    });
    expect(state.list).toHaveBeenNthCalledWith(2, { limit: 1000 });
  });

  test("repairs stale provider webhooks before restoring local active state", async () => {
    const state = makeClient({
      candidates: [
        makeIncoming({
          voiceUrl: "https://old.example/voice",
          smsUrl: "https://old.example/sms",
          statusCallback: "https://old.example/status",
        }),
      ],
    });
    const updated = makeBusiness({
      trackingNumber: { status: "active", providerSid: "PN123" },
    });
    Business.findByIdAndUpdate.mockReturnValue(selected(updated));

    await expect(
      reconcileExistingTrackingNumber({ business: makeBusiness(), client: state.client }),
    ).resolves.toBe(updated);

    expect(state.incomingPhoneNumbers).toHaveBeenCalledWith("PN123");
    expect(state.update).toHaveBeenCalledWith({
      voiceMethod: "POST",
      voiceUrl: "https://api.callbackiq.test/api/twilio/voice#ct=1500&rt=5000&tt=14000&rc=1&rp=ct,rt,5xx",
      voiceFallbackMethod: "POST",
      voiceFallbackUrl: "https://api.callbackiq.test/api/twilio/voice-fallback#ct=1500&rt=5000&tt=12000&rc=0",
      smsMethod: "POST",
      smsUrl: "https://api.callbackiq.test/api/twilio/sms#ct=1500&rt=5000&tt=12000&rc=2&rp=ct,rt,5xx",
      smsFallbackMethod: "POST",
      smsFallbackUrl: "https://api.callbackiq.test/api/twilio/sms-fallback#ct=1500&rt=5000&tt=12000&rc=0",
      statusCallbackMethod: "POST",
      statusCallback: "https://api.callbackiq.test/api/twilio/status#ct=1500&rt=5000&tt=12000&rc=2&rp=ct,rt,5xx",
    });
    expect(Business.findByIdAndUpdate).toHaveBeenCalledWith(
      "biz-1",
      {
        $set: expect.objectContaining({
          phone: "+14045550123",
          phoneLookup: "+14045550123",
          "trackingNumber.provider": "twilio",
          "trackingNumber.providerSid": "PN123",
          "trackingNumber.status": "active",
          "setupProgress.trackingNumberAssigned": true,
          "setupProgress.trackingNumberVerified": true,
          "setupProgress.trackingNumberActive": true,
        }),
      },
      { returnDocument: "after" },
    );
  });

  test("does not rewrite provider webhooks when they already match", async () => {
    const assignedAt = new Date("2026-07-01T00:00:00.000Z");
    const verifiedAt = new Date("2026-07-02T00:00:00.000Z");
    const activatedAt = new Date("2026-07-03T00:00:00.000Z");
    const business = makeBusiness({
      trackingNumber: {
        status: "unassigned",
        providerSid: "",
        assignedAt,
        verifiedAt,
        activatedAt,
      },
    });
    const state = makeClient({
      candidates: [
        makeIncoming({
          voiceMethod: "POST",
          voiceUrl: "https://api.callbackiq.test/api/twilio/voice#ct=1500&rt=5000&tt=14000&rc=1&rp=ct,rt,5xx",
          voiceFallbackMethod: "POST",
          voiceFallbackUrl: "https://api.callbackiq.test/api/twilio/voice-fallback#ct=1500&rt=5000&tt=12000&rc=0",
          smsMethod: "POST",
          smsUrl: "https://api.callbackiq.test/api/twilio/sms#ct=1500&rt=5000&tt=12000&rc=2&rp=ct,rt,5xx",
          smsFallbackMethod: "POST",
          smsFallbackUrl: "https://api.callbackiq.test/api/twilio/sms-fallback#ct=1500&rt=5000&tt=12000&rc=0",
          statusCallbackMethod: "POST",
          statusCallback: "https://api.callbackiq.test/api/twilio/status#ct=1500&rt=5000&tt=12000&rc=2&rp=ct,rt,5xx",
        }),
      ],
    });
    Business.findByIdAndUpdate.mockReturnValue(selected({
      ...business,
      trackingNumber: { status: "active", providerSid: "PN123" },
    }));

    await reconcileExistingTrackingNumber({ business, client: state.client });

    expect(state.update).not.toHaveBeenCalled();
    const update = Business.findByIdAndUpdate.mock.calls[0][1].$set;
    expect(update["trackingNumber.assignedAt"]).toBe(assignedAt);
    expect(update["trackingNumber.verifiedAt"]).toBe(verifiedAt);
    expect(update["trackingNumber.activatedAt"]).toBe(activatedAt);
  });

  test("uses provider creation time when reconciliation fills missing lifecycle timestamps", async () => {
    const createdAt = new Date("2026-08-01T12:00:00.000Z");
    const state = makeClient({ candidates: [makeIncoming({ dateCreated: createdAt })] });
    Business.findByIdAndUpdate.mockReturnValue(selected(makeBusiness()));

    await reconcileExistingTrackingNumber({ business: makeBusiness(), client: state.client });

    const update = Business.findByIdAndUpdate.mock.calls[0][1].$set;
    expect(update["trackingNumber.assignedAt"]).toEqual(createdAt);
    expect(update["trackingNumber.verifiedAt"]).toBeInstanceOf(Date);
    expect(update["trackingNumber.activatedAt"]).toBeInstanceOf(Date);
  });

  test("assign reconciles a stored phone instead of purchasing a duplicate number", async () => {
    const initial = makeBusiness({
      trackingNumber: { status: "unassigned", providerSid: "" },
    });
    const leased = makeBusiness({
      trackingNumber: { status: "unassigned", providerSid: "" },
    });
    const reconciled = makeBusiness({
      trackingNumber: { status: "active", providerSid: "PN123" },
    });

    Business.findById
      .mockReturnValueOnce(selected(initial))
      .mockReturnValueOnce(selected(leased));
    Business.findByIdAndUpdate.mockReturnValue(selected(reconciled));

    const state = makeClient();
    mockTwilio.mockReturnValue(state.client);

    await expect(assignTrackingNumber("biz-1")).resolves.toBe(reconciled);

    expect(acquireOperationLease).toHaveBeenCalled();
    expect(state.list).toHaveBeenCalled();
    expect(state.availableList).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
    expect(releaseOperationLease).toHaveBeenCalledWith(
      expect.objectContaining({ token: "lease-token" }),
    );
  });

  test("trial provisioning requires the currently configured forwarding phone to remain verified", async () => {
    mockSecurityGateEnabled.mockReturnValue(true);
    Subscription.findOne.mockReturnValue(
      lean({
        _id: "sub-1",
        business: "biz-1",
        status: "trialing",
        isActive: true,
        stripeSubscriptionId: "sub_remote",
      }),
    );
    Business.findById.mockReturnValue(
      selected(
        makeBusiness({
          phone: "",
          forwardingPhone: "+14045550999",
          forwardingPhoneVerifiedAt: new Date(),
          forwardingPhoneVerifiedValue: "+14045550000",
        }),
      ),
    );

    await expect(assignTrackingNumber("biz-1")).rejects.toMatchObject({
      code: "TRIAL_PHONE_VERIFICATION_REQUIRED",
      statusCode: 403,
    });
    expect(acquireOperationLease).not.toHaveBeenCalled();
  });
});
