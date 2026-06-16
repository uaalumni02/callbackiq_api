import request from "supertest";
import mongoose from "mongoose";

import app from "../../src/app.js";
import Business from "../../src/models/business.js";
import CallLog from "../../src/models/callLog.js";
import Lead from "../../src/models/lead.js";
import Conversation from "../../src/models/conversation.js";
import Message from "../../src/models/message.js";
import { connectTestDB, clearTestDB, closeTestDB } from "../setup/testDb.js";

jest.mock("twilio", () => {
  const twilioMock = jest.fn(() => ({
    messages: {
      create: jest.fn().mockResolvedValue({
        sid: "SM_TEST_123",
      }),
    },
  }));

  twilioMock.twiml = {
    VoiceResponse: class {
      constructor() {
        this.output = "<Response>";
      }

      dial(options = {}) {
        this.output += `<Dial action="${options.action}" method="${options.method}">`;
        return {
          number: (phone) => {
            this.output += `<Number>${phone}</Number></Dial>`;
          },
        };
      }

      say(message) {
        this.output += `<Say>${message}</Say>`;
      }

      toString() {
        return `${this.output}</Response>`;
      }
    },

    MessagingResponse: class {
      toString() {
        return "<Response></Response>";
      }
    },
  };

  return twilioMock;
});

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
  describe("POST /api/twilio/voice", () => {
    test("creates a Twilio call log and returns TwiML dial response", async () => {
      await createBusiness();

      const res = await request(app)
        .post("/api/twilio/voice")
        .type("form")
        .send({
          From: "4045559999",
          To: "4045551234",
          CallSid: "CA_TEST_123",
        });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/xml");
      expect(res.text).toContain("<Response>");
      expect(res.text).toContain("<Dial");
      expect(res.text).toContain("<Number>4045551234</Number>");

      const savedCallLog = await CallLog.findOne({
        providerCallId: "CA_TEST_123",
      });

      expect(savedCallLog).toBeTruthy();
      expect(savedCallLog.from).toBe("4045559999");
      expect(savedCallLog.to).toBe("4045551234");
      expect(savedCallLog.direction).toBe("inbound");
      expect(savedCallLog.status).toBe("missed");
      expect(savedCallLog.provider).toBe("twilio");
      expect(savedCallLog.missedCallTextSent).toBe(false);
      expect(savedCallLog.recovered).toBe(false);
    });

    test("returns TwiML message when no business exists", async () => {
      const res = await request(app)
        .post("/api/twilio/voice")
        .type("form")
        .send({
          From: "4045559999",
          To: "4045551234",
          CallSid: "CA_NO_BUSINESS",
        });

      expect(res.status).toBe(200);
      expect(res.text).toContain("No business is configured for this number.");

      const savedCallLog = await CallLog.findOne({
        providerCallId: "CA_NO_BUSINESS",
      });

      expect(savedCallLog).toBeFalsy();
    });

    test("uses first business fallback if phone lookup does not match", async () => {
      const business = await createBusiness({
        phone: "4047778888",
      });

      const res = await request(app)
        .post("/api/twilio/voice")
        .type("form")
        .send({
          From: "4045559999",
          To: "4040000000",
          CallSid: "CA_FALLBACK",
        });

      expect(res.status).toBe(200);

      const savedCallLog = await CallLog.findOne({
        providerCallId: "CA_FALLBACK",
      });

      expect(savedCallLog).toBeTruthy();
      expect(String(savedCallLog.business)).toBe(String(business._id));
      expect(savedCallLog.to).toBe("4040000000");
    });
  });

  describe("POST /api/twilio/status", () => {
    test("no-answer status creates lead, conversation, outbound message, and updates call log", async () => {
      const business = await createBusiness();

      const callLog = await CallLog.create({
        business: business._id,
        from: "4045559999",
        to: "4045551234",
        direction: "inbound",
        status: "missed",
        durationSeconds: 0,
        provider: "twilio",
        providerCallId: "CA_STATUS_123",
        missedCallTextSent: false,
        recovered: false,
      });

      const res = await request(app)
        .post(`/api/twilio/status?callLogId=${callLog._id}`)
        .type("form")
        .send({
          CallSid: "CA_STATUS_123",
          DialCallStatus: "no-answer",
          DialCallDuration: "0",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.callStatus).toBe("no_answer");
      expect(res.body.data.durationSeconds).toBe(0);

      const updatedCallLog = await CallLog.findById(callLog._id);

      expect(updatedCallLog.status).toBe("no_answer");
      expect(updatedCallLog.durationSeconds).toBe(0);
      expect(updatedCallLog.missedCallTextSent).toBe(true);
      expect(updatedCallLog.lead).toBeTruthy();
      expect(updatedCallLog.conversation).toBeTruthy();

      const lead = await Lead.findOne({
        business: business._id,
        phone: "4045559999",
      });

      expect(lead).toBeTruthy();
      expect(lead.source).toBe("missed_call");
      expect(lead.status).toBe("new");
      expect(lead.estimatedValue).toBe(800);

      const conversation = await Conversation.findOne({
        business: business._id,
        customerPhone: "4045559999",
      });

      expect(conversation).toBeTruthy();
      expect(conversation.status).toBe("open");
      expect(conversation.lastMessage).toContain("Atlanta Pro Plumbing");
      expect(conversation.lastMessageAt).toBeTruthy();

      const message = await Message.findOne({
        business: business._id,
        conversation: conversation._id,
        direction: "outbound",
      });

      expect(message).toBeTruthy();
      expect(message.to).toBe("4045559999");
      expect(message.from).toBe("4041112222");
      expect(message.provider).toBe("twilio");
      expect(message.providerMessageId).toBe("SM_TEST_123");
      expect(message.status).toBe("sent");
      expect(message.body).toContain("Atlanta Pro Plumbing");
    });

    test("completed call with duration does not trigger missed-call recovery", async () => {
      const business = await createBusiness();

      const callLog = await CallLog.create({
        business: business._id,
        from: "4045559999",
        to: "4045551234",
        direction: "inbound",
        status: "missed",
        durationSeconds: 0,
        provider: "twilio",
        providerCallId: "CA_ANSWERED_123",
      });

      const res = await request(app)
        .post(`/api/twilio/status?callLogId=${callLog._id}`)
        .type("form")
        .send({
          CallSid: "CA_ANSWERED_123",
          DialCallStatus: "completed",
          DialCallDuration: "120",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.callStatus).toBe("answered");

      const updatedCallLog = await CallLog.findById(callLog._id);

      expect(updatedCallLog.status).toBe("answered");
      expect(updatedCallLog.durationSeconds).toBe(120);
      expect(updatedCallLog.missedCallTextSent).toBe(false);

      const leads = await Lead.find({});
      const conversations = await Conversation.find({});
      const messages = await Message.find({});

      expect(leads.length).toBe(0);
      expect(conversations.length).toBe(0);
      expect(messages.length).toBe(0);
    });

    test("busy status triggers missed-call recovery", async () => {
      const business = await createBusiness();

      const callLog = await CallLog.create({
        business: business._id,
        from: "4045557777",
        to: "4045551234",
        direction: "inbound",
        status: "missed",
        durationSeconds: 0,
        provider: "twilio",
        providerCallId: "CA_BUSY_123",
      });

      const res = await request(app)
        .post(`/api/twilio/status?callLogId=${callLog._id}`)
        .type("form")
        .send({
          CallSid: "CA_BUSY_123",
          DialCallStatus: "busy",
          DialCallDuration: "0",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.callStatus).toBe("busy");

      const lead = await Lead.findOne({
        phone: "4045557777",
      });

      const conversation = await Conversation.findOne({
        customerPhone: "4045557777",
      });

      const message = await Message.findOne({
        to: "4045557777",
        direction: "outbound",
      });

      expect(lead).toBeTruthy();
      expect(conversation).toBeTruthy();
      expect(message).toBeTruthy();
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
      });

      const callLog = await CallLog.create({
        business: business._id,
        from: "4045559999",
        to: "4045551234",
        direction: "inbound",
        status: "missed",
        durationSeconds: 0,
        provider: "twilio",
        providerCallId: "CA_EXISTING_123",
      });

      const res = await request(app)
        .post(`/api/twilio/status?callLogId=${callLog._id}`)
        .type("form")
        .send({
          CallSid: "CA_EXISTING_123",
          DialCallStatus: "no-answer",
          DialCallDuration: "0",
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

    test("returns success when no matching call log is found", async () => {
      await createBusiness();

      const res = await request(app)
        .post("/api/twilio/status")
        .type("form")
        .send({
          CallSid: "CA_DOES_NOT_EXIST",
          DialCallStatus: "no-answer",
          DialCallDuration: "0",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe("No matching call log found");
    });
  });

  describe("POST /api/twilio/sms", () => {
    test("inbound SMS creates lead, conversation, and inbound message", async () => {
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
      expect(lead.status).toBe("contacted");
      expect(lead.source).toBe("sms");
      expect(lead.notes).toBe("I need help with a leaking water heater");

      const conversation = await Conversation.findOne({
        business: business._id,
        customerPhone: "4045559999",
      });

      expect(conversation).toBeTruthy();
      expect(conversation.lastMessage).toBe(
        "I need help with a leaking water heater",
      );

      const message = await Message.findOne({
        business: business._id,
        conversation: conversation._id,
        direction: "inbound",
      });

      expect(message).toBeTruthy();
      expect(message.from).toBe("4045559999");
      expect(message.to).toBe("4045551234");
      expect(message.body).toBe("I need help with a leaking water heater");
      expect(message.provider).toBe("twilio");
      expect(message.providerMessageId).toBe("SM_INBOUND_123");
      expect(message.status).toBe("received");
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

    test("returns empty TwiML and creates nothing when no business exists", async () => {
      const res = await request(app).post("/api/twilio/sms").type("form").send({
        From: "4045559999",
        To: "4045551234",
        Body: "Hello",
        MessageSid: "SM_NO_BUSINESS",
      });

      expect(res.status).toBe(200);
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
