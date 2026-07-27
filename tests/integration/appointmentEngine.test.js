import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import Appointment from "../../src/models/appointment.js";

const appointmentInput = ({
  business,
  serviceOffering,
  idempotencyKey,
  startAt = "2026-07-27T17:00:00.000Z",
  endAt = "2026-07-27T18:30:00.000Z",
  lane = 1,
  claims = ["2026-07-27T17:00:00.000Z|lane:1"],
  externalAppointmentId = null,
} = {}) => ({
  business,
  serviceOffering,
  customerName: "Test Customer",
  customerPhone: "+14045550199",
  startAt: new Date(startAt),
  endAt: new Date(endAt),
  timezone: "America/New_York",
  status: "held",
  source: "web",
  bookedBy: "customer",
  provider: externalAppointmentId ? "google_calendar" : "internal",
  externalAppointmentId,
  idempotencyKey,
  capacityLane: lane,
  activeSlotKey: `${startAt}|${endAt}|lane:${lane}`,
  slotClaimKeys: claims,
  heldExpiresAt: new Date(Date.now() + 5 * 60_000),
});

describe("Appointment atomic ownership indexes", () => {
  let mongo;
  let business;
  let serviceOffering;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Appointment.syncIndexes();
    business = new mongoose.Types.ObjectId();
    serviceOffering = new mongoose.Types.ObjectId();
  });

  afterEach(async () => {
    await Appointment.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  test("rejects duplicate idempotency keys for the same business", async () => {
    const first = appointmentInput({
      business,
      serviceOffering,
      idempotencyKey: "same-request",
    });
    await Appointment.create(first);

    await expect(
      Appointment.create({
        ...first,
        _id: undefined,
        activeSlotKey: "different-exact-slot",
        slotClaimKeys: ["2026-07-27T19:00:00.000Z|lane:1"],
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  test("rejects overlapping minute claims even when exact start/end differ", async () => {
    await Appointment.create(
      appointmentInput({
        business,
        serviceOffering,
        idempotencyKey: "customer-a",
        claims: [
          "2026-07-27T17:00:00.000Z|lane:1",
          "2026-07-27T17:01:00.000Z|lane:1",
        ],
      }),
    );

    await expect(
      Appointment.create(
        appointmentInput({
          business,
          serviceOffering,
          idempotencyKey: "customer-b",
          startAt: "2026-07-27T17:01:00.000Z",
          endAt: "2026-07-27T18:31:00.000Z",
          claims: [
            "2026-07-27T17:01:00.000Z|lane:1",
            "2026-07-27T17:02:00.000Z|lane:1",
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 11000 });
  });

  test("allows a configured second capacity lane", async () => {
    await Appointment.create(
      appointmentInput({
        business,
        serviceOffering,
        idempotencyKey: "lane-one",
      }),
    );

    const second = await Appointment.create(
      appointmentInput({
        business,
        serviceOffering,
        idempotencyKey: "lane-two",
        lane: 2,
        claims: ["2026-07-27T17:00:00.000Z|lane:2"],
      }),
    );

    expect(second.capacityLane).toBe(2);
  });

  test("rejects duplicate external appointment identifiers", async () => {
    await Appointment.create(
      appointmentInput({
        business,
        serviceOffering,
        idempotencyKey: "external-one",
        externalAppointmentId: "google-event-123",
      }),
    );

    await expect(
      Appointment.create(
        appointmentInput({
          business: new mongoose.Types.ObjectId(),
          serviceOffering,
          idempotencyKey: "external-two",
          startAt: "2026-07-28T17:00:00.000Z",
          endAt: "2026-07-28T18:30:00.000Z",
          claims: ["2026-07-28T17:00:00.000Z|lane:1"],
          externalAppointmentId: "google-event-123",
        }),
      ),
    ).rejects.toMatchObject({ code: 11000 });
  });
});
