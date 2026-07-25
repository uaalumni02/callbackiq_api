
import request from "supertest";
import mongoose from "mongoose";

import app from "../../src/app.js";
import Business from "../../src/models/business.js";
import Conversation from "../../src/models/conversation.js";
import Lead from "../../src/models/lead.js";
import Message from "../../src/models/message.js";
import WebhookEvent from "../../src/models/webhookEvent.js";
import {
  generateAIReplyResult,
} from "../../src/services/aiReplyService.js";
import {
  sendSms,
} from "../../src/services/twilioSmsService.js";
import {
  connectTestDB,
  clearTestDB,
  closeTestDB,
} from "../setup/testDb.js";

jest.mock("../../src/services/aiReplyService.js", () => ({
  generateAIReplyResult: jest.fn(),
}));

jest.mock("../../src/services/twilioSmsService.js", () => ({
  sendSms: jest.fn(),
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
  await connectTestDB();
  await Promise.all([Message.init(), WebhookEvent.init()]);
});

beforeEach(() => {
  generateAIReplyResult.mockResolvedValue({
    ...defaultAIResult,
  });

  sendSms.mockResolvedValue({
    sid: "SM_AI_REPLY_123",
  });
});

afterEach(async () => {
  jest.clearAllMocks();
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
    email: "owner@atlantaproplumbing.com",
    estimatedJobValue: 800,
    smsTemplate:
      "Hi, this is {{businessName}}. Sorry we missed your call. What service do you need help with today?",
    ...overrides,
  });
};

describe("Twilio Routes", () => {
  describe("POST /api/twilio/sms", () => {
    test("creates the inbound workflow and guarded outbound reply", async () => {
      const business = await createBusiness();

      const response = await request(app)
        .post("/api/twilio/sms")
        .type("form")
        .send({
          From: "4045559999",
          To: "4045551234",
          Body: "I need help with a leaking water heater",
          MessageSid: "SM_INBOUND_123",
        });

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("text/xml");

      const lead = await Lead.findOne({
        business: business._id,
        phone: "4045559999",
      });

      expect(lead).toBeTruthy();
      expect(lead.source).toBe("sms");
      expect(lead.status).toBe("contacted");
      expect(lead.serviceNeeded).toBe("Water heater repair");

      const conversation = await Conversation.findOne({
        business: business._id,
        customerPhone: "4045559999",
      });

      expect(conversation).toBeTruthy();
      expect(conversation.status).toBe("open");
      expect(conversation.aiEnabled).toBe(true);
      expect(conversation.humanTakeover).toBe(false);

      const messages = await Message.find({
        business: business._id,
        conversation: conversation._id,
      }).sort({ createdAt: 1 });

      expect(messages).toHaveLength(2);
      expect(messages[0].direction).toBe("inbound");
      expect(messages[0].providerMessageId).toBe("SM_INBOUND_123");
      expect(messages[1].direction).toBe("outbound");
      expect(messages[1].providerMessageId).toBe("SM_AI_REPLY_123");

      expect(generateAIReplyResult).toHaveBeenCalledTimes(1);

      expect(sendSms).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "4045559999",
          from: "4045551234",
          businessId: business._id,
        }),
      );
    });

    test("updates an existing new lead to contacted", async () => {
      const business = await createBusiness();

      const lead = await Lead.create({
        business: business._id,
        customerName: "",
        phone: "4045559999",
        serviceNeeded: "Unknown - missed call follow-up needed",
        urgency: "medium",
        status: "new",
        source: "missed_call",
      });

      const response = await request(app)
        .post("/api/twilio/sms")
        .type("form")
        .send({
          From: "4045559999",
          To: "4045551234",
          Body: "Yes I still need service",
          MessageSid: "SM_CONTACTED_123",
        });

      expect(response.status).toBe(200);

      const updatedLead = await Lead.findById(lead._id);

      expect(updatedLead.status).toBe("contacted");
    });

    test("does not downgrade a booked lead", async () => {
      const business = await createBusiness();

      const lead = await Lead.create({
        business: business._id,
        customerName: "Booked Customer",
        phone: "4045559999",
        serviceNeeded: "Water heater repair",
        urgency: "high",
        status: "booked",
        source: "manual",
      });

      const response = await request(app)
        .post("/api/twilio/sms")
        .type("form")
        .send({
          From: "4045559999",
          To: "4045551234",
          Body: "Thanks, see you soon",
          MessageSid: "SM_BOOKED_123",
        });

      expect(response.status).toBe(200);

      const updatedLead = await Lead.findById(lead._id);

      expect(updatedLead.status).toBe("booked");
    });

    test("does not send a reply when human takeover is active", async () => {
      const business = await createBusiness();

      const lead = await Lead.create({
        business: business._id,
        customerName: "Manual Customer",
        phone: "4045559999",
        serviceNeeded: "Pipe repair",
        urgency: "medium",
        status: "contacted",
        source: "manual",
      });

      await Conversation.create({
        business: business._id,
        lead: lead._id,
        customerPhone: "4045559999",
        customerName: "Manual Customer",
        status: "open",
        aiEnabled: false,
        humanTakeover: true,
      });

      const response = await request(app)
        .post("/api/twilio/sms")
        .type("form")
        .send({
          From: "4045559999",
          To: "4045551234",
          Body: "Can someone call me?",
          MessageSid: "SM_HUMAN_123",
        });

      expect(response.status).toBe(200);
      expect(generateAIReplyResult).not.toHaveBeenCalled();
      expect(sendSms).not.toHaveBeenCalled();

      expect(
        await Message.countDocuments({
          business: business._id,
          direction: "outbound",
        }),
      ).toBe(0);
    });

    test("honors no_reply decisions", async () => {
      const business = await createBusiness();

      generateAIReplyResult.mockResolvedValueOnce({
        ...defaultAIResult,
        decision: "no_reply",
        actionType: "no_reply",
        reply: "",
      });

      const response = await request(app)
        .post("/api/twilio/sms")
        .type("form")
        .send({
          From: "4045559999",
          To: "4045551234",
          Body: "Repeated spam",
          MessageSid: "SM_NO_REPLY_123",
        });

      expect(response.status).toBe(200);
      expect(sendSms).not.toHaveBeenCalled();

      expect(
        await Message.countDocuments({
          business: business._id,
          direction: "outbound",
        }),
      ).toBe(0);
    });

    test("returns empty TwiML and creates nothing when no business exists", async () => {
      const response = await request(app)
        .post("/api/twilio/sms")
        .type("form")
        .send({
          From: "4045559999",
          To: "4045551234",
          Body: "Hello",
          MessageSid: "SM_NO_BUSINESS",
        });

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("text/xml");

      expect(await Lead.countDocuments()).toBe(0);
      expect(await Conversation.countDocuments()).toBe(0);
      expect(await Message.countDocuments()).toBe(0);
      expect(await WebhookEvent.countDocuments()).toBe(0);
    });
  });
});
