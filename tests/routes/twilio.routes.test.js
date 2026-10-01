import Alert from '../../src/models/alert.js';
import ServiceOffering from '../../src/models/serviceOffering.js';

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
}, 20_000);

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
  const business = await Business.create({
    owner: new mongoose.Types.ObjectId(),
    businessName: "Atlanta Pro Plumbing",
    businessType: "plumbing",
    phone: "4045551234",
    trackingNumber: { provider: "twilio", status: "active" },
    email: "owner@atlantaproplumbing.com",
    estimatedJobValue: 800,
    smsTemplate:
      "Hi, this is {{businessName}}. Sorry we missed your call. What service do you need help with today?",
    ...overrides,
  });
  await ServiceOffering.create({ business: business._id, name: 'Water heater repair', category: 'plumbing', active: true, aiCanDiscuss: true, aiCanBook: true, keywords: ['water heater'] });
  return business;
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
          to: "+14045559999",
          from: "+14045551234",
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

    test.each([
      ['Can someone call me?', 'callback'],
      ['Did you get my text?', 'receipt'],
      ['The pipe is under the kitchen sink', 'ordinary'],
    ])('staff takeover preserves ownership for %s (%s)', async (body, kind) => {
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

      const ownedConversation = await Conversation.create({
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
          Body: body,
          MessageSid: "SM_HUMAN_123",
        });

      expect(response.status).toBe(200);
      expect(generateAIReplyResult).not.toHaveBeenCalled();
      const expectedReplies = kind === 'ordinary' ? 0 : 1;
      expect(sendSms).toHaveBeenCalledTimes(expectedReplies);
      expect(await Message.countDocuments({
        business: business._id,
        direction: 'outbound',
      })).toBe(expectedReplies);

      const updatedConversation = await Conversation.findById(ownedConversation._id);
      const updatedLead = await Lead.findById(lead._id);
      expect(updatedConversation.humanTakeover).toBe(true);
      expect(updatedConversation.aiEnabled).toBe(false);
      expect(String(updatedConversation.lead)).toBe(String(lead._id));
      expect(updatedLead.serviceNeeded).toBe('Pipe repair');
      expect(updatedLead.status).toBe('contacted');

      if (kind !== 'ordinary') {
        const sent = sendSms.mock.calls[0][0];
        expect(sent).toMatchObject({ actorType: 'webhook', directResponse: true,
          metadata: { aiGenerated: false, generatedBy: 'guardrail' } });
        expect(sent.body).toContain('A response time is not guaranteed.');
        expect(sent.body).not.toMatch(/keep helping|will call you|appointment is confirmed/i);
      }
      const contact = updatedConversation.conversationMemory?.recoveryIntake?.contactControl;
      if (kind === 'callback') {
        expect(sendSms.mock.calls[0][0].body).toMatch(/callback request is saved/);
        expect(contact.request.kind).toBe('callback');
        expect(contact.request.alertId).toBeTruthy();
        const staffTask = await Alert.findById(contact.request.alertId);
        expect(staffTask).not.toBeNull();
        expect(staffTask.actionRequired).toBe(true);
        expect(staffTask.metadata.callbackRequested).toBe(true);
        expect(String(staffTask.business)).toBe(String(business._id));
        expect(String(staffTask.conversation)).toBe(String(ownedConversation._id));
      } else if (kind === 'receipt') {
        expect(sendSms.mock.calls[0][0].body).toMatch(/your message was received/i);
        expect(sendSms.mock.calls[0][0].body).not.toMatch(/saved for review/);
        expect(contact?.request).toBeUndefined();
        expect(contact?.receiptReply?.at).toBeTruthy();
      }
    });

    test("honors intentional spam no_reply decisions", async () => {
      const business = await createBusiness();

      generateAIReplyResult.mockResolvedValueOnce({
        ...defaultAIResult,
        decision: "no_reply",
        actionType: "no_reply",
        messageCategory: "possible_spam",
        serviceNeeded: "",
        summary: "Repeated spam; no response required.",
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
      expect(generateAIReplyResult).toHaveBeenCalledTimes(1);
      expect(sendSms).not.toHaveBeenCalled();

      expect(
        await Message.countDocuments({
          business: business._id,
          direction: "outbound",
        }),
      ).toBe(0);
    });

    test("routes unexplained model silence on a service request to staff review", async () => {
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
          Body: "My water heater needs repair",
          MessageSid: "SM_UNEXPECTED_SILENCE_123",
        });
      expect(response.status).toBe(200);
      expect(generateAIReplyResult).toHaveBeenCalledTimes(1);
      expect(sendSms).toHaveBeenCalledTimes(1);
      expect(sendSms).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.stringContaining("not a confirmed appointment"),
        metadata: expect.objectContaining({
          decision: "send_fixed_response",
          handoffReason: "intake_unclear",
          handoffRequired: true,
        }),
      }));
      expect(await Message.countDocuments({ business: business._id, direction: "outbound" })).toBe(1);
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

      expect(response.status).toBe(404);
      expect(response.headers["content-type"]).toContain("text/xml");

      expect(await Lead.countDocuments()).toBe(0);
      expect(await Conversation.countDocuments()).toBe(0);
      expect(await Message.countDocuments()).toBe(0);
      expect(await WebhookEvent.countDocuments()).toBe(0);
    });
  });
});
