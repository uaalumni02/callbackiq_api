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
  await Business.findByIdAndUpdate(
    businessId,
    {
      isActive: true,
    },
    {
      returnDocument: "after",
    },
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

/*
 * createLead defaults to true. Alert list tests pass createLead: false because
 * creating an emergency lead triggers an automatic hot_lead alert, which would
 * otherwise pollute the alert counts those tests assert on.
 */
const registerCreateBusinessAndLead = async ({
  userName = "demoowner",
  email = "owner@callbackiq.com",
  role = "owner",
  businessName = "Atlanta Pro Plumbing",
  businessPhone = "4045551234",
  businessType = "plumbing",
  subscriptionSuffix = "123",
  createLead = true,
} = {}) => {
  const registerRes = await request(app).post("/api/auth/register").send({
    userName,
    email,
    password: "Password123",
    role,
    businessName,
    businessPhone,
    businessType,
    smsConsent: true,
    termsAccepted: true,
    privacyAccepted: true,
  });

  const token = registerRes.body.data.token;
  const business = registerRes.body.data.business;

  await createActiveSubscription(business._id, subscriptionSuffix);

  if (!createLead) {
    return {
      token,
      business,
      lead: null,
    };
  }

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
    // AlertService populates business before returning, so compare the _id.
    expect(String(res.body.data.business._id)).toBe(String(business._id));

    const savedAlert = await Alert.findOne({
      title: "New hot lead",
    });

    expect(savedAlert).toBeTruthy();
    expect(String(savedAlert.lead)).toBe(String(lead._id));
  });


  test("POST /api/alerts accepts critical priority", async () => {
    const { token } = await registerCreateBusinessAndLead({
      createLead: false,
    });

    const response = await request(app)
      .post("/api/alerts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        type: "system",
        channel: "in_app",
        title: "Emergency safety concern",
        message: "Customer reported a possible gas leak.",
        priority: "critical",
      });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.priority).toBe("critical");
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
    const { token } = await registerCreateBusinessAndLead({
      createLead: false,
    });

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
    const { token, business } = await registerCreateBusinessAndLead({
      createLead: false,
    });

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

    const second = await registerCreateBusinessAndLead({
      userName: "otherowner",
      email: "other@callbackiq.com",
      businessName: "Other Plumbing",
      businessPhone: "4045557777",
      businessType: "plumbing",
      subscriptionSuffix: "456",
    });

    const res = await request(app)
      .post("/api/alerts")
      .set("Authorization", `Bearer ${second.token}`)
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
