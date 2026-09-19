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

jest.mock("../../src/models/trackingNumber.js", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
  },
}));

jest.mock("../../src/services/messaging/contactPreference.service.js", () => ({
  __esModule: true,
  isSmsSuppressed: jest.fn(),
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
import TrackingNumber from "../../src/models/trackingNumber.js";
import { isSmsSuppressed } from "../../src/services/messaging/contactPreference.service.js";
import {
  reserveCommunicationUsageOperation,
  commitCommunicationUsageReservation,
  findCommunicationOperation,
  isUncertainProviderFailure,
  releaseCommunicationUsageReservation,
} from "../../src/services/communicationUsageReservation.service.js";
import {
  claimSmsContactDisclosure,
  commitSmsContactDisclosure,
  releaseSmsContactDisclosure,
} from "../../src/services/smsContactDisclosure.service.js";
import { recordOutboundSmsAudit } from "../../src/services/outboundSmsAudit.service.js";
import {
  resetTwilioClient,
  sendSms,
} from "../../src/services/twilioSmsService.js";

const mockMessagesCreate = jest.fn();

const usageReservation = {
  _id: "usage-reservation-1",
  amount: 1,
  state: "pending",
};
const disclosureClaim = { _id: "disclosure-claim-1" };

describe("central outbound SMS policy", () => {
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
    TrackingNumber.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      }),
    });
    isSmsSuppressed.mockResolvedValue(false);
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
    commitCommunicationUsageReservation.mockResolvedValue(usageReservation);
    commitSmsContactDisclosure.mockResolvedValue(disclosureClaim);
    releaseCommunicationUsageReservation.mockResolvedValue(usageReservation);
    releaseSmsContactDisclosure.mockResolvedValue(disclosureClaim);
    recordOutboundSmsAudit.mockResolvedValue({ _id: "audit-1" });
    mockMessagesCreate.mockResolvedValue({
      sid: "SM123",
      status: "queued",
      to: "+14045550101",
      from: business.phone,
    });
  });

  afterAll(() => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
  });

  test("rejects a sender number not assigned to the business", async () => {
    await expect(
      sendSms({
        businessId: business._id,
        to: "+14045550101",
        from: "+14045550999",
        body: "Hello",
      }),
    ).rejects.toMatchObject({ code: "SMS_SENDER_NOT_OWNED" });

    expect(mockMessagesCreate).not.toHaveBeenCalled();
    expect(claimSmsContactDisclosure).not.toHaveBeenCalled();
    expect(reserveCommunicationUsageOperation).not.toHaveBeenCalled();
  });

  test("suppresses opted-out recipients before Twilio or usage reservation", async () => {
    isSmsSuppressed.mockResolvedValue(true);

    const result = await sendSms({
      businessId: business._id,
      to: "+14045550101",
      body: "Hello",
      actorId: "64f000000000000000000002",
      actorType: "user",
      source: "manual_sms",
    });

    expect(result).toMatchObject({
      suppressed: true,
      status: "suppressed",
      reason: "customer_opted_out",
    });
    expect(mockMessagesCreate).not.toHaveBeenCalled();
    expect(reserveCommunicationUsageOperation).not.toHaveBeenCalled();
    expect(releaseSmsContactDisclosure).toHaveBeenCalledWith({
      claim: disclosureClaim,
    });
    expect(recordOutboundSmsAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: business._id,
        actorType: "user",
        source: "manual_sms",
        status: "suppressed",
      }),
    );
  });

  test("derives the sender from the business and records the acting user", async () => {
    const actorId = "64f000000000000000000002";

    const result = await sendSms({
      bypassQuietHours: true,
      businessId: business._id,
      to: "+14045550101",
      body: "Hello",
      actorId,
      actorType: "user",
      source: "manual_sms",
      usageCategory: "manual_sms",
    });

    expect(result).toMatchObject({ sid: "SM123", suppressed: false });
    expect(isSmsSuppressed).toHaveBeenCalledWith({
      businessId: business._id,
      phone: "+14045550101",
    });
    expect(reserveCommunicationUsageOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        business,
        customerPhone: "+14045550101",
        metric: "sms_outbound",
        bypass: false,
        amount: 1,
        source: "manual_sms",
      }),
    );
    expect(mockMessagesCreate).toHaveBeenCalledWith({
      to: "+14045550101",
      from: business.phone,
      body: "Hello",
    });
    expect(commitCommunicationUsageReservation).toHaveBeenCalledWith({
      reservation: usageReservation,
      providerOperationId: "SM123",
      providerStatus: "queued",
    });
    expect(commitSmsContactDisclosure).toHaveBeenCalledWith(
      expect.objectContaining({
        claim: disclosureClaim,
        businessId: business._id,
        phone: "+14045550101",
        providerMessageId: "SM123",
      }),
    );
    expect(recordOutboundSmsAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: business._id,
        actorId,
        actorType: "user",
        from: business.phone,
        status: "sent",
        providerMessageId: "SM123",
      }),
    );
  });

  test("retains server-controlled Messaging Service delivery for automation", async () => {
    await sendSms({
      bypassQuietHours: true,
      business,
      to: "+14045550101",
      body: "Automated follow-up",
      actorType: "automation",
      source: "automation",
      messagingServiceSid: "MG123",
    });

    expect(mockMessagesCreate).toHaveBeenCalledWith({
      to: "+14045550101",
      body: "Automated follow-up",
      messagingServiceSid: "MG123",
    });
  });
  test("latest owner text choice wins over a queued business snapshot", async () => {
    Business.findById.mockResolvedValue({ ...business, customerMessaging: { automaticTextsEnabled: false } });
    const result = await sendSms({ business, to: "+14045550101", body: "Queued reminder", source: "appointment_reminder" });
    expect(result).toMatchObject({ suppressed: true, reason: "automatic_customer_texts_disabled" });
    expect(mockMessagesCreate).not.toHaveBeenCalled();
    expect(releaseCommunicationUsageReservation).toHaveBeenCalled();
  });
  test("manually sent replies still work with automatic customer texts off", async () => {
    Business.findById.mockResolvedValue({ ...business, customerMessaging: { automaticTextsEnabled: false } });
    const result = await sendSms({ business, to: "+14045550101", body: "A personal reply", usageCategory: "manual_sms" });
    expect(result.suppressed).toBe(false);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

});
