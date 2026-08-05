jest.mock("twilio", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("../../src/models/business.js", () => ({
  __esModule: true,
  default: {
    findById: jest.fn(),
    findOne: jest.fn(),
  },
}));

jest.mock("../../src/services/messaging/contactPreference.service.js", () => ({
  __esModule: true,
  isSmsSuppressed: jest.fn(),
  optOutSms: jest.fn(),
}));

jest.mock("../../src/services/communicationUsageReservation.service.js", () => ({
  __esModule: true,
  reserveCommunicationUsageOperation: jest.fn(),
  commitCommunicationUsageReservation: jest.fn(),
  findCommunicationOperation: jest.fn(),
  isUncertainProviderFailure: jest.fn(),
  markCommunicationUsageUncertain: jest.fn(),
  releaseCommunicationUsageReservation: jest.fn(),
}));

jest.mock("../../src/services/smsContactDisclosure.service.js", () => ({
  __esModule: true,
  claimSmsContactDisclosure: jest.fn(),
  commitSmsContactDisclosure: jest.fn(),
  releaseSmsContactDisclosure: jest.fn(),
}));

jest.mock("../../src/services/outboundSmsAudit.service.js", () => ({
  __esModule: true,
  recordOutboundSmsAudit: jest.fn(),
}));

import twilio from "twilio";
import Business from "../../src/models/business.js";
import {
  isSmsSuppressed,
  optOutSms,
} from "../../src/services/messaging/contactPreference.service.js";
import {
  reserveCommunicationUsageOperation,
  findCommunicationOperation,
  isUncertainProviderFailure,
  releaseCommunicationUsageReservation,
} from "../../src/services/communicationUsageReservation.service.js";
import {
  claimSmsContactDisclosure,
  releaseSmsContactDisclosure,
} from "../../src/services/smsContactDisclosure.service.js";
import { recordOutboundSmsAudit } from "../../src/services/outboundSmsAudit.service.js";
import {
  resetTwilioClient,
  sendSms,
} from "../../src/services/twilioSmsService.js";

const mockMessagesCreate = jest.fn();
const usageReservation = {
  _id: "usage-reservation-21610",
  amount: 1,
  state: "pending",
};
const disclosureClaim = { _id: "disclosure-claim-21610" };

describe("Twilio 21610 SMS suppression", () => {
  const business = {
    _id: "64f000000000000000000001",
    phone: "+14045550100",
    isActive: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    resetTwilioClient();
    process.env.TWILIO_ACCOUNT_SID = "AC_test";
    process.env.TWILIO_AUTH_TOKEN = "test_token";
    twilio.mockReturnValue({
      messages: { create: mockMessagesCreate },
    });
    Business.findById.mockResolvedValue(business);
    Business.findOne.mockResolvedValue(business);
    isSmsSuppressed.mockResolvedValue(false);
    optOutSms.mockResolvedValue({ smsStatus: "opted_out" });
    findCommunicationOperation.mockResolvedValue(null);
    isUncertainProviderFailure.mockReturnValue(false);
    claimSmsContactDisclosure.mockResolvedValue({
      append: false,
      claim: disclosureClaim,
    });
    reserveCommunicationUsageOperation.mockResolvedValue({
      allowed: true,
      replayed: false,
      reservation: usageReservation,
      usage: {
        allowed: true,
        amount: 1,
        reservations: [],
      },
    });
    releaseCommunicationUsageReservation.mockResolvedValue(usageReservation);
    releaseSmsContactDisclosure.mockResolvedValue(disclosureClaim);
    recordOutboundSmsAudit.mockResolvedValue({ _id: "audit-1" });
  });

  afterAll(() => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
  });

  test("converts provider error 21610 into a normal opted-out result", async () => {
    mockMessagesCreate.mockRejectedValueOnce(
      Object.assign(new Error("Attempt to send to unsubscribed recipient"), {
        code: 21610,
        status: 400,
      }),
    );

    const result = await sendSms({
      bypassQuietHours: true,
      businessId: business._id,
      to: "+14045550101",
      body: "Missed call recovery",
      actorType: "webhook",
      source: "missed_call_recovery",
    });

    expect(result).toMatchObject({
      sid: "",
      status: "suppressed",
      suppressed: true,
      reason: "customer_opted_out",
      providerCode: 21610,
    });
    expect(optOutSms).toHaveBeenCalledWith({
      businessId: business._id,
      phone: "+14045550101",
      source: "twilio_provider_21610",
      keyword: "STOP",
    });
    expect(releaseCommunicationUsageReservation).toHaveBeenCalledWith({
      reservation: usageReservation,
      usage: expect.objectContaining({ allowed: true, amount: 1 }),
      reason: "provider_21610_opt_out",
    });
    expect(releaseSmsContactDisclosure).toHaveBeenCalledWith({
      claim: disclosureClaim,
    });
    expect(recordOutboundSmsAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: business._id,
        status: "suppressed",
        reason: "customer_opted_out",
        metadata: expect.objectContaining({
          providerCode: 21610,
          preferenceSyncFailed: false,
        }),
      }),
    );
  });
});
