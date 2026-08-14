
import request from "supertest";
import mongoose from "mongoose";

import app from "../../src/app.js";
import Alert from "../../src/models/alert.js";
import Business from "../../src/models/business.js";
import CallLog from "../../src/models/callLog.js";
import ContactPreference from "../../src/models/contactPreference.js";
import Conversation from "../../src/models/conversation.js";
import Lead from "../../src/models/lead.js";
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

const defaultAIResult = {
  decision: "send",
  actionType: "request_information",
  messageCategory: "new_service_request",
  reply: "Thanks for reaching out. What service do you need help with today?",
  serviceNeeded: "Water heater repair",
  urgency: "medium",
  address: "",
  preferredAppointmentTime: "",
  leadQualityScore: 70,
  estimatedValue: 800,
  summary: "Customer needs water heater assistance.",
  shouldAlertOwner: false,
  alertPriority: "low",
  alertTitle: "",
  alertMessage: "",
  riskFlags: [],
  confidence: 95,
  guardrail: {
    skipAI: false,
    reason: "",
    usedFallback: false,
    violations: [],
  },
};

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
      sid: `SM_OUTBOUND_${sidSequence}`,
      status: "queued",
    };
  });

  generateAIReplyResult.mockResolvedValue({
    ...defaultAIResult,
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
    forwardingPhone: "4045557777",
    email: "owner@atlantaproplumbing.com",
    estimatedJobValue: 800,
    smsTemplate:
      "Hi, this is {{businessName}}. Sorry we missed your call. What service do you need help with today?",
    isActive: true,
    ...overrides,
  });
};

const sendInboundSms = (overrides = {}) => {
  return request(app).post("/api/twilio/sms").type("form").send({
    From: "4045559999",
    To: "4045551234",
    Body: "I need help with a leaking water heater",
    MessageSid: "SM_INBOUND_IDEMPOTENT_123",
    ...overrides,
  });
};

const sendVoiceWebhook = (overrides = {}) => {
  return request(app).post("/api/twilio/voice").type("form").send({
    From: "4045559999",
    To: "4045551234",
    CallSid: "CA_IDEMPOTENT_123",
    CallStatus: "no-answer",
    ...overrides,
  });
};

describe("Twilio webhook idempotency", () => {
  test("sequential duplicate SMS webhooks create one workflow", async () => {
    const business = await createBusiness();

    const first = await sendInboundSms();
    const second = await sendInboundSms();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const conversation = await Conversation.findOne({
      business: business._id,
      customerPhone: "4045559999",
    });

    expect(conversation).toBeTruthy();

    expect(
      await Lead.countDocuments({
        business: business._id,
        phone: "4045559999",
      }),
    ).toBe(1);

    expect(
      await Conversation.countDocuments({
        business: business._id,
        customerPhone: "4045559999",
      }),
    ).toBe(1);

    expect(
      await Message.countDocuments({
        business: business._id,
        conversation: conversation._id,
        direction: "inbound",
      }),
    ).toBe(1);

    expect(
      await Message.countDocuments({
        business: business._id,
        conversation: conversation._id,
        direction: "outbound",
      }),
    ).toBe(1);

    expect(
      await Alert.countDocuments({
        business: business._id,
        type: "customer_reply",
      }),
    ).toBe(1);

    expect(
      await WebhookEvent.countDocuments({
        business: business._id,
        eventType: "inbound_sms",
      }),
    ).toBe(1);

    expect(generateAIReplyResult).toHaveBeenCalledTimes(1);
    expect(mockTwilioMessageCreate).toHaveBeenCalledTimes(1);
  });

  test("concurrent duplicate SMS webhooks create one workflow", async () => {
    const business = await createBusiness();

    const responses = await Promise.all([
      sendInboundSms({
        MessageSid: "SM_CONCURRENT_123",
      }),
      sendInboundSms({
        MessageSid: "SM_CONCURRENT_123",
      }),
      sendInboundSms({
        MessageSid: "SM_CONCURRENT_123",
      }),
    ]);

    responses.forEach((response) => {
      expect(response.status).toBe(200);
    });

    expect(
      await Message.countDocuments({
        business: business._id,
        direction: "inbound",
        providerMessageId: "SM_CONCURRENT_123",
      }),
    ).toBe(1);

    expect(
      await Message.countDocuments({
        business: business._id,
        direction: "outbound",
      }),
    ).toBe(1);

    expect(
      await Lead.countDocuments({
        business: business._id,
        phone: "4045559999",
      }),
    ).toBe(1);

    expect(
      await Conversation.countDocuments({
        business: business._id,
        customerPhone: "4045559999",
      }),
    ).toBe(1);

    const event = await WebhookEvent.findOne({
      business: business._id,
      eventKey: "inbound_sms:SM_CONCURRENT_123",
    });

    expect(event).toBeTruthy();
    expect(event.duplicateCount).toBe(2);
    expect(generateAIReplyResult).toHaveBeenCalledTimes(1);
    expect(mockTwilioMessageCreate).toHaveBeenCalledTimes(1);
  });

  test("duplicate voice webhooks create one call and one missed-call SMS", async () => {
    const business = await createBusiness();

    const first = await sendVoiceWebhook();
    const second = await sendVoiceWebhook();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const callLog = await CallLog.findOne({
      business: business._id,
      providerCallId: "CA_IDEMPOTENT_123",
    });

    expect(callLog).toBeTruthy();
    expect(callLog.missedCallTextSent).toBe(true);
    expect(callLog.recovered).toBe(false);

    expect(
      await CallLog.countDocuments({
        business: business._id,
        providerCallId: "CA_IDEMPOTENT_123",
      }),
    ).toBe(1);

    expect(
      await Lead.countDocuments({
        business: business._id,
        phone: "4045559999",
      }),
    ).toBe(1);

    expect(
      await Conversation.countDocuments({
        business: business._id,
        customerPhone: "4045559999",
      }),
    ).toBe(1);

    expect(
      await Message.countDocuments({
        business: business._id,
        direction: "outbound",
      }),
    ).toBe(1);

    expect(
      await Alert.countDocuments({
        business: business._id,
        type: "missed_call",
      }),
    ).toBe(1);

    expect(
      await WebhookEvent.countDocuments({
        business: business._id,
        eventType: "inbound_voice",
      }),
    ).toBe(1);

    expect(mockTwilioMessageCreate).toHaveBeenCalledTimes(1);
  });

  test("duplicate status callbacks are recorded once", async () => {
    const business = await createBusiness();

    const payload = {
      From: "4045551234",
      To: "4045559999",
      MessageSid: "SM_STATUS_123",
      MessageStatus: "delivered",
    };

    const first = await request(app)
      .post("/api/twilio/status")
      .type("form")
      .send(payload);

    const second = await request(app)
      .post("/api/twilio/status")
      .type("form")
      .send(payload);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const event = await WebhookEvent.findOne({
      business: business._id,
      eventKey: "message_status:SM_STATUS_123:delivered",
    });

    expect(event).toBeTruthy();
    expect(event.duplicateCount).toBe(1);

    expect(
      await WebhookEvent.countDocuments({
        business: business._id,
        eventType: "message_status",
      }),
    ).toBe(1);
  });

  test("every stored Twilio message has a business and conversation", async () => {
    await createBusiness();

    await sendInboundSms({
      MessageSid: "SM_OWNERSHIP_123",
    });

    const messages = await Message.find({});

    expect(messages).toHaveLength(2);

    messages.forEach((message) => {
      expect(message.business).toBeTruthy();
      expect(message.conversation).toBeTruthy();
    });
  });
});
