
import request from "supertest";
import mongoose from "mongoose";

import app from "../../src/app.js";
import Alert from "../../src/models/alert.js";
import Business from "../../src/models/business.js";
import CallLog from "../../src/models/callLog.js";
import ContactPreference from "../../src/models/contactPreference.js";
import Conversation from "../../src/models/conversation.js";
import Message from "../../src/models/message.js";
import WebhookEvent from "../../src/models/webhookEvent.js";
import {
  generateAIReplyResult,
} from "../../src/services/aiReplyService.js";
import {
  resetTwilioClient,
} from "../../src/services/twilioSmsService.js";
import {
  connectTestDB,
  clearTestDB,
  closeTestDB,
} from "../setup/testDb.js";

const mockTwilioMessageCreate = jest.fn();

jest.mock("twilio", () => {
  const twilioMock = jest.fn(() => ({
    messages: {
      create: mockTwilioMessageCreate,
    },
  }));

  twilioMock.validateRequest = jest.fn(() => true);

  return twilioMock;
});

jest.mock("../../src/services/aiReplyService.js", () => ({
  generateAIReplyResult: jest.fn(),
}));

beforeAll(async () => {
  process.env.TWILIO_ACCOUNT_SID = "AC_TEST";
  process.env.TWILIO_AUTH_TOKEN = "AUTH_TEST";

  await connectTestDB();

  await Promise.all([
    Alert.init(),
    CallLog.init(),
    ContactPreference.init(),
    Message.init(),
    WebhookEvent.init(),
  ]);
}, 30000);

beforeEach(() => {
  let sidSequence = 0;

  mockTwilioMessageCreate.mockImplementation(async () => {
    sidSequence += 1;

    return {
      sid: `SM_COMMAND_${sidSequence}`,
      status: "queued",
    };
  });

  generateAIReplyResult.mockResolvedValue({
    decision: "send",
    actionType: "request_information",
    messageCategory: "new_service_request",
    reply: "What service do you need help with?",
    serviceNeeded: "",
    urgency: "medium",
    address: "",
    preferredAppointmentTime: "",
    leadQualityScore: 50,
    estimatedValue: 0,
    summary: "",
    shouldAlertOwner: false,
    alertPriority: "low",
    alertTitle: "",
    alertMessage: "",
    riskFlags: [],
    confidence: 90,
    guardrail: {
      skipAI: false,
      reason: "",
      usedFallback: false,
      violations: [],
    },
  });
});

afterEach(async () => {
  jest.clearAllMocks();
  resetTwilioClient();
  await clearTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

const createBusiness = async (overrides = {}) => {
  return Business.create({
    owner: new mongoose.Types.ObjectId(),
    businessName: "Atlanta Pro Plumbing",
    businessType: "plumbing",
    phone: "4045551234",
    trackingNumber: { provider: "twilio", status: "active" },
    estimatedJobValue: 800,
    isActive: true,
    ...overrides,
  });
};

const sendSmsWebhook = (body, messageSid) => {
  return request(app).post("/api/twilio/sms").type("form").send({
    From: "4045559999",
    To: "4045551234",
    Body: body,
    MessageSid: messageSid,
  });
};

const sendMissedCall = (callSid = "CA_AFTER_STOP_123") => {
  return request(app).post("/api/twilio/voice").type("form").send({
    From: "4045559999",
    To: "4045551234",
    CallSid: callSid,
    CallStatus: "no-answer",
  });
};

describe("Twilio SMS opt-out handling", () => {
  test("STOP persists opt-out and suppresses a future missed-call SMS", async () => {
    const business = await createBusiness();

    const stopResponse = await sendSmsWebhook("STOP", "SM_STOP_123");

    expect(stopResponse.status).toBe(200);
    expect(generateAIReplyResult).not.toHaveBeenCalled();

    const preference = await ContactPreference.findOne({
      business: business._id,
      phone: "+14045559999",
    });

    expect(preference).toBeTruthy();
    expect(preference.smsStatus).toBe("opted_out");
    expect(preference.optedOutAt).toBeTruthy();

    const conversationAfterStop = await Conversation.findOne({
      business: business._id,
      customerPhone: "4045559999",
    });

    expect(conversationAfterStop.aiEnabled).toBe(false);

    /*
     * The first provider call is the STOP confirmation. A later missed call
     * must not create another provider send.
     */
    expect(mockTwilioMessageCreate).toHaveBeenCalledTimes(1);

    const voiceResponse = await sendMissedCall();

    expect(voiceResponse.status).toBe(200);
    expect(mockTwilioMessageCreate).toHaveBeenCalledTimes(1);

    const callLog = await CallLog.findOne({
      business: business._id,
      providerCallId: "CA_AFTER_STOP_123",
    });

    expect(callLog).toBeTruthy();
    expect(callLog.missedCallTextSent).toBe(false);
    expect(callLog.recovered).toBe(false);

    const outboundMessages = await Message.find({
      business: business._id,
      direction: "outbound",
    });

    expect(outboundMessages).toHaveLength(1);
    expect(outboundMessages[0].body).toMatch(/unsubscribed/i);
  });

  test("START reactivates SMS and allows the next missed-call message", async () => {
    const business = await createBusiness();

    await sendSmsWebhook("STOP", "SM_STOP_START_1");
    await sendSmsWebhook("START", "SM_STOP_START_2");

    const preference = await ContactPreference.findOne({
      business: business._id,
      phone: "+14045559999",
    });

    expect(preference.smsStatus).toBe("active");
    expect(preference.optedInAt).toBeTruthy();
    expect(preference.optedOutAt).toBeNull();

    const conversation = await Conversation.findOne({
      business: business._id,
      customerPhone: "4045559999",
    });

    expect(conversation.aiEnabled).toBe(true);

    await sendMissedCall("CA_AFTER_START_123");

    expect(mockTwilioMessageCreate).toHaveBeenCalledTimes(3);

    const callLog = await CallLog.findOne({
      business: business._id,
      providerCallId: "CA_AFTER_START_123",
    });

    expect(callLog.missedCallTextSent).toBe(true);
    expect(callLog.recovered).toBe(false);

    const outboundMessages = await Message.find({
      business: business._id,
      direction: "outbound",
    });

    expect(outboundMessages).toHaveLength(3);
  });

  test("HELP sends the fixed response without running qualification", async () => {
    const business = await createBusiness();

    const response = await sendSmsWebhook("HELP", "SM_HELP_123");

    expect(response.status).toBe(200);
    expect(generateAIReplyResult).not.toHaveBeenCalled();
    expect(mockTwilioMessageCreate).toHaveBeenCalledTimes(1);

    const outboundMessage = await Message.findOne({
      business: business._id,
      direction: "outbound",
    });

    expect(outboundMessage).toBeTruthy();
    expect(outboundMessage.body).toMatch(/automated service assistant/i);

    expect(
      await ContactPreference.countDocuments({
        business: business._id,
      }),
    ).toBe(0);
  });

  test("an emergency bypasses ordinary AI and enables human takeover", async () => {
    const business = await createBusiness();

    /*
     * The real deterministic guardrail runs inside generateAIReplyResult in
     * production. This mocked result represents that contract at the
     * controller boundary.
     */
    generateAIReplyResult.mockResolvedValueOnce({
      decision: "alert_owner",
      actionType: "send_fixed_response",
      messageCategory: "emergency",
      reply:
        "If you smell gas, leave the building now and call 911 from a safe location.",
      serviceNeeded: "",
      urgency: "emergency",
      address: "",
      preferredAppointmentTime: "",
      leadQualityScore: 90,
      estimatedValue: 0,
      summary: "Gas safety emergency detected.",
      shouldAlertOwner: true,
      alertPriority: "critical",
      alertTitle: "Emergency safety concern detected",
      alertMessage: "Customer reported a possible gas leak.",
      riskFlags: ["safety_hazard"],
      confidence: 100,
      guardrail: {
        skipAI: true,
        reason: "safety_hazard_detected:gas",
        usedFallback: false,
        violations: [],
      },
    });

    const response = await sendSmsWebhook(
      "I smell gas and feel dizzy",
      "SM_EMERGENCY_123",
    );

    expect(response.status).toBe(200);

    const conversation = await Conversation.findOne({
      business: business._id,
      customerPhone: "4045559999",
    });

    expect(conversation.humanTakeover).toBe(true);
    expect(conversation.aiEnabled).toBe(false);

    const criticalAlert = await Alert.findOne({
      business: business._id,
      dedupeKey: "human_handoff:SM_EMERGENCY_123",
    });

    expect(criticalAlert).toBeTruthy();
    expect(criticalAlert.priority).toBe("critical");
    // CALLBACKIQ_SMS_EMERGENCY_ALERT_CONTRACT_V1_0_3
    expect(criticalAlert.type).toBe("safety_emergency");
    expect(criticalAlert.actionRequired).toBe(true);
    expect(criticalAlert.dueAt).toBeTruthy();
    expect(String(criticalAlert.conversation)).toBe(
      String(conversation._id),
    );

    const customerReplyAlert = await Alert.findOne({
      business: business._id,
      dedupeKey: "customer_reply:SM_EMERGENCY_123",
    });

    expect(customerReplyAlert).toBeTruthy();
    expect(customerReplyAlert.priority).toBe("critical");
  });
});
