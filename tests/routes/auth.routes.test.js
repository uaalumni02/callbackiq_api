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

  smsConsent: true,
  termsAccepted: true,
  privacyAccepted: true,
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

  test("POST /api/password-reset creates reset token for existing user", async () => {
    await request(app).post("/api/auth/register").send(validRegisterPayload);

    const res = await request(app).post("/api/password-reset").send({
      email: "owner@callbackiq.com",
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const savedUser = await User.findOne({
      email: "owner@callbackiq.com",
    }).select("+resetToken +resetTokenExpiresAt");

    expect(savedUser).toBeTruthy();
    expect(savedUser.resetToken).toBeTruthy();
    expect(savedUser.resetTokenExpiresAt).toBeTruthy();
    expect(savedUser.resetTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test("POST /api/password-reset returns success for unknown email without creating token", async () => {
    const res = await request(app).post("/api/password-reset").send({
      email: "missing@callbackiq.com",
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const missingUser = await User.findOne({
      email: "missing@callbackiq.com",
    }).select("+resetToken +resetTokenExpiresAt");

    expect(missingUser).toBeNull();
  });

  test("POST /api/password-reset rejects invalid email", async () => {
    const res = await request(app).post("/api/password-reset").send({
      email: "bad-email",
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/password-reset/:resetToken resets password and clears reset token", async () => {
    await request(app).post("/api/auth/register").send(validRegisterPayload);

    await request(app).post("/api/password-reset").send({
      email: "owner@callbackiq.com",
    });

    const userWithToken = await User.findOne({
      email: "owner@callbackiq.com",
    }).select("+resetToken +resetTokenExpiresAt");

    expect(userWithToken.resetToken).toBeTruthy();

    const resetRes = await request(app)
      .post(`/api/password-reset/${userWithToken.resetToken}`)
      .send({
        password: "NewPassword123",
      });

    expect(resetRes.status).toBe(200);
    expect(resetRes.body.success).toBe(true);

    const updatedUser = await User.findOne({
      email: "owner@callbackiq.com",
    }).select("+resetToken +resetTokenExpiresAt");

    expect(updatedUser.resetToken).toBeNull();
    expect(updatedUser.resetTokenExpiresAt).toBeNull();
    expect(updatedUser.password).not.toBe("NewPassword123");

    const oldLoginRes = await request(app).post("/api/auth/login").send({
      login: "owner@callbackiq.com",
      password: "Password123",
    });

    expect(oldLoginRes.status).toBe(401);
    expect(oldLoginRes.body.success).toBe(false);

    const newLoginRes = await request(app).post("/api/auth/login").send({
      login: "owner@callbackiq.com",
      password: "NewPassword123",
    });

    expect(newLoginRes.status).toBe(200);
    expect(newLoginRes.body.success).toBe(true);
    expect(newLoginRes.body.data.token).toBeTruthy();
  });

  test("POST /api/password-reset/:resetToken rejects invalid token", async () => {
    const res = await request(app).post("/api/password-reset/bad-token").send({
      password: "NewPassword123",
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/password-reset/:resetToken rejects expired token", async () => {
    await request(app).post("/api/auth/register").send(validRegisterPayload);

    const expiredToken = "expired-reset-token";

    await User.findOneAndUpdate(
      { email: "owner@callbackiq.com" },
      {
        resetToken: expiredToken,
        resetTokenExpiresAt: new Date(Date.now() - 60 * 1000),
      },
      { returnDocument: "after" },
    );

    const res = await request(app)
      .post(`/api/password-reset/${expiredToken}`)
      .send({
        password: "NewPassword123",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/password-reset/:resetToken rejects invalid password format", async () => {
    await request(app).post("/api/auth/register").send(validRegisterPayload);

    await request(app).post("/api/password-reset").send({
      email: "owner@callbackiq.com",
    });

    const userWithToken = await User.findOne({
      email: "owner@callbackiq.com",
    }).select("+resetToken +resetTokenExpiresAt");

    const res = await request(app)
      .post(`/api/password-reset/${userWithToken.resetToken}`)
      .send({
        password: "123",
      });

    expect(res.status).toBe(400);
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
