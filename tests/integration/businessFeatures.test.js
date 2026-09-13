
import request from "supertest";

import app from "../../src/app.js";
import Business from "../../src/models/business.js";
import User from "../../src/models/user.js";
import Token from "../../src/helpers/jwt/token.js";
import bcrypt from "../../src/helpers/bcrypt/bcrypt.js";
import {
  connectTestDB,
  clearTestDB,
  closeTestDB,
} from "../setup/testDb.js";

beforeAll(async () => {
  await connectTestDB();
}, 60_000);

afterEach(async () => {
  await clearTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

const registerOwner = async () => {
  const response = await request(app).post("/api/auth/register").send({
    userName: "featureowner",
    email: "feature-owner@callbackiq.com",
    password: "Password123",
    businessName: "Atlanta Pro Plumbing",
    businessPhone: "4045551234",
    businessType: "plumbing",
    smsConsent: true,
    termsAccepted: true,
    privacyAccepted: true,
  });

  expect(response.status).toBe(201);

  return {
    token: response.body.data.token,
    business: response.body.data.business,
  };
};

const createBareOwner = async () => {
  const password = await bcrypt.hashPassword("Password123", 10);

  const user = await User.create({
    userName: "barefeatureowner",
    email: "bare-feature-owner@callbackiq.com",
    password,
    role: "owner",
    businessName: "Bare Feature Business",
    businessPhone: "4045550000",
    businessType: "plumbing",
  });

  return {
    user,
    token: Token.sign({
      userId: user._id,
      userName: user.userName,
      email: user.email,
      role: user.role,
    }),
  };
};

const expectedDefaults = {
  missedCallSmsEnabled: true,
  aiQualificationEnabled: true,
  aiBookingEnabled: false,
  automatedFollowUpEnabled: false,
  voiceAiEnabled: false,
  revenueTrackingEnabled: false,
  calendarProvider: "internal",
};

describe("Business feature rollout settings", () => {
  test("registration creates the complete Phase 0 defaults", async () => {
    const { business } = await registerOwner();

    expect(business.features).toEqual(expectedDefaults);

    const storedBusiness = await Business.findById(business._id).lean();

    expect(storedBusiness.features).toEqual(expectedDefaults);
  });

  test("GET /api/businesses/mine returns the complete feature object", async () => {
    const { token } = await registerOwner();

    const response = await request(app)
      .get("/api/businesses/mine")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.data.features).toEqual(expectedDefaults);
  });

  test("an owner can partially update implemented feature flags", async () => {
    const { token, business } = await registerOwner();

    const response = await request(app)
      .patch("/api/businesses/mine")
      .set("Authorization", `Bearer ${token}`)
      .send({
        features: {
          missedCallSmsEnabled: false,
          aiQualificationEnabled: false,
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.data.features).toEqual({
      ...expectedDefaults,
      missedCallSmsEnabled: false,
      aiQualificationEnabled: false,
    });

    const storedBusiness = await Business.findById(business._id).lean();

    expect(storedBusiness.features).toEqual({
      ...expectedDefaults,
      missedCallSmsEnabled: false,
      aiQualificationEnabled: false,
    });
  });

  test.each([
    ["aiBookingEnabled", true],
    ["automatedFollowUpEnabled", true],
    ["voiceAiEnabled", true],
    ["revenueTrackingEnabled", true],
    ["calendarProvider", "google"],
  ])(
    "an owner cannot activate unfinished feature %s",
    async (featureName, value) => {
      const { token, business } = await registerOwner();

      const response = await request(app)
        .patch("/api/businesses/mine")
        .set("Authorization", `Bearer ${token}`)
        .send({
          features: {
            [featureName]: value,
          },
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);

      const storedBusiness = await Business.findById(business._id).lean();

      expect(storedBusiness.features).toEqual(expectedDefaults);
    },
  );

  test("creating a business may set only implemented feature flags", async () => {
    const { token } = await createBareOwner();

    const response = await request(app)
      .post("/api/businesses")
      .set("Authorization", `Bearer ${token}`)
      .send({
        businessName: "Feature Test Plumbing",
        businessType: "plumbing",
        phone: "4045554321",
        features: {
          missedCallSmsEnabled: false,
          aiQualificationEnabled: true,
        },
      });

    expect(response.status).toBe(201);
    expect(response.body.data.features).toEqual({
      ...expectedDefaults,
      missedCallSmsEnabled: false,
    });
  });

  test("partial business updates preserve required identity fields", async () => {
    const { token, business } = await registerOwner();

    const response = await request(app)
      .patch("/api/businesses/mine")
      .set("Authorization", `Bearer ${token}`)
      .send({
        estimatedJobValue: 1500,
      });

    expect(response.status).toBe(200);
    expect(response.body.data.estimatedJobValue).toBe(1500);
    expect(response.body.data.businessName).toBe("Atlanta Pro Plumbing");
    expect(response.body.data.phone).toBeUndefined();
    expect(response.body.data.forwardingPhone).toBe("+14045551234");

    const storedBusiness = await Business.findById(business._id);

    expect(storedBusiness.businessName).toBe("Atlanta Pro Plumbing");
    // The partial update must not turn the customer's forwarding number
    // into a CallBackIQ tracking number.
    expect(storedBusiness.phone).toBeUndefined();
  });
});
