import request from "supertest";

import app from "../../src/app.js";
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

const registerOwner = async () => {
  const response = await request(app).post("/api/auth/register").send({
    userName: "factsowner",
    email: "facts-owner@callbackiq.com",
    password: "Password123",
    businessName: "Verified Facts Plumbing",
    businessPhone: "4045557100",
    businessType: "plumbing",
    smsConsent: false,
    termsAccepted: true,
    privacyAccepted: true,
  });

  return response.body.data.token;
};

describe("Verified business facts routes", () => {
  test("owner can store verified facts without enabling booking claims", async () => {
    const token = await registerOwner();

    const response = await request(app)
      .put("/api/businesses/mine/facts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        facts: {
          approvedServices: {
            value: ["Drain cleaning", "Water heater repair"],
            verified: true,
          },
          serviceAreas: {
            value: ["Atlanta", "Decatur"],
            verified: true,
          },
          pricing: {
            value: {
              policy: "no_quotes",
              notes: "Technician confirms all pricing.",
              ranges: [],
            },
            verified: true,
          },
        },
        capabilities: {
          canConfirmAppointment: false,
          canQuotePrices: false,
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.data.facts.approvedServices.verified).toBe(true);
    expect(response.body.data.capabilities.canConfirmAppointment).toBe(false);
  });

  test("owner cannot enable unverified appointment confirmation", async () => {
    const token = await registerOwner();

    const response = await request(app)
      .put("/api/businesses/mine/facts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        facts: {
          schedulingRules: {
            value: "Collect preferences only.",
            verified: true,
          },
        },
        capabilities: {
          canConfirmAppointment: true,
        },
      });

    expect(response.status).toBe(400);
  });
});
