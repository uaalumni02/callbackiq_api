
import request from "supertest";

import app from "../../src/app.js";
import User from "../../src/models/user.js";
import Business from "../../src/models/business.js";
import Token from "../../src/helpers/jwt/token.js";
import bcrypt from "../../src/helpers/bcrypt/bcrypt.js";
import {
  connectTestDB,
  clearTestDB,
  closeTestDB,
} from "../setup/testDb.js";

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  await clearTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

const featureDefaults = {
  missedCallSmsEnabled: true,
  aiQualificationEnabled: true,
  aiBookingEnabled: false,
  automatedFollowUpEnabled: false,
  voiceAiEnabled: false,
  revenueTrackingEnabled: false,
  calendarProvider: "internal",
};

const registerUserWithAutoBusiness = async () => {
  const response = await request(app).post("/api/auth/register").send({
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
    token: response.body.data.token,
    business: response.body.data.business,
  };
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
    const response = await request(app).post("/api/businesses").send({
      businessName: "Atlanta Pro Plumbing",
      businessType: "plumbing",
      phone: "4045551234",
    });

    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
  });

  test("authenticated user without a business can create a business", async () => {
    const { token } = await createBareUserToken();

    const response = await request(app)
      .post("/api/businesses")
      .set("Authorization", `Bearer ${token}`)
      .send({
        businessName: "Atlanta Pro Plumbing",
        businessType: "plumbing",
        phone: "4045551234",
        email: "owner@atlantaproplumbing.com",
        estimatedJobValue: 800,
      });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.businessName).toBe("Atlanta Pro Plumbing");
    expect(response.body.data.features).toEqual(featureDefaults);

    const savedBusiness = await Business.findOne({
      businessName: "Atlanta Pro Plumbing",
    }).lean();

    expect(savedBusiness).toBeTruthy();
    expect(savedBusiness.features).toEqual(featureDefaults);
  });

  test("business create rejects invalid data", async () => {
    const { token } = await createBareUserToken();

    const response = await request(app)
      .post("/api/businesses")
      .set("Authorization", `Bearer ${token}`)
      .send({
        businessName: "",
        businessType: "restaurant",
        phone: "bad-phone",
      });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  test("registered user can get their auto-created business and features", async () => {
    const { token } = await registerUserWithAutoBusiness();

    const response = await request(app)
      .get("/api/businesses/mine")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.businessName).toBe("Atlanta Pro Plumbing");
    expect(response.body.data.phone).toBe("4045551234");
    expect(response.body.data.features).toEqual(featureDefaults);
  });

  test("PATCH /api/businesses/mine supports partial feature updates", async () => {
    const { token, business } = await registerUserWithAutoBusiness();

    const response = await request(app)
      .patch("/api/businesses/mine")
      .set("Authorization", `Bearer ${token}`)
      .send({
        features: {
          missedCallSmsEnabled: false,
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    expect(response.body.data.features).toEqual({
      ...featureDefaults,
      missedCallSmsEnabled: false,
    });

    const storedBusiness = await Business.findById(business._id).lean();

    expect(storedBusiness.features).toEqual({
      ...featureDefaults,
      missedCallSmsEnabled: false,
    });
  });

  test("PATCH /api/businesses/mine rejects unfinished feature flags", async () => {
    const { token, business } = await registerUserWithAutoBusiness();

    const response = await request(app)
      .patch("/api/businesses/mine")
      .set("Authorization", `Bearer ${token}`)
      .send({
        features: {
          voiceAiEnabled: true,
        },
      });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);

    const storedBusiness = await Business.findById(business._id).lean();

    expect(storedBusiness.features).toEqual(featureDefaults);
  });

  test("user cannot create two businesses", async () => {
    const { token } = await registerUserWithAutoBusiness();

    const response = await request(app)
      .post("/api/businesses")
      .set("Authorization", `Bearer ${token}`)
      .send({
        businessName: "Second Business",
        businessType: "hvac",
        phone: "4045559999",
      });

    expect(response.status).toBe(409);
    expect(response.body.success).toBe(false);
  });

  test("business belongs to the authenticated user", async () => {
    const { token } = await registerUserWithAutoBusiness();

    const user = await User.findOne({
      email: "owner@callbackiq.com",
    });

    const business = await Business.findOne({
      owner: user._id,
    });

    expect(business).toBeTruthy();
    expect(String(business.owner)).toBe(String(user._id));

    const response = await request(app)
      .get("/api/businesses/mine")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);

    expect(
      String(response.body.data.owner._id || response.body.data.owner),
    ).toBe(String(user._id));
  });
});
