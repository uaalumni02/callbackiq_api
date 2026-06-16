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

  return {
    token,
    business: businessRes.body.data,
  };
};

describe("Subscription Enforcement Middleware", () => {
  test("blocks paid AI route without subscription", async () => {
    const { token } = await registerCreateBusinessAndLead();

    const res = await request(app)
      .post("/api/ai/qualify-lead")
      .set("Authorization", `Bearer ${token}`)
      .send({
        leadId: "665000000000000000000001",
        messageBody: "My water heater is leaking.",
      });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Active subscription required");
  });

  test("blocks paid AI route with inactive subscription", async () => {
    const { token, business } = await registerCreateBusinessAndLead();

    await Subscription.create({
      business: business._id,
      plan: "pro",
      status: "past_due",
      stripeCustomerId: "cus_test_123",
      stripeSubscriptionId: "sub_test_123",
    });

    const res = await request(app)
      .post("/api/ai/qualify-lead")
      .set("Authorization", `Bearer ${token}`)
      .send({
        leadId: "665000000000000000000001",
        messageBody: "My water heater is leaking.",
      });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Your subscription is not active");
    expect(res.body.data.status).toBe("past_due");
  });

  test("allows paid route with active subscription", async () => {
    const { token, business } = await registerCreateBusinessAndLead();

    await Subscription.create({
      business: business._id,
      plan: "pro",
      status: "active",
      stripeCustomerId: "cus_test_123",
      stripeSubscriptionId: "sub_test_123",
    });

    const res = await request(app)
      .post("/api/ai/qualify-lead")
      .set("Authorization", `Bearer ${token}`)
      .send({
        leadId: "bad-id",
        messageBody: "My water heater is leaking.",
      });

    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Invalid lead ID");
  });
});
