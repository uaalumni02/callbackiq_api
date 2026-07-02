import request from "supertest";

import app from "../../src/app.js";
import User from "../../src/models/user.js";
import Business from "../../src/models/business.js";
import Subscription from "../../src/models/subscription.js";
import Token from "../../src/helpers/jwt/token.js";
import bcrypt from "../../src/helpers/bcrypt/bcrypt.js";
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
    smsConsent: true,
    termsAccepted: true,
    privacyAccepted: true,
  });

  const business = await Business.findByIdAndUpdate(
    registerRes.body.data.business._id,
    { isActive },
    { returnDocument: "after" },
  );

  return {
    token: registerRes.body.data.token,
    user: registerRes.body.data.user,
    business,
  };
};

const createBareUserToken = async () => {
  const hashedPassword = await bcrypt.hashPassword("Password123", 10);

  const user = await User.create({
    userName: "nobusiness",
    email: "nobusiness@callbackiq.com",
    password: hashedPassword,
    role: "owner",
    businessName: "No Business",
    businessPhone: "4045550000",
    businessType: "plumbing",
  });

  return Token.sign({
    userId: user._id,
    userName: user.userName,
    email: user.email,
    role: user.role,
  });
};

const createAdminToken = async () => {
  const hashedPassword = await bcrypt.hashPassword("Password123", 10);

  const user = await User.create({
    userName: "adminuser",
    email: "admin@callbackiq.com",
    password: hashedPassword,
    role: "admin",
    businessName: "CallBackIQ Admin",
    businessPhone: "4045559999",
    businessType: "other",
  });

  return Token.sign({
    userId: user._id,
    userName: user.userName,
    email: user.email,
    role: user.role,
  });
};

const createActiveSubscription = async (businessId) => {
  return await Subscription.findOneAndUpdate(
    { business: businessId },
    {
      business: businessId,
      stripeCustomerId: "cus_test_active_business",
      stripeSubscriptionId: "sub_test_active_business",
      plan: "pro",
      status: "active",
      aiEnabled: true,
      isActive: true,
    },
    {
      upsert: true,
      returnDocument: "after",
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  );
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
    const token = await createBareUserToken();

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
    const token = await createAdminToken();

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
