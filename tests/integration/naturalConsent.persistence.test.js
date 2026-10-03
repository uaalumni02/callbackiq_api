
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

test.each(['stop sending me texts','Stop sending messages to this number','Please unsubscribe me','I want you to stop texting','Do not send me any more messages'])('natural consent withdrawal persists and suppresses later sends: %s',async text=>{
 const business=await createBusiness();
 const response=await sendSmsWebhook(text,'SM_NATURAL_STOP');expect(response.status).toBe(200);
 expect((await ContactPreference.findOne({business:business._id})).smsStatus).toBe('opted_out');
 const receipts=mockTwilioMessageCreate.mock.calls.length;
 await sendSmsWebhook('YES','SM_AFTER_NATURAL_STOP');await sendMissedCall();
 expect(generateAIReplyResult).not.toHaveBeenCalled();expect(mockTwilioMessageCreate).toHaveBeenCalledTimes(receipts);
});
