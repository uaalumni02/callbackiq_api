import request from "supertest";

import app from "../../src/app.js";
import { connectTestDB, clearTestDB, closeTestDB } from "../setup/testDb.js";

beforeAll(async () => {
  await connectTestDB();
}, 60_000);

afterEach(async () => {
  await clearTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

const register = async (suffix = "1") => {
  const response = await request(app).post("/api/auth/register").send({
    userName: `configowner${suffix}`,
    email: `config-owner-${suffix}@callbackiq.com`,
    password: "Password123",
    role: "owner",
    businessName: `Configuration Test ${suffix}`,
    businessPhone: `404555${String(suffix).padStart(4, "0")}`,
    businessType: "plumbing",
    smsConsent: true,
    termsAccepted: true,
    privacyAccepted: true,
  });

  expect(response.status).toBe(201);
  return response.body.data;
};

const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe("Business configuration routes", () => {
  test("requires authentication", async () => {
    const response = await request(app).get(
      "/api/business-configuration/bootstrap",
    );

    expect(response.status).toBe(401);
  });

  test("creates isolated service offerings", async () => {
    const first = await register("11");
    const second = await register("12");

    const created = await request(app)
      .post("/api/business-configuration/services")
      .set(auth(first.token))
      .send({
        name: "Drain clearing",
        category: "drain",
        durationMinutes: 90,
        aiCanDiscuss: true,
        aiCanBook: true,
        keywords: ["clogged drain", "slow drain"],
      });

    expect(created.status).toBe(201);
    expect(created.body.data.durationMinutes).toBe(90);

    const firstList = await request(app)
      .get("/api/business-configuration/services")
      .set(auth(first.token));
    const secondList = await request(app)
      .get("/api/business-configuration/services")
      .set(auth(second.token));

    expect(firstList.body.data).toHaveLength(1);
    expect(secondList.body.data).toHaveLength(0);
  });

  test("stores business hours, exceptions, policy, service area, and operations", async () => {
    const account = await register("21");

    const rules = Array.from({ length: 7 }, (_, dayOfWeek) => ({
      dayOfWeek,
      enabled: dayOfWeek >= 1 && dayOfWeek <= 5,
      windows:
        dayOfWeek >= 1 && dayOfWeek <= 5
          ? [{ startTime: "08:00", endTime: "17:00" }]
          : [],
      timezone: "America/New_York",
      capacity: 2,
    }));

    const hours = await request(app)
      .put("/api/business-configuration/availability/rules")
      .set(auth(account.token))
      .send({ rules });
    expect(hours.status).toBe(200);
    expect(hours.body.data).toHaveLength(7);

    const exception = await request(app)
      .post("/api/business-configuration/availability/exceptions")
      .set(auth(account.token))
      .send({
        date: "2026-12-25",
        type: "holiday",
        name: "Christmas Day",
        allDay: true,
      });
    expect(exception.status).toBe(201);

    const policy = await request(app)
      .put("/api/business-configuration/scheduling-policy")
      .set(auth(account.token))
      .send({
        minimumNoticeMinutes: 120,
        maximumAdvanceDays: 45,
        slotIntervalMinutes: 30,
        defaultDurationMinutes: 90,
        requireAddressBeforeBooking: true,
        requireServiceBeforeBooking: true,
        allowSameDayBooking: false,
        allowAfterHoursBooking: false,
        customerCancellationAllowed: true,
        cancellationNoticeMinutes: 1440,
      });
    expect(policy.status).toBe(200);

    const area = await request(app)
      .put("/api/business-configuration/service-area")
      .set(auth(account.token))
      .send({
        type: "zip_codes",
        zipCodes: ["30303", "30305"],
        centerPostalCode: "",
        radiusMiles: 25,
      });
    expect(area.status).toBe(200);
    expect(area.body.data.zipCodes).toEqual(["30303", "30305"]);

    const operations = await request(app)
      .put("/api/business-configuration/operations-settings")
      .set(auth(account.token))
      .send({
        humanHandoffContacts: [
          {
            name: "Dispatch",
            role: "Dispatcher",
            phone: "4045550199",
            priority: 1,
            active: true,
          },
        ],
        emergencyPolicy: {
          enabled: true,
          afterHoursAction: "escalate",
          pauseAiOnEmergency: true,
        },
        aiPermissions: {
          canDiscussServices: true,
          canDiscussDiagnosticFees: false,
          canCollectAddress: true,
          canCollectAppointmentPreference: true,
          canBookEligibleServices: false,
          canConfirmAvailability: false,
          requireHumanReviewForUnknownService: true,
        },
        followUpSettings: {
          enabled: false,
          maxAttempts: 3,
          firstDelayMinutes: 60,
          subsequentDelayMinutes: 1440,
          stopOnCustomerReply: true,
          stopOnHumanTakeover: true,
        },
      });
    expect(operations.status).toBe(200);
  });

  test("evaluates the Phase 1 completion questions", async () => {
    const account = await register("31");

    await request(app)
      .post("/api/business-configuration/services")
      .set(auth(account.token))
      .send({
        name: "Water heater diagnostic",
        category: "water heater",
        durationMinutes: 120,
        aiCanDiscuss: true,
        aiCanBook: false,
        requiresHumanReview: true,
        keywords: ["water heater"],
      });

    await request(app)
      .put("/api/business-configuration/service-area")
      .set(auth(account.token))
      .send({ type: "zip_codes", zipCodes: ["30303"] });

    const result = await request(app)
      .post("/api/business-configuration/evaluate")
      .set(auth(account.token))
      .send({
        serviceQuery: "water heater problem",
        zipCode: "30303",
        customerHasAddress: true,
      });

    expect(result.status).toBe(200);
    expect(result.body.data.servicePerformed).toBe(true);
    expect(result.body.data.locationSupported).toBe(true);
    expect(result.body.data.durationMinutes).toBe(120);
    expect(result.body.data.mayAiBook).toBe(false);
    expect(result.body.data.requiresHumanReview).toBe(true);
  });
});
