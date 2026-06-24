import request from "supertest";

import app from "../../src/app.js";
import Business from "../../src/models/business.js";
import Lead from "../../src/models/lead.js";
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

const registerCreateBusinessAndLead = async () => {
  const registerRes = await request(app).post("/api/auth/register").send({
    userName: "demoowner",
    email: "owner@callbackiq.com",
    password: "Password123",
    businessName: "Atlanta Pro Plumbing",
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

  const lead = await Lead.create({
    business: business._id,
    customerName: "John Smith",
    phone: "4045559999",
    serviceNeeded: "Water heater replacement",
    urgency: "medium",
    status: "new",
    source: "manual",
    estimatedValue: 800,
  });

  return {
    token,
    business,
    lead,
  };
};

describe("Subscription Enforcement Middleware", () => {
  test("blocks paid lead status route without subscription", async () => {
    const { token, lead } = await registerCreateBusinessAndLead();

    const res = await request(app)
      .patch(`/api/leads/${lead._id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        status: "contacted",
      });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Active subscription or free trial required");
  });

  test("blocks paid lead status route with inactive subscription", async () => {
    const { token, business, lead } = await registerCreateBusinessAndLead();

    await Subscription.create({
      business: business._id,
      stripeCustomerId: "cus_test_inactive",
      stripeSubscriptionId: "sub_test_inactive",
      plan: "pro",
      status: "past_due",
      aiEnabled: true,
      isActive: false,
    });

    const res = await request(app)
      .patch(`/api/leads/${lead._id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        status: "contacted",
      });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Your subscription is not active");
    expect(res.body.data.status).toBe("past_due");
  });

  test("allows paid route with active subscription", async () => {
    const { token, business, lead } = await registerCreateBusinessAndLead();

    await Business.findByIdAndUpdate(business._id, {
      isActive: true,
    });

    await Subscription.create({
      business: business._id,
      stripeCustomerId: "cus_test_active",
      stripeSubscriptionId: "sub_test_active",
      plan: "pro",
      status: "active",
      aiEnabled: true,
      isActive: true,
    });

    const res = await request(app)
      .patch(`/api/leads/${lead._id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        status: "contacted",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("contacted");

    const updatedLead = await Lead.findById(lead._id);

    expect(updatedLead.status).toBe("contacted");
  });

  test("blocks paid route when business is inactive", async () => {
    const { token, business, lead } = await registerCreateBusinessAndLead();

    await Business.findByIdAndUpdate(business._id, {
      isActive: false,
    });

    await Subscription.create({
      business: business._id,
      stripeCustomerId: "cus_test_active_inactive_business",
      stripeSubscriptionId: "sub_test_active_inactive_business",
      plan: "pro",
      status: "active",
      aiEnabled: true,
      isActive: true,
    });

    const res = await request(app)
      .patch(`/api/leads/${lead._id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        status: "contacted",
      });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe(
      "This account is inactive. Please contact support to restore access.",
    );
  });
});
