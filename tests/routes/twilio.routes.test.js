import request from "supertest";
import mongoose from "mongoose";

import app from "../../src/app.js";
import Business from "../../src/models/business.js";
import Lead from "../../src/models/lead.js";
import Conversation from "../../src/models/conversation.js";
import Message from "../../src/models/message.js";
import { connectTestDB, clearTestDB, closeTestDB } from "../setup/testDb.js";

jest.mock("../../src/services/aiReplyService.js", () => ({
  generateAIReply: jest
    .fn()
    .mockResolvedValue(
      "Thanks for reaching out. What service do you need help with today?",
    ),
}));

jest.mock("../../src/services/twilioSmsService.js", () => ({
  sendSms: jest.fn().mockResolvedValue({
    sid: "SM_AI_REPLY_123",
  }),
}));

beforeAll(async () => {
  process.env.TWILIO_ACCOUNT_SID = "AC_TEST";
  process.env.TWILIO_AUTH_TOKEN = "AUTH_TEST";
  process.env.TWILIO_PHONE_NUMBER = "4041112222";
  process.env.PUBLIC_API_URL = "http://localhost:3000";

  await connectTestDB();
});

afterEach(async () => {
  await clearTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

const createBusiness = async (overrides = {}) => {
  return await Business.create({
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
    test("inbound SMS creates lead, conversation, inbound message, and AI outbound message", async () => {
      const business = await createBusiness();

      const res = await request(app).post("/api/twilio/sms").type("form").send({
        From: "4045559999",
        To: "4045551234",
        Body: "I need help with a leaking water heater",
        MessageSid: "SM_INBOUND_123",
      });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/xml");
      expect(res.text).toContain("<Response>");

      const lead = await Lead.findOne({
        business: business._id,
        phone: "4045559999",
      });

      expect(lead).toBeTruthy();
      expect(lead.source).toBe("sms");
      expect(lead.status).toBe("contacted");

      const conversation = await Conversation.findOne({
        business: business._id,
        customerPhone: "4045559999",
      });

      expect(conversation).toBeTruthy();
      expect(conversation.status).toBe("open");
      expect(conversation.aiEnabled).toBe(true);
      expect(conversation.humanTakeover).toBe(false);
      expect(conversation.lastMessageAt).toBeTruthy();

      const inboundMessage = await Message.findOne({
        business: business._id,
        conversation: conversation._id,
        direction: "inbound",
      });

      expect(inboundMessage).toBeTruthy();
      expect(inboundMessage.from).toBe("4045559999");
      expect(inboundMessage.to).toBe("4045551234");
      expect(inboundMessage.body).toBe(
        "I need help with a leaking water heater",
      );
      expect(inboundMessage.provider).toBe("twilio");
      expect(inboundMessage.providerMessageId).toBe("SM_INBOUND_123");
      expect(inboundMessage.status).toBe("received");

      const outboundMessage = await Message.findOne({
        business: business._id,
        conversation: conversation._id,
        direction: "outbound",
      });

      expect(outboundMessage).toBeTruthy();
      expect(outboundMessage.from).toBe("4045551234");
      expect(outboundMessage.to).toBe("4045559999");
      expect(outboundMessage.body).toContain("Thanks for reaching out");
      expect(outboundMessage.provider).toBe("twilio");
      expect(outboundMessage.providerMessageId).toBe("SM_AI_REPLY_123");
      expect(outboundMessage.status).toBe("sent");
    });

    test("inbound SMS updates existing new lead to contacted", async () => {
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

      const res = await request(app).post("/api/twilio/sms").type("form").send({
        From: "4045559999",
        To: "4045551234",
        Body: "Yes I still need service",
        MessageSid: "SM_CONTACTED_123",
      });

      expect(res.status).toBe(200);

      const updatedLead = await Lead.findById(lead._id);

      expect(updatedLead.status).toBe("contacted");

      const message = await Message.findOne({
        lead: lead._id,
        direction: "inbound",
      });

      expect(message).toBeTruthy();
      expect(message.body).toBe("Yes I still need service");
    });

    test("inbound SMS does not downgrade booked lead status", async () => {
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

      const res = await request(app).post("/api/twilio/sms").type("form").send({
        From: "4045559999",
        To: "4045551234",
        Body: "Thanks, see you soon",
        MessageSid: "SM_BOOKED_123",
      });

      expect(res.status).toBe(200);

      const updatedLead = await Lead.findById(lead._id);

      expect(updatedLead.status).toBe("booked");
    });

    test("does not duplicate lead or conversation for same customer phone", async () => {
      const business = await createBusiness();

      const existingLead = await Lead.create({
        business: business._id,
        customerName: "Existing Customer",
        phone: "4045559999",
        serviceNeeded: "Drain cleaning",
        urgency: "medium",
        status: "new",
        source: "manual",
      });

      const existingConversation = await Conversation.create({
        business: business._id,
        lead: existingLead._id,
        customerPhone: "4045559999",
        customerName: "Existing Customer",
        status: "open",
        aiEnabled: true,
        humanTakeover: false,
      });

      const res = await request(app).post("/api/twilio/sms").type("form").send({
        From: "4045559999",
        To: "4045551234",
        Body: "Following up again",
        MessageSid: "SM_EXISTING_123",
      });

      expect(res.status).toBe(200);

      const leads = await Lead.find({
        business: business._id,
        phone: "4045559999",
      });

      const conversations = await Conversation.find({
        business: business._id,
        customerPhone: "4045559999",
      });

      expect(leads.length).toBe(1);
      expect(conversations.length).toBe(1);
      expect(String(leads[0]._id)).toBe(String(existingLead._id));
      expect(String(conversations[0]._id)).toBe(
        String(existingConversation._id),
      );
    });

    test("does not send AI reply when human takeover is enabled", async () => {
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

      const res = await request(app).post("/api/twilio/sms").type("form").send({
        From: "4045559999",
        To: "4045551234",
        Body: "Can someone call me?",
        MessageSid: "SM_HUMAN_123",
      });

      expect(res.status).toBe(200);

      const outboundMessages = await Message.find({
        business: business._id,
        direction: "outbound",
      });

      expect(outboundMessages.length).toBe(0);
    });

    test("returns empty TwiML and creates nothing when no business exists", async () => {
      const res = await request(app).post("/api/twilio/sms").type("form").send({
        From: "4045559999",
        To: "4045551234",
        Body: "Hello",
        MessageSid: "SM_NO_BUSINESS",
      });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/xml");
      expect(res.text).toContain("<Response>");

      const leads = await Lead.find({});
      const conversations = await Conversation.find({});
      const messages = await Message.find({});

      expect(leads.length).toBe(0);
      expect(conversations.length).toBe(0);
      expect(messages.length).toBe(0);
    });

    test("returns empty TwiML when SMS payload is missing required fields", async () => {
      await createBusiness();

      const res = await request(app).post("/api/twilio/sms").type("form").send({
        From: "4045559999",
      });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/xml");
      expect(res.text).toContain("<Response>");

      const leads = await Lead.find({});
      const conversations = await Conversation.find({});
      const messages = await Message.find({});

      expect(leads.length).toBe(0);
      expect(conversations.length).toBe(0);
      expect(messages.length).toBe(0);
    });
  });
});
