import request from "supertest";

import app from "../../src/app.js";
import User from "../../src/models/user.js";
import Business from "../../src/models/business.js";
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

const registerUser = async () => {
  const res = await request(app).post("/api/auth/register").send({
    userName: "demoowner",
    email: "owner@callbackiq.com",
    password: "Password123",
    businessName: "Atlanta Pro Plumbing",
    businessPhone: "4045551234",
    businessType: "plumbing",
  });

  return res.body.data.token;
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

  test("authenticated user can create business and save to database", async () => {
    const token = await registerUser();

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
    const token = await registerUser();

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

  test("authenticated user can get their business", async () => {
    const token = await registerUser();

    await request(app)
      .post("/api/businesses")
      .set("Authorization", `Bearer ${token}`)
      .send({
        businessName: "Atlanta Pro Plumbing",
        businessType: "plumbing",
        phone: "4045551234",
      });

    const res = await request(app)
      .get("/api/businesses/mine")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.businessName).toBe("Atlanta Pro Plumbing");
  });

  test("user cannot create two businesses", async () => {
    const token = await registerUser();

    await request(app)
      .post("/api/businesses")
      .set("Authorization", `Bearer ${token}`)
      .send({
        businessName: "Atlanta Pro Plumbing",
        businessType: "plumbing",
        phone: "4045551234",
      });

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
    const token = await registerUser();

    const createRes = await request(app)
      .post("/api/businesses")
      .set("Authorization", `Bearer ${token}`)
      .send({
        businessName: "Atlanta Pro Plumbing",
        businessType: "plumbing",
        phone: "4045551234",
      });

    const user = await User.findOne({ email: "owner@callbackiq.com" });

    expect(String(createRes.body.data.owner)).toBe(String(user._id));
  });
});
