import request from "supertest";

import app from "../../src/app.js";
import Token from "../../src/helpers/jwt/token.js";
import { connectTestDB, clearTestDB, closeTestDB } from "../setup/testDb.js";

beforeAll(async () => {
  await connectTestDB();
}, 60_000);

afterEach(async () => {
  jest.restoreAllMocks();
  await clearTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

const registerUser = async () => {
  const registerRes = await request(app).post("/api/auth/register").send({
    userName: "demoowner",
    email: "owner@callbackiq.com",
    password: "Password123",
    businessName: "Atlanta Pro Plumbing",
    businessPhone: "4045551234",
    businessType: "plumbing",
    smsConsent: true,
    termsAccepted: true,
    privacyAccepted: true,
  });

  return {
    token: registerRes.body.data.token,
    user: registerRes.body.data.user,
  };
};

describe("Check Auth Middleware", () => {
  test("rejects request when no token is provided", async () => {
    const res = await request(app).get("/api/auth/me");

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Not authenticated");
  });

  test("rejects invalid bearer token", async () => {
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", "Bearer invalid_token");

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Invalid or expired token");
  });

  test("allows valid bearer token", async () => {
    const { token } = await registerUser();

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.email).toBe("owner@callbackiq.com");
  });

  test("allows valid cookie token", async () => {
    const { token } = await registerUser();

    const res = await request(app)
      .get("/api/auth/me")
      .set("Cookie", [`token=${token}`]);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.email).toBe("owner@callbackiq.com");
  });

  test("uses cookie token when authorization header is missing", async () => {
    const { token } = await registerUser();

    const res = await request(app)
      .get("/api/auth/me")
      .set("Cookie", [`token=${token}`]);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("rejects expired token", async () => {
    jest.spyOn(Token, "verify").mockImplementation(() => {
      throw new Error("jwt expired");
    });

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", "Bearer expired_token");

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Invalid or expired token");
  });

  test("rejects malformed authorization header", async () => {
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", "InvalidTokenFormat");

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Not authenticated");
  });

  test("bearer token authenticates protected route", async () => {
    const { token } = await registerUser();

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("cookie token authenticates protected route", async () => {
    const { token } = await registerUser();

    const res = await request(app)
      .get("/api/auth/me")
      .set("Cookie", [`token=${token}`]);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
