import twilio from "twilio";
import Business from "../../src/models/business.js";
import Subscription from "../../src/models/subscription.js";
import {
  attachPhoneNumberToBusinessMessagingRegistration,
  toMessagingComplianceUpdate,
} from "../../src/services/a2pMessagingRegistration.service.js";
import {
  acquireOperationLease,
  releaseOperationLease,
} from "../../src/services/operationLease.service.js";
import {
  activateTrackingNumber,
  assignTrackingNumber,
  releaseTrackingNumber,
  verifyTrackingNumber,
} from "../../src/services/trackingNumberProvisioning.service.js";

jest.mock("twilio", () => ({
  __esModule: true,
  default: jest.fn(),
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
  },
}));

jest.mock("../../src/services/a2pMessagingRegistration.service.js", () => ({
  attachPhoneNumberToBusinessMessagingRegistration: jest.fn(),
  toMessagingComplianceUpdate: jest.fn(),
}));

jest.mock("../../src/services/operationLease.service.js", () => ({
  acquireOperationLease: jest.fn(),
  releaseOperationLease: jest.fn(),
}));

jest.mock("../../src/voice/voicePhone.service.js", () => ({
  normalizePhoneToE164: jest.fn((value) => {
    const digits = String(value || "").replace(/\D/g, "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return value || "";
  }),
}));

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
  phone: "",
  trackingNumber: {
    status: "unassigned",
    provider: "twilio",
    providerSid: "",
    lastError: "",
  },
  messagingCompliance: {},
  ...overrides,
});

const makeTwilioClient = ({
  candidates = [{ phoneNumber: "+14045550123" }],
  createdNumber = {
    sid: "PN123",
    phoneNumber: "+14045550123",
  },
  fetchedNumber = {
    sid: "PN123",
    phoneNumber: "+14045550123",
    voiceUrl: "https://api.callbackiq.test/api/twilio/voice",
    smsUrl: "https://api.callbackiq.test/api/twilio/sms",
    statusCallback: "https://api.callbackiq.test/api/twilio/status",
  },
} = {}) => {
  const list = jest.fn().mockResolvedValue(candidates);
  const create = jest.fn().mockResolvedValue(createdNumber);
  const remove = jest.fn().mockResolvedValue(true);
  const fetch = jest.fn().mockResolvedValue(fetchedNumber);
  const update = jest.fn().mockResolvedValue(fetchedNumber);

  const incomingPhoneNumbers = jest.fn(() => ({ remove, fetch, update }));
  incomingPhoneNumbers.create = create;

  return {
    client: {
      availablePhoneNumbers: jest.fn(() => ({ local: { list } })),
      incomingPhoneNumbers,
    },
    list,
    create,
    remove,
    fetch,
    update,
    incomingPhoneNumbers,
  };
};

const mockBusinessReads = (...businesses) => {
  for (const business of businesses) {
    Business.findById.mockReturnValueOnce(selected(business));
  }
};

beforeEach(() => {
  jest.clearAllMocks();

  process.env.TWILIO_ACCOUNT_SID = "AC_TEST";
  process.env.TWILIO_AUTH_TOKEN = "AUTH_TEST";
  process.env.TWILIO_WEBHOOK_BASE_URL = "https://api.callbackiq.test";

  Subscription.findOne.mockReturnValue(
    lean({
      _id: "sub-1",
      business: "biz-1",
      status: "active",
      isActive: true,
      stripeSubscriptionId: "sub_remote",
    }),
  );

  acquireOperationLease.mockResolvedValue({ key: "tracking-number:biz-1", token: "lease-token" });
  releaseOperationLease.mockResolvedValue(true);

  attachPhoneNumberToBusinessMessagingRegistration.mockResolvedValue({
    a2pStatus: "registered",
    campaignStatus: "VERIFIED",
    senderAttached: true,
    smsReady: true,
    lastError: "",
  });
  toMessagingComplianceUpdate.mockReturnValue({
    "messagingCompliance.a2pStatus": "registered",
    "messagingCompliance.smsReady": true,
  });

  Business.updateOne.mockResolvedValue({ modifiedCount: 1 });
});

describe("tracking number provisioning branch hardening", () => {
  test("rejects unknown businesses before touching Twilio", async () => {
    Business.findById.mockReturnValue(selected(null));

    await expect(assignTrackingNumber("biz-missing")).rejects.toMatchObject({
      code: "BUSINESS_NOT_FOUND",
    });

    expect(twilio).not.toHaveBeenCalled();
  });

  test("requires a Stripe-backed active or trialing subscription", async () => {
    mockBusinessReads(makeBusiness());
    Subscription.findOne.mockReturnValue(lean(null));

    await expect(assignTrackingNumber("biz-1")).rejects.toMatchObject({
      code: "SUBSCRIPTION_REQUIRED",
    });

    expect(twilio).not.toHaveBeenCalled();
  });

  test("requires a forwarding phone before provisioning", async () => {
    mockBusinessReads(makeBusiness({ forwardingPhone: "" }));

    await expect(assignTrackingNumber("biz-1")).rejects.toMatchObject({
      code: "FORWARDING_PHONE_REQUIRED",
    });
  });

  test("returns an already-active number without taking a lease", async () => {
    const business = makeBusiness({
      phone: "+14045550123",
      trackingNumber: {
        status: "active",
        provider: "twilio",
        providerSid: "PN123",
      },
    });
    mockBusinessReads(business);

    await expect(assignTrackingNumber("biz-1")).resolves.toBe(business);
    expect(acquireOperationLease).not.toHaveBeenCalled();
    expect(twilio).not.toHaveBeenCalled();
  });

  test("releases its lease and records failure when no Twilio number is available", async () => {
    const twilioState = makeTwilioClient({ candidates: [] });
    twilio.mockReturnValue(twilioState.client);
    mockBusinessReads(makeBusiness(), makeBusiness());

    await expect(assignTrackingNumber("biz-1")).rejects.toMatchObject({
      code: "NO_TRACKING_NUMBER_AVAILABLE",
    });

    expect(twilioState.list).toHaveBeenCalledWith(
      expect.objectContaining({ areaCode: 404, smsEnabled: true, voiceEnabled: true }),
    );
    expect(Business.updateOne).toHaveBeenCalled();
    expect(releaseOperationLease).toHaveBeenCalledWith(
      expect.objectContaining({ token: "lease-token" }),
    );
  });

  test("fails closed when the public webhook URL is not HTTPS", async () => {
    process.env.TWILIO_WEBHOOK_BASE_URL = "http://api.callbackiq.test";
    const twilioState = makeTwilioClient();
    twilio.mockReturnValue(twilioState.client);
    mockBusinessReads(makeBusiness(), makeBusiness());

    await expect(assignTrackingNumber("biz-1")).rejects.toMatchObject({
      code: "TWILIO_WEBHOOK_BASE_URL_REQUIRED",
    });

    expect(twilioState.create).not.toHaveBeenCalled();
    expect(releaseOperationLease).toHaveBeenCalled();
  });

  test("deletes an orphaned provider number when local persistence fails", async () => {
    const twilioState = makeTwilioClient();
    twilio.mockReturnValue(twilioState.client);
    mockBusinessReads(makeBusiness(), makeBusiness());
    Business.findByIdAndUpdate.mockReturnValue(selected(null));

    await expect(assignTrackingNumber("biz-1")).rejects.toMatchObject({
      code: "TRACKING_NUMBER_PERSISTENCE_FAILED",
    });

    expect(twilioState.incomingPhoneNumbers).toHaveBeenCalledWith("PN123");
    expect(twilioState.remove).toHaveBeenCalled();
    expect(Business.updateOne).toHaveBeenCalled();
    expect(releaseOperationLease).toHaveBeenCalled();
  });

  test("verify rejects a provider phone mismatch and records the failure", async () => {
    const twilioState = makeTwilioClient({
      fetchedNumber: {
        sid: "PN123",
        phoneNumber: "+14045550000",
        voiceUrl: "https://api.callbackiq.test/api/twilio/voice",
        smsUrl: "https://api.callbackiq.test/api/twilio/sms",
        statusCallback: "https://api.callbackiq.test/api/twilio/status",
      },
    });
    twilio.mockReturnValue(twilioState.client);
    mockBusinessReads(
      makeBusiness({
        phone: "+14045550123",
        trackingNumber: {
          status: "assigned",
          provider: "twilio",
          providerSid: "PN123",
        },
      }),
    );

    await expect(verifyTrackingNumber("biz-1")).rejects.toMatchObject({
      code: "TRACKING_NUMBER_PROVIDER_MISMATCH",
    });

    expect(Business.updateOne).toHaveBeenCalled();
  });

  test("verify repairs stale provider webhook URLs before marking verified", async () => {
    const twilioState = makeTwilioClient({
      fetchedNumber: {
        sid: "PN123",
        phoneNumber: "+14045550123",
        voiceUrl: "https://old.example/voice",
        smsUrl: "https://old.example/sms",
        statusCallback: "https://old.example/status",
      },
    });
    twilio.mockReturnValue(twilioState.client);
    mockBusinessReads(
      makeBusiness({
        phone: "+14045550123",
        trackingNumber: {
          status: "assigned",
          provider: "twilio",
          providerSid: "PN123",
        },
      }),
    );
    const updatedBusiness = makeBusiness({
      phone: "+14045550123",
      trackingNumber: {
        status: "verified",
        provider: "twilio",
        providerSid: "PN123",
      },
    });
    Business.findByIdAndUpdate.mockReturnValue(selected(updatedBusiness));

    await expect(verifyTrackingNumber("biz-1")).resolves.toBe(updatedBusiness);

    expect(twilioState.update).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceUrl: "https://api.callbackiq.test/api/twilio/voice",
        smsUrl: "https://api.callbackiq.test/api/twilio/sms",
        statusCallback: "https://api.callbackiq.test/api/twilio/status",
      }),
    );
  });

  test("release converges locally when Twilio already reports the number missing", async () => {
    const twilioState = makeTwilioClient();
    twilioState.remove.mockRejectedValue(Object.assign(new Error("missing"), { status: 404 }));
    twilio.mockReturnValue(twilioState.client);
    mockBusinessReads(
      makeBusiness({
        phone: "+14045550123",
        trackingNumber: {
          status: "active",
          provider: "twilio",
          providerSid: "PN123",
        },
      }),
    );
    const released = makeBusiness();
    Business.findByIdAndUpdate.mockReturnValue(selected(released));

    await expect(releaseTrackingNumber("biz-1")).resolves.toBe(released);

    expect(twilioState.remove).toHaveBeenCalled();
    expect(Business.findByIdAndUpdate).toHaveBeenCalled();
  });

  test("release propagates non-404 provider failures and records them", async () => {
    const twilioState = makeTwilioClient();
    twilioState.remove.mockRejectedValue(Object.assign(new Error("provider down"), { status: 503 }));
    twilio.mockReturnValue(twilioState.client);
    mockBusinessReads(
      makeBusiness({
        phone: "+14045550123",
        trackingNumber: {
          status: "active",
          provider: "twilio",
          providerSid: "PN123",
        },
      }),
    );

    await expect(releaseTrackingNumber("biz-1")).rejects.toMatchObject({ status: 503 });
    expect(Business.updateOne).toHaveBeenCalled();
  });

  test("activate is idempotent for an already-active number", async () => {
    const active = makeBusiness({
      phone: "+14045550123",
      trackingNumber: {
        status: "active",
        provider: "twilio",
        providerSid: "PN123",
      },
    });
    mockBusinessReads(active);

    await expect(activateTrackingNumber("biz-1")).resolves.toBe(active);

    expect(twilio).not.toHaveBeenCalled();
    expect(Business.findByIdAndUpdate).not.toHaveBeenCalled();
  });
});
