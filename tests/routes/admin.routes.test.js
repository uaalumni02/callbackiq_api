import request from "supertest";

import app from "../../src/app.js";
import User from "../../src/models/user.js";
import Business from "../../src/models/business.js";
import Lead from "../../src/models/lead.js";
import CallLog from "../../src/models/callLog.js";
import Conversation from "../../src/models/conversation.js";
import Message from "../../src/models/message.js";
import Subscription from "../../src/models/subscription.js";
import AdminActionLog from "../../src/models/adminActionLog.js";
import Token from "../../src/helpers/jwt/token.js";
import bcrypt from "../../src/helpers/bcrypt/bcrypt.js";
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

const registerUserAndCreateBusiness = async ({
  userName = "demoowner",
  email = "owner@callbackiq.com",
  role = "owner",
  businessName = "Atlanta Pro Plumbing",
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

  return {
    token: registerRes.body.data.token,
    user: registerRes.body.data.user,
    business: registerRes.body.data.business,
  };
};

const registerAdmin = async () => {
  const hashedPassword = await bcrypt.hashPassword("Password123", 10);

  const user = await User.create({
    userName: "adminuser",
    email: "admin@callbackiq.com",
    password: hashedPassword,
    role: "admin",
    businessName: "CallBackIQ Admin",
    businessPhone: "4045559999",
    businessType: "other",
  });

  const token = Token.sign({
    userId: user._id,
    userName: user.userName,
    email: user.email,
    role: user.role,
  });

  return {
    token,
    user,
  };
};

const seedCustomerData = async (businessId) => {
  const lead = await Lead.create({
    business: businessId,
    customerName: "John Smith",
    phone: "7705551111",
    email: "john.smith@gmail.com",
    serviceNeeded: "Water heater replacement",
    urgency: "high",
    leadQualityScore: 82,
    estimatedValue: 2500,
    status: "booked",
    source: "missed_call",
    summary: "Customer needs urgent plumbing help.",
  });

  const conversation = await Conversation.create({
    business: businessId,
    lead: lead._id,
    customerPhone: "7705551111",
    customerName: "John Smith",
    status: "open",
    aiEnabled: true,
  });

  await Message.create({
    business: businessId,
    conversation: conversation._id,
    lead: lead._id,
    direction: "inbound",
    from: "7705551111",
    to: "4045551234",
    body: "I need help with my water heater.",
    provider: "twilio",
    status: "received",
  });

  await CallLog.create({
    business: businessId,
    lead: lead._id,
    conversation: conversation._id,
    from: "7705551111",
    to: "4045551234",
    direction: "inbound",
    status: "missed",
    durationSeconds: 0,
    provider: "twilio",
    providerCallId: "CA_test_123",
    missedCallTextSent: true,
    recovered: true,
  });

  await Subscription.findOneAndUpdate(
    { business: businessId },
    {
      business: businessId,
      stripeCustomerId: "cus_test_123",
      stripeSubscriptionId: "sub_test_123",
      plan: "pro",
      status: "active",
      aiEnabled: true,
      isActive: true,
    },
    {
      upsert: true,
      returnDocument: "after",
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  );
};

describe("Admin Routes", () => {
  test("GET /api/admin/dashboard rejects unauthenticated request", async () => {
    const res = await request(app).get("/api/admin/dashboard");

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("GET /api/admin/dashboard rejects owner user", async () => {
    const { token } = await registerUserAndCreateBusiness();

    const res = await request(app)
      .get("/api/admin/dashboard")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("auth failed");
  });

  test("GET /api/admin/dashboard returns platform metrics for admin", async () => {
    const { business } = await registerUserAndCreateBusiness();
    await seedCustomerData(business._id);

    const { token: adminToken } = await registerAdmin();

    const res = await request(app)
      .get("/api/admin/dashboard")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    expect(res.body.data.summary.totalUsers).toBe(2);
    expect(res.body.data.summary.totalBusinesses).toBe(1);
    expect(res.body.data.summary.totalSubscriptions).toBe(1);
    expect(res.body.data.summary.activeSubscriptions).toBe(1);
    expect(res.body.data.summary.totalLeads).toBe(1);
    expect(res.body.data.summary.totalCalls).toBe(1);
    expect(res.body.data.summary.missedCalls).toBe(1);
    expect(res.body.data.summary.totalConversations).toBe(1);
    expect(res.body.data.summary.totalMessages).toBe(1);

    expect(res.body.data.customers).toHaveLength(1);
    expect(res.body.data.customers[0].business.businessName).toBe(
      "Atlanta Pro Plumbing",
    );
    expect(res.body.data.customers[0].subscription.plan).toBe("pro");
    expect(res.body.data.customers[0].subscription.status).toBe("active");

    const log = await AdminActionLog.findOne({
      action: "view_dashboard",
    });

    expect(log).toBeTruthy();
  });

  test("GET /api/admin/customers/:businessId returns full customer details", async () => {
    const { business } = await registerUserAndCreateBusiness();
    await seedCustomerData(business._id);

    const { token: adminToken } = await registerAdmin();

    const res = await request(app)
      .get(`/api/admin/customers/${business._id}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    expect(res.body.data.business.businessName).toBe("Atlanta Pro Plumbing");
    expect(res.body.data.owner.email).toBe("owner@callbackiq.com");
    expect(res.body.data.subscription.plan).toBe("pro");
    expect(res.body.data.subscription.status).toBe("active");

    expect(res.body.data.metrics.leads).toBe(1);
    expect(res.body.data.metrics.calls).toBe(1);
    expect(res.body.data.metrics.missedCalls).toBe(1);
    expect(res.body.data.metrics.recoveredCalls).toBe(1);
    expect(res.body.data.metrics.conversations).toBe(1);
    expect(res.body.data.metrics.messages).toBe(1);
    expect(res.body.data.metrics.bookedLeads).toBe(1);

    expect(res.body.data.leads).toHaveLength(1);
    expect(res.body.data.calls).toHaveLength(1);
    expect(res.body.data.conversations).toHaveLength(1);
    expect(res.body.data.messages).toHaveLength(1);
  });

  test("GET /api/admin/customers/:businessId rejects invalid business id", async () => {
    const { token: adminToken } = await registerAdmin();

    const res = await request(app)
      .get("/api/admin/customers/not-a-valid-id")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("PATCH /api/admin/customers/:businessId/subscription-status updates subscription status", async () => {
    const { business } = await registerUserAndCreateBusiness();
    await seedCustomerData(business._id);

    const { token: adminToken } = await registerAdmin();

    const res = await request(app)
      .patch(`/api/admin/customers/${business._id}/subscription-status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        status: "past_due",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("past_due");

    const subscription = await Subscription.findOne({
      business: business._id,
    });

    expect(subscription.status).toBe("past_due");
  });

  test("PATCH /api/admin/customers/:businessId/subscription-status rejects invalid status", async () => {
    const { business } = await registerUserAndCreateBusiness();
    const { token: adminToken } = await registerAdmin();

    const res = await request(app)
      .patch(`/api/admin/customers/${business._id}/subscription-status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        status: "free",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("PATCH /api/admin/customers/:businessId/business-status disables business", async () => {
    const { business } = await registerUserAndCreateBusiness();
    const { token: adminToken } = await registerAdmin();

    const res = await request(app)
      .patch(`/api/admin/customers/${business._id}/business-status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        isActive: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.isActive).toBe(false);

    const updatedBusiness = await Business.findById(business._id);

    expect(updatedBusiness.isActive).toBe(false);
  });

  test("PATCH /api/admin/customers/:businessId/business-status rejects owner user", async () => {
    const { token, business } = await registerUserAndCreateBusiness();

    const res = await request(app)
      .patch(`/api/admin/customers/${business._id}/business-status`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        isActive: false,
      });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("auth failed");
  });
});
