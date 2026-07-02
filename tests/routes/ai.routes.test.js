import request from "supertest";

import app from "../../src/app.js";
import Business from "../../src/models/business.js";
import Lead from "../../src/models/lead.js";
import Message from "../../src/models/message.js";
import Alert from "../../src/models/alert.js";
import Conversation from "../../src/models/conversation.js";
import Subscription from "../../src/models/subscription.js";
import { runFollowUpAgent } from "../../src/helpers/ai/followUpAgent.js";
import { connectTestDB, clearTestDB, closeTestDB } from "../setup/testDb.js";

jest.mock("../../src/helpers/ai/followUpAgent.js", () => ({
  runFollowUpAgent: jest.fn(),
}));

jest.mock("twilio", () => {
  const twilioMock = jest.fn(() => ({
    messages: {
      create: jest.fn().mockResolvedValue({
        sid: "SM_AGENT_TEST_123",
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
      constructor() {
        this.output = "<Response></Response>";
      }

      message(text) {
        this.output = `<Response><Message>${text}</Message></Response>`;
      }

      toString() {
        return this.output;
      }
    },
  };

  return twilioMock;
});

beforeAll(async () => {
  process.env.TWILIO_ACCOUNT_SID = "AC_TEST";
  process.env.TWILIO_AUTH_TOKEN = "AUTH_TEST";
  process.env.TWILIO_PHONE_NUMBER = "4041112222";

  await connectTestDB();
});

afterEach(async () => {
  jest.clearAllMocks();
  await clearTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

const createActiveSubscription = async (businessId, suffix = "agent") => {
  await Business.findByIdAndUpdate(
    businessId,
    { isActive: true },
    { returnDocument: "after" },
  );

  return await Subscription.findOneAndUpdate(
    { business: businessId },
    {
      business: businessId,
      stripeCustomerId: `cus_test_${suffix}`,
      stripeSubscriptionId: `sub_test_${suffix}`,
      plan: "pro",
      status: "active",
      aiEnabled: true,
      isActive: true,
      cancelAtPeriodEnd: false,
    },
    {
      upsert: true,
      returnDocument: "after",
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  );
};

const registerCreateBusinessLeadConversation = async ({
  userName = "demoowner",
  email = "owner@callbackiq.com",
  role = "owner",
  businessName = "Atlanta Pro Plumbing",
  businessPhone = "4045551234",
  businessType = "plumbing",
  subscriptionSuffix = "agent",
} = {}) => {
  const registerRes = await request(app).post("/api/auth/register").send({
    userName,
    email,
    password: "Password123",
    role,
    businessName,
    businessPhone: "4045551234",
    businessType: "plumbing",

    // Required registration acknowledgements
    smsConsent: true,
    termsAccepted: true,
    privacyAccepted: true,
  });

  const token = registerRes.body.data.token;
  const business = registerRes.body.data.business;

  await createActiveSubscription(business._id, subscriptionSuffix);

  const leadRes = await request(app)
    .post("/api/leads")
    .set("Authorization", `Bearer ${token}`)
    .send({
      customerName: "John Smith",
      phone: "4045559999",
      serviceNeeded: "Unknown - missed call follow-up needed",
      urgency: "medium",
      status: "new",
      source: "missed_call",
    });

  const lead = leadRes.body.data;

  const conversationRes = await request(app)
    .post("/api/conversations")
    .set("Authorization", `Bearer ${token}`)
    .send({
      business: business._id,
      lead: lead._id,
      customerPhone: "4045559999",
      customerName: "John Smith",
    });

  expect(conversationRes.status).toBe(201);

  return {
    token,
    business,
    lead,
    conversation: conversationRes.body.data,
  };
};

describe("Agent Routes", () => {
  test("POST /api/agent/reply rejects unauthenticated request", async () => {
    const res = await request(app).post("/api/agent/reply").send({
      conversationId: "665000000000000000000001",
      customerMessage: "My water heater is leaking.",
    });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/agent/reply rejects invalid input", async () => {
    const { token } = await registerCreateBusinessLeadConversation();

    const res = await request(app)
      .post("/api/agent/reply")
      .set("Authorization", `Bearer ${token}`)
      .send({
        conversationId: "",
        customerMessage: "",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/agent/reply rejects invalid conversation ID", async () => {
    const { token } = await registerCreateBusinessLeadConversation();

    const res = await request(app)
      .post("/api/agent/reply")
      .set("Authorization", `Bearer ${token}`)
      .send({
        conversationId: "bad-id",
        customerMessage: "My water heater is leaking.",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/agent/reply creates inbound/outbound messages, updates lead, and creates hot lead alert", async () => {
    runFollowUpAgent.mockResolvedValue({
      reply:
        "I’m sorry that happened. Is water actively leaking right now, and what is the service address?",
      serviceNeeded: "Water heater repair",
      urgency: "emergency",
      address: "",
      preferredAppointmentTime: "Today",
      leadQualityScore: 95,
      estimatedValue: 1200,
      summary: "Customer has emergency water heater issue.",
      shouldAlertOwner: true,
      alertTitle: "Emergency water heater lead",
      alertMessage: "Customer has an emergency water heater issue today.",
    });

    const { token, lead, conversation } =
      await registerCreateBusinessLeadConversation();

    const res = await request(app)
      .post("/api/agent/reply")
      .set("Authorization", `Bearer ${token}`)
      .send({
        conversationId: conversation._id,
        leadId: lead._id,
        customerMessage:
          "My water heater exploded and water is leaking everywhere.",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.reply).toContain("Is water actively leaking");

    const updatedLead = await Lead.findById(lead._id);

    expect(updatedLead.serviceNeeded).toBe("Water heater repair");
    expect(updatedLead.urgency).toBe("emergency");
    expect(updatedLead.leadQualityScore).toBe(95);
    expect(updatedLead.estimatedValue).toBe(1200);
    expect(updatedLead.status).toBe("contacted");

    const messages = await Message.find({
      conversation: conversation._id,
    }).sort({ createdAt: 1 });

    expect(messages.length).toBe(2);
    expect(messages[0].direction).toBe("inbound");
    expect(messages[1].direction).toBe("outbound");
    expect(messages[1].provider).toBe("twilio");
    expect(messages[1].providerMessageId).toBe("SM_AGENT_TEST_123");
    expect(messages[1].status).toBe("sent");

    const updatedConversation = await Conversation.findById(conversation._id);

    expect(updatedConversation.lastMessage).toContain(
      "Is water actively leaking",
    );

    const alert = await Alert.findOne({
      lead: lead._id,
      type: "hot_lead",
    });

    expect(alert).toBeTruthy();
    expect(alert.priority).toBe("high");
    expect(alert.title).toBe("Emergency water heater lead");
  });

  test("does not downgrade booked lead status", async () => {
    runFollowUpAgent.mockResolvedValue({
      reply: "Thanks, your appointment is confirmed.",
      serviceNeeded: "Water heater repair",
      urgency: "high",
      address: "",
      preferredAppointmentTime: "Tomorrow",
      leadQualityScore: 80,
      estimatedValue: 900,
      summary: "Customer confirmed appointment.",
      shouldAlertOwner: false,
    });

    const { token, lead, conversation } =
      await registerCreateBusinessLeadConversation();

    await Lead.findByIdAndUpdate(lead._id, {
      status: "booked",
    });

    const res = await request(app)
      .post("/api/agent/reply")
      .set("Authorization", `Bearer ${token}`)
      .send({
        conversationId: conversation._id,
        leadId: lead._id,
        customerMessage: "Tomorrow works.",
      });

    expect(res.status).toBe(200);

    const updatedLead = await Lead.findById(lead._id);

    expect(updatedLead.status).toBe("booked");
  });

  test("sanitizes invalid AI values", async () => {
    runFollowUpAgent.mockResolvedValue({
      reply: "Thanks, I’ll pass this along.",
      serviceNeeded: "Leak repair",
      urgency: "critical",
      address: "",
      preferredAppointmentTime: "",
      leadQualityScore: 999,
      estimatedValue: -500,
      summary: "Possible leak repair.",
      shouldAlertOwner: false,
    });

    const { token, lead, conversation } =
      await registerCreateBusinessLeadConversation();

    const res = await request(app)
      .post("/api/agent/reply")
      .set("Authorization", `Bearer ${token}`)
      .send({
        conversationId: conversation._id,
        leadId: lead._id,
        customerMessage: "There is a leak.",
      });

    expect(res.status).toBe(200);

    const updatedLead = await Lead.findById(lead._id);

    expect(updatedLead.urgency).toBe("medium");
    expect(updatedLead.leadQualityScore).toBe(100);
    expect(updatedLead.estimatedValue).toBe(0);
  });

  test("does not create alert when lead is not hot", async () => {
    runFollowUpAgent.mockResolvedValue({
      reply: "Thanks, what day works best for service?",
      serviceNeeded: "General plumbing",
      urgency: "low",
      address: "",
      preferredAppointmentTime: "",
      leadQualityScore: 40,
      estimatedValue: 300,
      summary: "Low urgency general plumbing lead.",
      shouldAlertOwner: false,
    });

    const { token, lead, conversation } =
      await registerCreateBusinessLeadConversation();

    const res = await request(app)
      .post("/api/agent/reply")
      .set("Authorization", `Bearer ${token}`)
      .send({
        conversationId: conversation._id,
        leadId: lead._id,
        customerMessage: "I may need service sometime next week.",
      });

    expect(res.status).toBe(200);

    const alerts = await Alert.find({ lead: lead._id });

    expect(alerts.length).toBe(0);
  });

  test("rejects another business conversation", async () => {
    const first = await registerCreateBusinessLeadConversation();

    const second = await registerCreateBusinessLeadConversation({
      userName: "otherowner",
      email: "other@callbackiq.com",
      businessName: "Other Plumbing",
      businessPhone: "4045557777",
      businessType: "plumbing",
      subscriptionSuffix: "agent_2",
    });

    const res = await request(app)
      .post("/api/agent/reply")
      .set("Authorization", `Bearer ${second.token}`)
      .send({
        conversationId: first.conversation._id,
        leadId: first.lead._id,
        customerMessage: "Trying to access another business conversation.",
      });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(runFollowUpAgent).not.toHaveBeenCalled();
  });
});
