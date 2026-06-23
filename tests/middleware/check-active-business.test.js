import request from "supertest";

import app from "../../src/app.js";
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

const registerAndCreateBusiness = async ({
  userName = "demoowner",
  email = "owner@callbackiq.com",
  role = "owner",
  businessName = "Atlanta Pro Plumbing",
  isActive = true,
} = {}) => {
  const registerRes = await request(app).post("/api/auth/register").send({
    userName,
    email,
    password: "Password123",
    role,
    businessName,
    businessPhone: "4045551234",
    businessType: "plumbing",
  });

  const token = registerRes.body.data.token;

  const businessRes = await request(app)
    .post("/api/businesses")
    .set("Authorization", `Bearer ${token}`)
    .send({
      businessName,
      businessType: "plumbing",
      phone: "4045551234",
      email,
      estimatedJobValue: 800,
    });

  const business = await Business.findByIdAndUpdate(
    businessRes.body.data._id,
    { isActive },
    { returnDocument: "after" },
  );

  return {
    token,
    user: registerRes.body.data.user,
    business,
  };
};

const createActiveSubscription = async (businessId) => {
  return await Subscription.create({
    business: businessId,
    stripeCustomerId: "cus_test_active_business",
    stripeSubscriptionId: "sub_test_active_business",
    plan: "pro",
    status: "active",
    aiEnabled: true,
  });
};

describe("Active Business Middleware", () => {
  test("blocks protected route when business is inactive", async () => {
    const { token, business } = await registerAndCreateBusiness({
      isActive: false,
    });

    await createActiveSubscription(business._id);

    const res = await request(app)
      .get("/api/dashboard")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe(
      "This account is inactive. Please contact support to restore access.",
    );
    expect(String(res.body.data.businessId)).toBe(String(business._id));
    expect(res.body.data.businessName).toBe("Atlanta Pro Plumbing");
    expect(res.body.data.isActive).toBe(false);
  });

  test("allows protected route when business is active", async () => {
    const { token, business } = await registerAndCreateBusiness({
      isActive: true,
    });

    await createActiveSubscription(business._id);

    const res = await request(app)
      .get("/api/dashboard")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("returns bad input when authenticated user has no business", async () => {
    const registerRes = await request(app).post("/api/auth/register").send({
      userName: "nobusiness",
      email: "nobusiness@callbackiq.com",
      password: "Password123",
      businessName: "No Business",
      businessPhone: "4045550000",
      businessType: "plumbing",
    });

    const token = registerRes.body.data.token;

    const res = await request(app)
      .get("/api/dashboard")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe(
      "Business not found. Create a business before using this feature.",
    );
  });

  test("admin bypasses active business check", async () => {
    const registerRes = await request(app).post("/api/auth/register").send({
      userName: "adminuser",
      email: "admin@callbackiq.com",
      password: "Password123",
      role: "admin",
      businessName: "CallBackIQ Admin",
      businessPhone: "4045559999",
      businessType: "other",
    });

    const token = registerRes.body.data.token;

    const res = await request(app)
      .get("/api/admin/dashboard")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).not.toBe(403);
  });

  test("rejects unauthenticated request before active business check", async () => {
    const res = await request(app).get("/api/dashboard");

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});
