import request from "supertest";

import app from "../../src/app.js";
import DemoRequest from "../../src/models/demoRequest.js";
import DemoNotificationService from "../../src/services/demoNotification.service.js";
import { connectTestDB, clearTestDB, closeTestDB } from "../setup/testDb.js";

jest.mock("../../src/services/demoNotification.service.js", () => ({
  __esModule: true,
  default: {
    notifyScheduled: jest.fn().mockResolvedValue([]),
    notifyAdminNewRequest: jest.fn().mockResolvedValue(false),
    notifyCancelled: jest.fn().mockResolvedValue([]),
  },
}));

describe("Atomic Book a Demo route", () => {
  beforeAll(async () => {
    await connectTestDB();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await clearTestDB();
  });

  afterAll(async () => {
    await closeTestDB();
  });

  const basePayload = {
    fullName: "John Smith",
    email: "owner@example.com",
    phone: "",
    businessName: "ABC Plumbing",
    businessType: "plumbing",
    monthlyCallVolume: "500_1000",
    visitorTimezone: "America/New_York",
    preferredTime: "",
    message: "After-hours missed calls",
    source: "book_demo_page",
    faxNumber: "",
  };

  test("does not save or notify when date/time is missing", async () => {
    const res = await request(app)
      .post("/api/demo-requests/book")
      .send(basePayload);

    expect(res.status).toBe(400);
    expect(await DemoRequest.countDocuments()).toBe(0);
    expect(DemoNotificationService.notifyScheduled).not.toHaveBeenCalled();
  });

  test("creates one scheduled record and notifies only after a valid slot is confirmed", async () => {
    const availability = await request(app).get(
      "/api/demo-requests/availability",
    );

    expect(availability.status).toBe(200);
    expect(availability.body.data.slots.length).toBeGreaterThan(0);

    const scheduledAt = availability.body.data.slots[0].start;
    const res = await request(app)
      .post("/api/demo-requests/book")
      .send({
        ...basePayload,
        scheduledAt,
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.request.status).toBe("scheduled");
    expect(res.body.data.request.scheduledAt).toBe(scheduledAt);
    expect(typeof res.body.data.bookingToken).toBe("string");

    const records = await DemoRequest.find({});
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("scheduled");
    expect(records[0].scheduledAt.toISOString()).toBe(scheduledAt);
    expect(DemoNotificationService.notifyScheduled).toHaveBeenCalledTimes(1);
    expect(DemoNotificationService.notifyScheduled).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "owner@example.com",
        status: "scheduled",
      }),
      res.body.data.bookingToken,
    );
  });
});
