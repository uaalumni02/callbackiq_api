import request from "supertest";

import app from "../../src/app.js";

import Lead from "../../src/models/lead.js";
import CallLog from "../../src/models/callLog.js";
import Conversation from "../../src/models/conversation.js";
import Message from "../../src/models/message.js";
import Subscription from "../../src/models/subscription.js";

import { connectTestDB, clearTestDB, closeTestDB } from "../setup/testDb.js";

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  await clearTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

const createActiveSubscription = async (businessId) => {
  return await Subscription.create({
    business: businessId,
    stripeCustomerId: "cus_test_dashboard",
    stripeSubscriptionId: "sub_test_dashboard",
    plan: "pro",
    status: "active",
    aiEnabled: true,
  });
};

const registerAndCreateBusiness = async () => {
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

  const businessRes = await request(app)
    .post("/api/businesses")
    .set("Authorization", `Bearer ${token}`)
    .send({
      businessName: "Atlanta Pro Plumbing",
      businessType: "plumbing",
      phone: "4045551234",
      estimatedJobValue: 800,
    });

  const business = businessRes.body.data;

  await createActiveSubscription(business._id);

  return {
    token,
    business,
  };
};

describe("Dashboard Routes", () => {
  test("GET /api/dashboard rejects unauthenticated request", async () => {
    const res = await request(app).get("/api/dashboard");

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("GET /api/dashboard returns empty metrics for new business", async () => {
    const { token } = await registerAndCreateBusiness();

    const res = await request(app)
      .get("/api/dashboard")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    expect(res.body.data.calls.totalCalls).toBe(0);
    expect(res.body.data.calls.missedCalls).toBe(0);

    expect(res.body.data.leads.totalLeads).toBe(0);

    expect(res.body.data.messages.smsSent).toBe(0);
    expect(res.body.data.messages.smsReceived).toBe(0);

    expect(res.body.data.revenue.bookedRevenue).toBe(0);
    expect(res.body.data.revenue.recoveredRevenue).toBe(0);
  });

  test("GET /api/dashboard returns calculated metrics", async () => {
    const { token, business } = await registerAndCreateBusiness();

    const lead1 = await Lead.create({
      business: business._id,
      customerName: "John Smith",
      phone: "4045551111",
      serviceNeeded: "Water heater repair",
      urgency: "high",
      estimatedValue: 1200,
      status: "booked",
      source: "missed_call",
    });

    const lead2 = await Lead.create({
      business: business._id,
      customerName: "Sarah Jones",
      phone: "4045552222",
      serviceNeeded: "Drain cleaning",
      urgency: "medium",
      estimatedValue: 600,
      status: "contacted",
      source: "sms",
    });

    await Lead.create({
      business: business._id,
      customerName: "Bob Wilson",
      phone: "4045553333",
      serviceNeeded: "Leak repair",
      urgency: "low",
      estimatedValue: 400,
      status: "new",
      source: "manual",
    });

    await CallLog.create({
      business: business._id,
      lead: lead1._id,
      from: "4045551111",
      to: "4045551234",
      direction: "inbound",
      status: "missed",
      recovered: true,
      provider: "twilio",
    });

    await CallLog.create({
      business: business._id,
      lead: lead2._id,
      from: "4045552222",
      to: "4045551234",
      direction: "inbound",
      status: "answered",
      provider: "twilio",
    });

    await CallLog.create({
      business: business._id,
      from: "4045553333",
      to: "4045551234",
      direction: "inbound",
      status: "busy",
      provider: "twilio",
    });

    const conversation1 = await Conversation.create({
      business: business._id,
      lead: lead1._id,
      customerPhone: "4045551111",
      customerName: "John Smith",
      status: "open",
    });

    await Conversation.create({
      business: business._id,
      lead: lead2._id,
      customerPhone: "4045552222",
      customerName: "Sarah Jones",
      status: "closed",
    });

    await Message.create({
      business: business._id,
      conversation: conversation1._id,
      lead: lead1._id,
      direction: "outbound",
      from: "4045551234",
      to: "4045551111",
      body: "Hi John",
      provider: "twilio",
      status: "sent",
    });

    await Message.create({
      business: business._id,
      conversation: conversation1._id,
      lead: lead1._id,
      direction: "inbound",
      from: "4045551111",
      to: "4045551234",
      body: "I need help",
      provider: "twilio",
      status: "received",
    });

    const res = await request(app)
      .get("/api/dashboard")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    expect(res.body.data.calls.totalCalls).toBe(3);
    expect(res.body.data.calls.missedCalls).toBe(2);
    expect(res.body.data.calls.answeredCalls).toBe(1);
    expect(res.body.data.calls.recoveredCalls).toBe(1);

    expect(res.body.data.leads.totalLeads).toBe(3);
    expect(res.body.data.leads.newLeads).toBe(1);
    expect(res.body.data.leads.contactedLeads).toBe(1);
    expect(res.body.data.leads.bookedLeads).toBe(1);

    expect(res.body.data.conversations.activeConversations).toBe(1);
    expect(res.body.data.conversations.closedConversations).toBe(1);

    expect(res.body.data.messages.smsSent).toBe(1);
    expect(res.body.data.messages.smsReceived).toBe(1);

    expect(res.body.data.revenue.bookedRevenue).toBe(1200);
    expect(res.body.data.revenue.recoveredRevenue).toBe(1800);
  });

  test("GET /api/dashboard fails if business does not exist", async () => {
    const registerRes = await request(app).post("/api/auth/register").send({
      userName: "nobusiness",
      email: "nobusiness@callbackiq.com",
      password: "Password123",
      businessName: "No Business Yet",
    });

    const token = registerRes.body.data.token;

    const res = await request(app)
      .get("/api/dashboard")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("dashboard recovery rate is calculated correctly", async () => {
    const { token, business } = await registerAndCreateBusiness();

    await CallLog.create({
      business: business._id,
      from: "4041111111",
      to: "4045551234",
      status: "missed",
      recovered: true,
      provider: "twilio",
    });

    await CallLog.create({
      business: business._id,
      from: "4042222222",
      to: "4045551234",
      status: "missed",
      recovered: false,
      provider: "twilio",
    });

    const res = await request(app)
      .get("/api/dashboard")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);

    expect(res.body.data.calls.missedCalls).toBe(2);
    expect(res.body.data.calls.recoveredCalls).toBe(1);
    expect(res.body.data.calls.missedCallRecoveryRate).toBe(50);
  });

  test("dashboard booking rate is calculated correctly", async () => {
    const { token, business } = await registerAndCreateBusiness();

    await Lead.create({
      business: business._id,
      phone: "4041111111",
      serviceNeeded: "Water heater repair",
      status: "booked",
      estimatedValue: 1000,
    });

    await Lead.create({
      business: business._id,
      phone: "4042222222",
      serviceNeeded: "Drain cleaning",
      status: "contacted",
      estimatedValue: 500,
    });

    await Lead.create({
      business: business._id,
      phone: "4043333333",
      serviceNeeded: "Leak repair",
      status: "new",
      estimatedValue: 300,
    });

    await Lead.create({
      business: business._id,
      phone: "4044444444",
      serviceNeeded: "Leak repair",
      status: "new",
      estimatedValue: 300,
    });

    const res = await request(app)
      .get("/api/dashboard")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);

    expect(res.body.data.leads.totalLeads).toBe(4);
    expect(res.body.data.leads.bookedLeads).toBe(1);
    expect(res.body.data.leads.bookingRate).toBe(25);
  });
});
