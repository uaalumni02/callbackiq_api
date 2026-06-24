import request from "supertest";

import app from "../../src/app.js";
import User from "../../src/models/user.js";
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

const validRegisterPayload = {
  userName: "demoowner",
  email: "owner@callbackiq.com",
  password: "Password123",
  businessName: "Atlanta Pro Plumbing",
  businessPhone: "4045551234",
  businessType: "plumbing",
};

describe("Auth Routes", () => {
  test("POST /api/auth/register creates user, business, trial subscription and returns token", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send(validRegisterPayload);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeTruthy();
    expect(res.body.data.user.email).toBe("owner@callbackiq.com");
    expect(res.body.data.business.businessName).toBe("Atlanta Pro Plumbing");
    expect(res.body.data.business.phone).toBe("4045551234");
    expect(res.body.data.subscription.status).toBe("trialing");

    const savedUser = await User.findOne({ email: "owner@callbackiq.com" });
    expect(savedUser).toBeTruthy();
    expect(savedUser.password).not.toBe("Password123");

    const savedBusiness = await Business.findOne({ owner: savedUser._id });
    expect(savedBusiness).toBeTruthy();
    expect(savedBusiness.businessName).toBe("Atlanta Pro Plumbing");
    expect(savedBusiness.phone).toBe("4045551234");
    expect(savedBusiness.isActive).toBe(true);

    const savedSubscription = await Subscription.findOne({
      business: savedBusiness._id,
    });

    expect(savedSubscription).toBeTruthy();
    expect(savedSubscription.plan).toBe("pro");
    expect(savedSubscription.status).toBe("trialing");
    expect(savedSubscription.aiEnabled).toBe(true);
  });

  test("POST /api/auth/register rejects duplicate user", async () => {
    await request(app).post("/api/auth/register").send(validRegisterPayload);

    const res = await request(app)
      .post("/api/auth/register")
      .send({
        ...validRegisterPayload,
      });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/auth/register rejects invalid data", async () => {
    const res = await request(app).post("/api/auth/register").send({
      userName: "",
      email: "bad-email",
      password: "123",
      businessName: "",
      businessPhone: "",
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/auth/login logs user in with username", async () => {
    await request(app).post("/api/auth/register").send(validRegisterPayload);

    const res = await request(app).post("/api/auth/login").send({
      login: "demoowner",
      password: "Password123",
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeTruthy();
    expect(res.body.data.user.userName).toBe("demoowner");
  });

  test("POST /api/auth/login logs user in with email", async () => {
    await request(app).post("/api/auth/register").send(validRegisterPayload);

    const res = await request(app).post("/api/auth/login").send({
      login: "owner@callbackiq.com",
      password: "Password123",
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeTruthy();
  });

  test("POST /api/auth/login rejects bad password", async () => {
    await request(app).post("/api/auth/register").send(validRegisterPayload);

    const res = await request(app).post("/api/auth/login").send({
      login: "demoowner",
      password: "WrongPassword",
    });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("GET /api/auth/me rejects unauthenticated request", async () => {
    const res = await request(app).get("/api/auth/me");

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("GET /api/auth/me returns current user when authenticated", async () => {
    const registerRes = await request(app)
      .post("/api/auth/register")
      .send(validRegisterPayload);

    const token = registerRes.body.data.token;

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.email).toBe("owner@callbackiq.com");
  });

  test("POST /api/auth/logout clears session", async () => {
    const res = await request(app).post("/api/auth/logout");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
