import request from "supertest";

import app from "../../src/app.js";
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

  const leadRes = await request(app)
    .post("/api/leads")
    .set("Authorization", `Bearer ${token}`)
    .send({
      customerName: "John Smith",
      phone: "4045559999",
      serviceNeeded: "Water heater repair",
      urgency: "medium",
      status: "new",
      source: "manual",
    });

  return {
    token,
    business: businessRes.body.data,
    lead: leadRes.body.data,
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
    expect(res.body.message).toBe("Active subscription required");
  });

  test("blocks paid lead status route with inactive subscription", async () => {
    const { token, business, lead } = await registerCreateBusinessAndLead();

    await Subscription.create({
      business: business._id,
      plan: "pro",
      status: "past_due",
      stripeCustomerId: "cus_test_123",
      stripeSubscriptionId: "sub_test_123",
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

    await Subscription.create({
      business: business._id,
      plan: "pro",
      status: "active",
      stripeCustomerId: "cus_test_123",
      stripeSubscriptionId: "sub_test_123",
    });

    const res = await request(app)
      .patch(`/api/leads/${lead._id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        status: "contacted",
      });

    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("contacted");
  });
});
