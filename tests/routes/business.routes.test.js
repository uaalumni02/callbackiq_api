import request from "supertest";

import app from "../../src/app.js";
import User from "../../src/models/user.js";
import Business from "../../src/models/business.js";
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

const registerUserWithAutoBusiness = async () => {
  const res = await request(app).post("/api/auth/register").send({
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

  return res.body.data.token;
};

const createBareUserToken = async () => {
  const hashedPassword = await bcrypt.hashPassword("Password123", 10);

  const user = await User.create({
    userName: "bareowner",
    email: "bareowner@callbackiq.com",
    password: hashedPassword,
    role: "owner",
    businessName: "Bare Owner Business",
    businessPhone: "4045550000",
    businessType: "plumbing",
  });

  const token = Token.sign({
    userId: user._id,
    userName: user.userName,
    email: user.email,
    role: user.role,
  });

  return { token, user };
};

describe("Business Routes", () => {
  test("route is protected and rejects unauthenticated create", async () => {
    const res = await request(app).post("/api/businesses").send({
      businessName: "Atlanta Pro Plumbing",
      businessType: "plumbing",
      phone: "4045551234",
    });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("authenticated user without a business can create business and save to database", async () => {
    const { token } = await createBareUserToken();

    const res = await request(app)
      .post("/api/businesses")
      .set("Authorization", `Bearer ${token}`)
      .send({
        businessName: "Atlanta Pro Plumbing",
        businessType: "plumbing",
        phone: "4045551234",
        email: "owner@atlantaproplumbing.com",
        estimatedJobValue: 800,
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.businessName).toBe("Atlanta Pro Plumbing");

    const savedBusiness = await Business.findOne({
      businessName: "Atlanta Pro Plumbing",
    });

    expect(savedBusiness).toBeTruthy();
    expect(savedBusiness.businessType).toBe("plumbing");
  });

  test("business create rejects invalid data", async () => {
    const { token } = await createBareUserToken();

    const res = await request(app)
      .post("/api/businesses")
      .set("Authorization", `Bearer ${token}`)
      .send({
        businessName: "",
        businessType: "restaurant",
        phone: "bad-phone",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("authenticated registered user can get their auto-created business", async () => {
    const token = await registerUserWithAutoBusiness();

    const res = await request(app)
      .get("/api/businesses/mine")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.businessName).toBe("Atlanta Pro Plumbing");
    expect(res.body.data.phone).toBe("4045551234");
  });

  test("user cannot create two businesses", async () => {
    const token = await registerUserWithAutoBusiness();

    const res = await request(app)
      .post("/api/businesses")
      .set("Authorization", `Bearer ${token}`)
      .send({
        businessName: "Second Business",
        businessType: "hvac",
        phone: "4045559999",
      });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  test("business belongs to authenticated user", async () => {
    const token = await registerUserWithAutoBusiness();

    const user = await User.findOne({ email: "owner@callbackiq.com" });
    const business = await Business.findOne({ owner: user._id });

    expect(business).toBeTruthy();
    expect(String(business.owner)).toBe(String(user._id));

    const res = await request(app)
      .get("/api/businesses/mine")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(String(res.body.data.owner._id || res.body.data.owner)).toBe(
      String(user._id),
    );
  });
});
