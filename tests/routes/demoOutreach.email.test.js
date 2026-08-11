import jwt from "jsonwebtoken";
import request from "supertest";

import app from "../../src/app.js";
import DemoRequest from "../../src/models/demoRequest.js";
import User from "../../src/models/user.js";
import DemoNotificationService from "../../src/services/demoNotification.service.js";
import { connectTestDB, clearTestDB, closeTestDB } from "../setup/testDb.js";

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await clearTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

const createAdmin = async () => {
  const user = await User.create({
    userName: "demoemailadmin",
    email: "demo-email-admin@callbackiq.com",
    password: "Password123",
    role: "admin",
    businessName: "CallBackIQ Admin",
    businessPhone: "4045551212",
    businessType: "other",
    smsConsent: true,
    termsAccepted: true,
    privacyAccepted: true,
  });

  const token = jwt.sign(
    {
      userId: user._id,
      id: user._id,
      email: user.email,
      role: user.role,
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" },
  );

  return { user, token };
};

const createDemo = () =>
  DemoRequest.create({
    fullName: "John Smith",
    email: "john@example.com",
    phone: "(404) 555-1111",
    businessName: "Atlanta Pro Plumbing",
    businessType: "plumbing",
    status: "scheduled",
    scheduledAt: new Date("2026-08-12T18:00:00.000Z"),
  });

describe("Demo outreach email sending", () => {
  test("sends through the existing email service and records email_sent", async () => {
    const demo = await createDemo();
    const { user, token } = await createAdmin();
    const sendSpy = jest
      .spyOn(DemoNotificationService, "send")
      .mockResolvedValue(true);

    const res = await request(app)
      .post(`/api/demo-requests/${demo._id}/emails`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        subject: "Your CallBackIQ demo",
        body: "Hi John,\n\nLooking forward to speaking with you.",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "john@example.com",
        subject: "Your CallBackIQ demo",
      }),
    );
    expect(sendSpy.mock.calls[0][0].html).toContain("Hi John,<br /><br />");
    expect(res.body.data.status).toBe("scheduled");
    expect(res.body.data.contactedAt).toBeNull();
    expect(res.body.data.lastOutreachChannel).toBe("email");
    expect(res.body.data.outreachActivities).toHaveLength(1);
    expect(res.body.data.outreachActivities[0]).toMatchObject({
      type: "email_sent",
      channel: "email",
      actorEmail: user.email,
      subject: "Your CallBackIQ demo",
    });
  });

  test("does not log an email when delivery fails", async () => {
    const demo = await createDemo();
    const { token } = await createAdmin();
    jest.spyOn(DemoNotificationService, "send").mockResolvedValue(false);

    const res = await request(app)
      .post(`/api/demo-requests/${demo._id}/emails`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        subject: "Your CallBackIQ demo",
        body: "Hi John",
      });

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);

    const saved = await DemoRequest.findById(demo._id);
    expect(saved.outreachActivities).toHaveLength(0);
    expect(saved.lastOutreachAt).toBeNull();
    expect(saved.status).toBe("scheduled");
  });

  test("rejects empty email content", async () => {
    const demo = await createDemo();
    const { token } = await createAdmin();
    const sendSpy = jest.spyOn(DemoNotificationService, "send");

    const res = await request(app)
      .post(`/api/demo-requests/${demo._id}/emails`)
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "", body: "" });

    expect(res.status).toBe(400);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
