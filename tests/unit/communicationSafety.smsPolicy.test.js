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
}));

jest.mock("../../src/services/communicationUsage.service.js", () => ({
  __esModule: true,
  reserveSmsUsage: jest.fn(),
}));

jest.mock("../../src/services/outboundSmsAudit.service.js", () => ({
  __esModule: true,
  recordOutboundSmsAudit: jest.fn(),
}));

import twilio from "twilio";
import Business from "../../src/models/business.js";
import { isSmsSuppressed } from "../../src/services/messaging/contactPreference.service.js";
import { reserveSmsUsage } from "../../src/services/communicationUsage.service.js";
import { recordOutboundSmsAudit } from "../../src/services/outboundSmsAudit.service.js";
import {
  resetTwilioClient,
  sendSms,
} from "../../src/services/twilioSmsService.js";

const mockMessagesCreate = jest.fn();

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
    isSmsSuppressed.mockResolvedValue(false);
    reserveSmsUsage.mockResolvedValue({ allowed: true });
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
    expect(reserveSmsUsage).not.toHaveBeenCalled();
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
    expect(reserveSmsUsage).not.toHaveBeenCalled();
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
    expect(reserveSmsUsage).toHaveBeenCalledWith({
      business,
      customerPhone: "+14045550101",
      bypass: false,
    });
    expect(mockMessagesCreate).toHaveBeenCalledWith({
      to: "+14045550101",
      from: business.phone,
      body: "Hello",
    });
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
});
