import jwt from "jsonwebtoken";
import request from "supertest";

import app from "../../src/app.js";
import DemoRequest from "../../src/models/demoRequest.js";
import User from "../../src/models/user.js";
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

const createTokenForUser = (user) =>
  jwt.sign(
    {
      userId: user._id,
      id: user._id,
      email: user.email,
      role: user.role,
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" },
  );

const createUser = async (role) => {
  const user = await User.create({
    userName: role === "admin" ? "contactadmin" : "contactowner",
    email:
      role === "admin"
        ? "contact-admin@callbackiq.com"
        : "contact-owner@callbackiq.com",
    password: "Password123",
    role,
    businessName: role === "admin" ? "CallBackIQ Admin" : "ABC Plumbing",
    businessPhone: "4045551212",
    businessType: "other",
    smsConsent: true,
    termsAccepted: true,
    privacyAccepted: true,
  });

  return { user, token: createTokenForUser(user) };
};

const createDemo = (overrides = {}) =>
  DemoRequest.create({
    fullName: "John Smith",
    email: "john@example.com",
    phone: "(404) 555-1111",
    businessName: "Atlanta Pro Plumbing",
    businessType: "plumbing",
    status: "scheduled",
    scheduledAt: new Date("2026-08-12T18:00:00.000Z"),
    ...overrides,
  });

describe("Demo outreach actions", () => {
  test("normalizes a US demo phone into an additive E.164 field", async () => {
    const demo = await createDemo();
    expect(demo.phone).toBe("(404) 555-1111");
    expect(demo.phoneE164).toBe("+14045551111");
  });

  test("POST contact-attempts rejects unauthenticated requests", async () => {
    const demo = await createDemo();
    const res = await request(app)
      .post(`/api/demo-requests/${demo._id}/outreach-attempts`)
      .send({ channel: "phone" });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("POST contact-attempts rejects non-admin users", async () => {
    const demo = await createDemo();
    const { token } = await createUser("owner");
    const res = await request(app)
      .post(`/api/demo-requests/${demo._id}/outreach-attempts`)
      .set("Authorization", `Bearer ${token}`)
      .send({ channel: "email" });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("records a call initiation without changing scheduled pipeline state", async () => {
    const demo = await createDemo();
    const { user, token } = await createUser("admin");

    const res = await request(app)
      .post(`/api/demo-requests/${demo._id}/outreach-attempts`)
      .set("Authorization", `Bearer ${token}`)
      .send({ channel: "phone" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("scheduled");
    expect(res.body.data.contactedAt).toBeNull();
    expect(res.body.data.lastOutreachChannel).toBe("phone");
    expect(res.body.data.lastOutreachAt).toBeTruthy();
    expect(res.body.data.outreachActivities).toHaveLength(1);
    expect(res.body.data.outreachActivities[0]).toMatchObject({
      type: "call_initiated",
      channel: "phone",
      actorEmail: user.email,
    });

    const saved = await DemoRequest.findById(demo._id);
    expect(saved.status).toBe("scheduled");
    expect(saved.contactedAt).toBeNull();
    expect(saved.outreachActivities[0].actor.toString()).toBe(user._id.toString());
  });

  test("records an email initiation without claiming the email was sent", async () => {
    const demo = await createDemo({ status: "new", scheduledAt: null });
    const { token } = await createUser("admin");

    const res = await request(app)
      .post(`/api/demo-requests/${demo._id}/outreach-attempts`)
      .set("Authorization", `Bearer ${token}`)
      .send({ channel: "email" });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("new");
    expect(res.body.data.contactedAt).toBeNull();
    expect(res.body.data.lastOutreachChannel).toBe("email");
    expect(res.body.data.outreachActivities[0].type).toBe("email_initiated");
  });

  test("rejects unsupported contact channels", async () => {
    const demo = await createDemo();
    const { token } = await createUser("admin");

    const res = await request(app)
      .post(`/api/demo-requests/${demo._id}/outreach-attempts`)
      .set("Authorization", `Bearer ${token}`)
      .send({ channel: "sms" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
