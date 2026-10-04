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
jest.mock("../../src/models/conversation.js", () => ({
  __esModule: true, default: { findOne: jest.fn() },
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
import Conversation from "../../src/models/conversation.js";
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
  setBeforeSmsProviderSendHookForTests,
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
    mockMessagesCreate.mockReset();
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

  test.each([
    [{ humanTakeover: true }, "human_takeover"],
    [{ status: "closed" }, "conversation_inactive"],
    [{ aiEnabled: false }, "conversation_ai_disabled"],
  ])("blocks staff ownership changes at the provider boundary: %p", async (change, reason) => {
    const current = { _id: "conversation-1", business: business._id, lead: "lead-1",
      customerPhone: "+14045550101", aiEnabled: true, humanTakeover: false, status: "open" };
    Conversation.findOne.mockImplementation(async () => current);
    setBeforeSmsProviderSendHookForTests(async () => Object.assign(current, change));
    const result = await sendSms({ business, to: current.customerPhone, body: "Prepared AI reply",
      directResponse: true, conversationId: current._id, leadId: current.lead,
      source: "inbound_sms_reply", actorType: "ai", metadata: { aiGenerated: true } });
    expect(result).toMatchObject({ suppressed: true, reason });
    expect(mockMessagesCreate).not.toHaveBeenCalled();
    expect(releaseCommunicationUsageReservation).toHaveBeenCalledWith(expect.objectContaining({ reason }));
    expect(releaseSmsContactDisclosure).toHaveBeenCalledWith({ claim: disclosureClaim });
    expect(Conversation.findOne).toHaveBeenCalledWith({ _id: current._id, business: business._id });
  });

  test("fails closed when the conversation no longer belongs to the sending business", async () => {
    Conversation.findOne.mockResolvedValue(null);
    const result = await sendSms({ business, to: "+14045550101", body: "Prepared AI reply",
      directResponse: true, conversationId: "other-tenant-conversation", source: "inbound_sms_reply" });
    expect(result).toMatchObject({ suppressed: true, reason: "automation_context_missing" });
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  test.each([
    [{ isActive: false }, {}, "business_inactive"],
    [{ features: { aiQualificationEnabled: false } }, {}, "business_ai_disabled"],
    [{}, { customerPhone: "+14045550199" }, "automation_context_changed"],
    [{}, { lead: "different-lead" }, "automation_context_changed"],
  ])("rechecks business settings and destination binding: %p %p", async (businessChange, conversationChange, reason) => {
    Business.findById.mockResolvedValue({ ...business, ...businessChange });
    Conversation.findOne.mockResolvedValue({ lead: "lead-1", customerPhone: "+14045550101", ...conversationChange });
    const result = await sendSms({ business, to: "+14045550101", body: "Prepared reply",
      directResponse: true, conversationId: "conversation-1", leadId: "lead-1", source: "inbound_sms_reply" });
    expect(result).toMatchObject({ suppressed: true, reason });
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  test.each([false, true])("fixed emergency preserves opt-out=%s at the provider boundary", async optedOut => {
    setBeforeSmsProviderSendHookForTests(null);
    isSmsSuppressed.mockResolvedValue(optedOut);
    Conversation.findOne.mockResolvedValue({ lead: "lead-1", customerPhone: "+14045550101", humanTakeover: true, aiEnabled: false, status: "open" });
    mockMessagesCreate.mockResolvedValueOnce({ sid: "SM_SAFETY", status: "queued" });
    const result = await sendSms({ business, to: "+14045550101", body: "Leave the area and call emergency services.",
      directResponse: true, conversationId: "conversation-1", leadId: "lead-1", source: "inbound_sms_reply", usageCategory: "safety",
      metadata: { aiGenerated: false, generatedBy: "guardrail", fixedEmergencyReply: true, messageCategory: "emergency", decision: "send_fixed_response" } });
    if (optedOut) { expect(result.suppressed).toBe(true); expect(mockMessagesCreate).not.toHaveBeenCalled(); }
    else { expect(result.sid).toBe("SM_SAFETY"); expect(mockMessagesCreate).toHaveBeenCalledTimes(1); }
  });

  test("eligible automated reply still reaches the provider once", async () => {
    Conversation.findOne.mockResolvedValue({ lead: "lead-1", customerPhone: "+14045550101", aiEnabled: true });
    mockMessagesCreate.mockResolvedValueOnce({ sid: "SM_ELIGIBLE", status: "queued" });
    const result = await sendSms({ business, to: "+14045550101", body: "Prepared reply",
      directResponse: true, conversationId: "conversation-1", leadId: "lead-1", source: "inbound_sms_reply" });
    expect(result).toMatchObject({ sid: "SM_ELIGIBLE" });
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });
});
