import request from "supertest";

import app from "../../src/app.js";
import Alert from "../../src/models/alert.js";
import Business from "../../src/models/business.js";
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

const createActiveSubscription = async (businessId, suffix = "123") => {
  await Business.findByIdAndUpdate(businessId, {
    isActive: true,
  });

  return await Subscription.create({
    business: businessId,
    stripeCustomerId: `cus_test_${suffix}`,
    stripeSubscriptionId: `sub_test_${suffix}`,
    plan: "pro",
    status: "active",
    aiEnabled: true,
    isActive: true,
  });
};

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

  await createActiveSubscription(business._id);

  const leadRes = await request(app)
    .post("/api/leads")
    .set("Authorization", `Bearer ${token}`)
    .send({
      customerName: "John Smith",
      phone: "4045559999",
      serviceNeeded: "Water heater repair",
      urgency: "emergency",
      status: "new",
      source: "missed_call",
      estimatedValue: 1200,
    });

  return {
    token,
    business,
    lead: leadRes.body.data,
  };
};

describe("Alert Routes", () => {
  test("POST /api/alerts rejects unauthenticated request", async () => {
    const res = await request(app).post("/api/alerts").send({
      type: "hot_lead",
      title: "New hot lead",
      message: "Customer needs emergency water heater repair.",
    });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/alerts creates alert for authenticated business", async () => {
    const { token, business, lead } = await registerCreateBusinessAndLead();

    const res = await request(app)
      .post("/api/alerts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        lead: lead._id,
        type: "hot_lead",
        channel: "in_app",
        title: "New hot lead",
        message: "Emergency water heater issue. Customer wants service today.",
        priority: "high",
        metadata: {
          source: "ai_qualification",
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.type).toBe("hot_lead");
    expect(res.body.data.status).toBe("pending");
    expect(res.body.data.priority).toBe("high");
    expect(String(res.body.data.business)).toBe(String(business._id));

    const savedAlert = await Alert.findOne({
      title: "New hot lead",
    });

    expect(savedAlert).toBeTruthy();
    expect(String(savedAlert.lead)).toBe(String(lead._id));
  });

  test("POST /api/alerts rejects invalid alert data", async () => {
    const { token } = await registerCreateBusinessAndLead();

    const res = await request(app)
      .post("/api/alerts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        type: "bad_type",
        title: "",
        message: "",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/alerts rejects invalid lead ID", async () => {
    const { token } = await registerCreateBusinessAndLead();

    const res = await request(app)
      .post("/api/alerts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        lead: "bad-id",
        type: "hot_lead",
        title: "New hot lead",
        message: "Customer needs help today.",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("GET /api/alerts returns alerts for authenticated business", async () => {
    const { token } = await registerCreateBusinessAndLead();

    await request(app)
      .post("/api/alerts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        type: "missed_call",
        title: "Missed call",
        message: "You missed a call from 4045559999.",
      });

    const res = await request(app)
      .get("/api/alerts")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].type).toBe("missed_call");
  });

  test("GET /api/alerts?unreadOnly=true returns unread alerts only", async () => {
    const { token, business } = await registerCreateBusinessAndLead();

    await Alert.create({
      business: business._id,
      type: "missed_call",
      title: "Unread alert",
      message: "This is unread.",
      status: "pending",
    });

    await Alert.create({
      business: business._id,
      type: "system",
      title: "Read alert",
      message: "This is read.",
      status: "read",
      readAt: new Date(),
    });

    const res = await request(app)
      .get("/api/alerts?unreadOnly=true")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].title).toBe("Unread alert");
  });

  test("GET /api/alerts/:id returns alert by id", async () => {
    const { token } = await registerCreateBusinessAndLead();

    const createRes = await request(app)
      .post("/api/alerts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        type: "system",
        title: "System alert",
        message: "Your account is ready.",
      });

    const alertId = createRes.body.data._id;

    const res = await request(app)
      .get(`/api/alerts/${alertId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data._id).toBe(alertId);
  });

  test("PATCH /api/alerts/:id updates alert", async () => {
    const { token } = await registerCreateBusinessAndLead();

    const createRes = await request(app)
      .post("/api/alerts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        type: "system",
        title: "System alert",
        message: "Your account is ready.",
      });

    const alertId = createRes.body.data._id;

    const res = await request(app)
      .patch(`/api/alerts/${alertId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Updated system alert",
        priority: "high",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.title).toBe("Updated system alert");
    expect(res.body.data.priority).toBe("high");
  });

  test("PATCH /api/alerts/:id/read marks one alert as read", async () => {
    const { token } = await registerCreateBusinessAndLead();

    const createRes = await request(app)
      .post("/api/alerts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        type: "hot_lead",
        title: "Hot lead",
        message: "Customer needs service today.",
      });

    const alertId = createRes.body.data._id;

    const res = await request(app)
      .patch(`/api/alerts/${alertId}/read`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("read");
    expect(res.body.data.readAt).toBeTruthy();
  });

  test("PATCH /api/alerts/read-all marks all alerts as read", async () => {
    const { token, business } = await registerCreateBusinessAndLead();

    await Alert.create({
      business: business._id,
      type: "missed_call",
      title: "Alert 1",
      message: "Message 1",
      status: "pending",
    });

    await Alert.create({
      business: business._id,
      type: "hot_lead",
      title: "Alert 2",
      message: "Message 2",
      status: "pending",
    });

    const res = await request(app)
      .patch("/api/alerts/read-all")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const unreadAlerts = await Alert.find({
      business: business._id,
      status: { $ne: "read" },
    });

    expect(unreadAlerts.length).toBe(0);
  });

  test("DELETE /api/alerts/:id deletes alert", async () => {
    const { token } = await registerCreateBusinessAndLead();

    const createRes = await request(app)
      .post("/api/alerts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        type: "system",
        title: "Delete me",
        message: "This alert will be deleted.",
      });

    const alertId = createRes.body.data._id;

    const res = await request(app)
      .delete(`/api/alerts/${alertId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const deletedAlert = await Alert.findById(alertId);

    expect(deletedAlert).toBeFalsy();
  });

  test("cannot create alert for another business lead", async () => {
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

    const secondBusinessRes = await request(app)
      .post("/api/businesses")
      .set("Authorization", `Bearer ${secondToken}`)
      .send({
        businessName: "Other Plumbing",
        businessType: "plumbing",
        phone: "4045557777",
      });

    await createActiveSubscription(secondBusinessRes.body.data._id, "456");

    const res = await request(app)
      .post("/api/alerts")
      .set("Authorization", `Bearer ${secondToken}`)
      .send({
        lead: first.lead._id,
        type: "hot_lead",
        title: "Unauthorized alert",
        message: "Trying to alert on another business lead.",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
