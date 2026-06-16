import request from "supertest";

import app from "../../src/app.js";
import Lead from "../../src/models/lead.js";
import { qualifyLeadWithAI } from "../../src/helpers/ai/openaiClient.js";
import { connectTestDB, clearTestDB, closeTestDB } from "../setup/testDb.js";

jest.mock("../../src/helpers/ai/openaiClient.js", () => ({
  qualifyLeadWithAI: jest.fn(),
}));

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  jest.clearAllMocks();
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
      serviceNeeded: "Unknown - customer replied by SMS",
      status: "new",
      source: "sms",
    });

  return {
    token,
    business: businessRes.body.data,
    lead: leadRes.body.data,
  };
};

describe("AI Routes", () => {
  test("POST /api/ai/qualify-lead rejects unauthenticated request", async () => {
    const res = await request(app).post("/api/ai/qualify-lead").send({
      leadId: "665000000000000000000001",
      messageBody: "My water heater is leaking and I need help today.",
    });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/ai/qualify-lead rejects invalid input", async () => {
    const { token } = await registerCreateBusinessAndLead();

    const res = await request(app)
      .post("/api/ai/qualify-lead")
      .set("Authorization", `Bearer ${token}`)
      .send({
        leadId: "",
        messageBody: "",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/ai/qualify-lead rejects invalid lead ID format", async () => {
    const { token } = await registerCreateBusinessAndLead();

    const res = await request(app)
      .post("/api/ai/qualify-lead")
      .set("Authorization", `Bearer ${token}`)
      .send({
        leadId: "bad-id",
        messageBody: "My water heater is leaking.",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/ai/qualify-lead qualifies and updates lead", async () => {
    qualifyLeadWithAI.mockResolvedValue({
      serviceNeeded: "Water heater repair",
      urgency: "emergency",
      address: "123 Main St Atlanta GA",
      preferredAppointmentTime: "Today after 3 PM",
      leadQualityScore: 95,
      summary:
        "Customer has an emergency water heater issue and wants service today.",
      estimatedValue: 1200,
    });

    const { token, lead } = await registerCreateBusinessAndLead();

    const res = await request(app)
      .post("/api/ai/qualify-lead")
      .set("Authorization", `Bearer ${token}`)
      .send({
        leadId: lead._id,
        messageBody:
          "My water heater is leaking everywhere. I need someone today after 3 PM. I am at 123 Main St Atlanta GA.",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    expect(qualifyLeadWithAI).toHaveBeenCalledWith({
      messageBody:
        "My water heater is leaking everywhere. I need someone today after 3 PM. I am at 123 Main St Atlanta GA.",
      businessType: "plumbing",
    });

    expect(res.body.data.lead.serviceNeeded).toBe("Water heater repair");
    expect(res.body.data.lead.urgency).toBe("emergency");
    expect(res.body.data.lead.address).toBe("123 Main St Atlanta GA");
    expect(res.body.data.lead.preferredAppointmentTime).toBe(
      "Today after 3 PM",
    );
    expect(res.body.data.lead.leadQualityScore).toBe(95);
    expect(res.body.data.lead.estimatedValue).toBe(1200);
    expect(res.body.data.lead.status).toBe("contacted");

    const updatedLead = await Lead.findById(lead._id);

    expect(updatedLead.serviceNeeded).toBe("Water heater repair");
    expect(updatedLead.status).toBe("contacted");
  });

  test("does not downgrade booked lead to contacted", async () => {
    qualifyLeadWithAI.mockResolvedValue({
      serviceNeeded: "Water heater repair",
      urgency: "high",
      address: "",
      preferredAppointmentTime: "Tomorrow morning",
      leadQualityScore: 80,
      summary: "Customer confirmed appointment details.",
      estimatedValue: 900,
    });

    const { token, lead } = await registerCreateBusinessAndLead();

    await Lead.findByIdAndUpdate(lead._id, {
      status: "booked",
    });

    const res = await request(app)
      .post("/api/ai/qualify-lead")
      .set("Authorization", `Bearer ${token}`)
      .send({
        leadId: lead._id,
        messageBody: "Tomorrow morning works.",
      });

    expect(res.status).toBe(200);
    expect(res.body.data.lead.status).toBe("booked");
  });

  test("sanitizes invalid AI urgency, score, and estimated value", async () => {
    qualifyLeadWithAI.mockResolvedValue({
      serviceNeeded: "Leak repair",
      urgency: "critical",
      address: "",
      preferredAppointmentTime: "",
      leadQualityScore: 999,
      summary: "Customer may need leak repair.",
      estimatedValue: -500,
    });

    const { token, lead } = await registerCreateBusinessAndLead();

    const res = await request(app)
      .post("/api/ai/qualify-lead")
      .set("Authorization", `Bearer ${token}`)
      .send({
        leadId: lead._id,
        messageBody: "There is a leak.",
      });

    expect(res.status).toBe(200);
    expect(res.body.data.lead.urgency).toBe("medium");
    expect(res.body.data.lead.leadQualityScore).toBe(100);
    expect(res.body.data.lead.estimatedValue).toBe(0);
  });

  test("rejects lead that does not belong to user's business", async () => {
    const first = await registerCreateBusinessAndLead();

    const secondRegisterRes = await request(app)
      .post("/api/auth/register")
      .send({
        userName: "otherowner",
        email: "other@callbackiq.com",
        password: "Password123",
        businessName: "Other Plumbing",
      });

    const secondToken = secondRegisterRes.body.data.token;

    await request(app)
      .post("/api/businesses")
      .set("Authorization", `Bearer ${secondToken}`)
      .send({
        businessName: "Other Plumbing",
        businessType: "plumbing",
        phone: "4045557777",
      });

    const res = await request(app)
      .post("/api/ai/qualify-lead")
      .set("Authorization", `Bearer ${secondToken}`)
      .send({
        leadId: first.lead._id,
        messageBody: "Trying to access another business lead.",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(qualifyLeadWithAI).not.toHaveBeenCalled();
  });
});
