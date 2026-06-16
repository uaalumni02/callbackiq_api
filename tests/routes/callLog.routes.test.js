import request from "supertest";

import app from "../../src/app.js";
import CallLog from "../../src/models/callLog.js";
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

const registerAndCreateBusiness = async () => {
  const registerRes = await request(app).post("/api/auth/register").send({
    userName: "demoowner",
    email: "owner@callbackiq.com",
    password: "Password123",
    businessName: "Atlanta Pro Plumbing",
  });

  const token = registerRes.body.data.token;

  await request(app)
    .post("/api/businesses")
    .set("Authorization", `Bearer ${token}`)
    .send({
      businessName: "Atlanta Pro Plumbing",
      businessType: "plumbing",
      phone: "4045551234",
    });

  return token;
};

describe("Call Log Routes", () => {
  test("POST /api/calls rejects unauthenticated request", async () => {
    const res = await request(app).post("/api/calls").send({
      from: "4045559999",
      to: "4045551234",
    });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/calls creates call log", async () => {
    const token = await registerAndCreateBusiness();

    const res = await request(app)
      .post("/api/calls")
      .set("Authorization", `Bearer ${token}`)
      .send({
        from: "4045559999",
        to: "4045551234",
        direction: "inbound",
        status: "missed",
        durationSeconds: 0,
        provider: "manual",
        notes: "Missed customer call.",
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("missed");

    const savedCallLog = await CallLog.findOne({ from: "4045559999" });
    expect(savedCallLog).toBeTruthy();
  });

  test("POST /api/calls rejects invalid data", async () => {
    const token = await registerAndCreateBusiness();

    const res = await request(app)
      .post("/api/calls")
      .set("Authorization", `Bearer ${token}`)
      .send({
        from: "bad-phone",
        to: "4045551234",
        status: "ignored",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("GET /api/calls returns call logs", async () => {
    const token = await registerAndCreateBusiness();

    await request(app)
      .post("/api/calls")
      .set("Authorization", `Bearer ${token}`)
      .send({
        from: "4045559999",
        to: "4045551234",
      });

    const res = await request(app)
      .get("/api/calls")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.length).toBe(1);
  });

  test("GET /api/calls/:id returns call log", async () => {
    const token = await registerAndCreateBusiness();

    const createRes = await request(app)
      .post("/api/calls")
      .set("Authorization", `Bearer ${token}`)
      .send({
        from: "4045559999",
        to: "4045551234",
      });

    const callLogId = createRes.body.data._id;

    const res = await request(app)
      .get(`/api/calls/${callLogId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data._id).toBe(callLogId);
  });

  test("PATCH /api/calls/:id updates call log", async () => {
    const token = await registerAndCreateBusiness();

    const createRes = await request(app)
      .post("/api/calls")
      .set("Authorization", `Bearer ${token}`)
      .send({
        from: "4045559999",
        to: "4045551234",
      });

    const callLogId = createRes.body.data._id;

    const res = await request(app)
      .patch(`/api/calls/${callLogId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        from: "4045559999",
        to: "4045551234",
        direction: "inbound",
        status: "answered",
        durationSeconds: 180,
        provider: "manual",
        missedCallTextSent: true,
        recovered: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("answered");
    expect(res.body.data.durationSeconds).toBe(180);
    expect(res.body.data.recovered).toBe(true);
  });

  test("DELETE /api/calls/:id deletes call log", async () => {
    const token = await registerAndCreateBusiness();

    const createRes = await request(app)
      .post("/api/calls")
      .set("Authorization", `Bearer ${token}`)
      .send({
        from: "4045559999",
        to: "4045551234",
      });

    const callLogId = createRes.body.data._id;

    const res = await request(app)
      .delete(`/api/calls/${callLogId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const deletedCallLog = await CallLog.findById(callLogId);
    expect(deletedCallLog).toBeFalsy();
  });
});
