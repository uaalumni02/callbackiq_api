import jwt from "jsonwebtoken";
import request from "supertest";

import app from "../../src/app.js";
import DemoRequest from "../../src/models/demoRequest.js";
import User from "../../src/models/user.js";
import DemoBrowserCallService from "../../src/services/demoBrowserCall.service.js";
import { connectTestDB, clearTestDB, closeTestDB } from "../setup/testDb.js";

jest.mock("../../src/services/demoBrowserCall.service.js", () => ({
  __esModule: true,
  buildFailureTwiml: jest.fn(() => "<Response><Hangup/></Response>"),
  default: {
    createSession: jest.fn(),
    buildTwiml: jest.fn(),
    applyProspectStatus: jest.fn(),
    applyClientStatus: jest.fn(),
  },
}));

beforeAll(async () => {
  await connectTestDB();
}, 60_000);

afterEach(async () => {
  jest.clearAllMocks();
  await clearTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

const tokenFor = (user) =>
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
    userName: role === "admin" ? "browsercalladmin" : "browsercallowner",
    email:
      role === "admin"
        ? "browser-call-admin@callbackiq.com"
        : "browser-call-owner@example.com",
    password: "Password123",
    role,
    businessName: role === "admin" ? "CallBackIQ Admin" : "ABC Plumbing",
    businessPhone: "4045551212",
    businessType: "other",
    smsConsent: true,
    termsAccepted: true,
    privacyAccepted: true,
  });
  return { user, token: tokenFor(user) };
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

describe("Demo browser call routes", () => {
  test("rejects unauthenticated call-session creation", async () => {
    const demo = await createDemo();
    const res = await request(app).post(
      `/api/demo-requests/${demo._id}/call-sessions`,
    );

    expect(res.status).toBe(401);
    expect(DemoBrowserCallService.createSession).not.toHaveBeenCalled();
  });

  test("rejects non-admin call-session creation", async () => {
    const demo = await createDemo();
    const { token } = await createUser("owner");

    const res = await request(app)
      .post(`/api/demo-requests/${demo._id}/call-sessions`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(DemoBrowserCallService.createSession).not.toHaveBeenCalled();
  });

  test("creates a short-lived browser call session without changing pipeline status", async () => {
    const demo = await createDemo();
    const { user, token } = await createUser("admin");
    DemoBrowserCallService.createSession.mockResolvedValue({
      demo: {
        ...demo.toObject(),
        status: "scheduled",
        contactedAt: null,
        lastOutreachChannel: "phone",
      },
      session: {
        token: "twilio-access-token",
        attemptId: "attempt-1",
        expiresIn: 600,
        callerId: "+16785768258",
        connectParams: {
          demoRequestId: String(demo._id),
          attemptId: "attempt-1",
        },
      },
    });

    const res = await request(app)
      .post(`/api/demo-requests/${demo._id}/call-sessions`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.demo.status).toBe("scheduled");
    expect(res.body.data.demo.contactedAt).toBeNull();
    expect(res.body.data.session.callerId).toBe("+16785768258");
    expect(DemoBrowserCallService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        demoId: String(demo._id),
        actorEmail: user.email,
      }),
    );
  });

  test("serves TwiML to Twilio without admin authentication in test mode", async () => {
    const demoId = "507f1f77bcf86cd799439011";
    DemoBrowserCallService.buildTwiml.mockResolvedValue(
      '<Response><Dial callerId="+16785768258">+14045551111</Dial></Response>',
    );

    const res = await request(app)
      .post("/api/demo-requests/browser-call-twiml")
      .type("form")
      .send({
        demoRequestId: demoId,
        attemptId: "attempt-1",
        CallSid: "CA11111111111111111111111111111111",
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/xml/);
    expect(res.text).toContain("<Dial");
    expect(DemoBrowserCallService.buildTwiml).toHaveBeenCalledWith(
      expect.objectContaining({
        demoId,
        attemptId: "attempt-1",
        providerCallSid: "CA11111111111111111111111111111111",
      }),
    );
  });

  test("accepts signed-provider child-call status callbacks in test mode", async () => {
    const demoId = "507f1f77bcf86cd799439011";
    DemoBrowserCallService.applyProspectStatus.mockResolvedValue({ _id: demoId });

    const res = await request(app)
      .post(
        `/api/demo-requests/browser-call-status?demoRequestId=${demoId}&attemptId=attempt-1`,
      )
      .type("form")
      .send({
        CallSid: "CA22222222222222222222222222222222",
        CallStatus: "in-progress",
      });

    expect(res.status).toBe(204);
    expect(DemoBrowserCallService.applyProspectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        demoId,
        attemptId: "attempt-1",
        payload: expect.objectContaining({ CallStatus: "in-progress" }),
      }),
    );
  });

  test("lets only admins report the browser client state", async () => {
    const demo = await createDemo();
    const { token } = await createUser("admin");
    DemoBrowserCallService.applyClientStatus.mockResolvedValue({
      ...demo.toObject(),
      lastOutreachChannel: "phone",
    });

    const res = await request(app)
      .post(
        `/api/demo-requests/${demo._id}/call-sessions/attempt-1/client-status`,
      )
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "connected", providerCallSid: "CA333" });

    expect(res.status).toBe(200);
    expect(DemoBrowserCallService.applyClientStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        demoId: String(demo._id),
        attemptId: "attempt-1",
        status: "connected",
        providerCallSid: "CA333",
      }),
    );
  });
});
