import DemoSchedulingService from "../../src/services/demoScheduling.service.js";

const makeQuery = (result) => ({
  select: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(result),
});

describe("DemoSchedulingService", () => {
  const config = {
    timeZone: "UTC",
    durationMinutes: 15,
    startHour: 9,
    endHour: 10,
    leadMinutes: 0,
    horizonDays: 0,
    bookingDays: [1, 2, 3, 4, 5],
    meetingUrl: "https://meet.example.com/callbackiq",
  };

  test("creates and validates opaque booking tokens", () => {
    const token = DemoSchedulingService.createBookingToken();
    const record = {
      bookingTokenHash: DemoSchedulingService.hashBookingToken(token),
    };

    expect(token.length).toBeGreaterThan(20);
    expect(DemoSchedulingService.isBookingTokenValid(record, token)).toBe(true);
    expect(
      DemoSchedulingService.isBookingTokenValid(record, `${token}wrong`),
    ).toBe(false);
  });

  test("returns business-hour slots and removes existing bookings", async () => {
    const booked = [
      {
        scheduledAt: new Date("2026-08-10T09:15:00.000Z"),
        scheduledEndAt: new Date("2026-08-10T09:30:00.000Z"),
      },
    ];
    const DemoRequest = {
      find: jest.fn(() => makeQuery(booked)),
    };

    const result = await DemoSchedulingService.getDemoAvailability(
      DemoRequest,
      {
        now: new Date("2026-08-10T08:00:00.000Z"),
        config,
      },
    );

    expect(result.timezone).toBe("UTC");
    expect(result.durationMinutes).toBe(15);
    expect(result.slots.map((slot) => slot.start)).toEqual([
      "2026-08-10T09:00:00.000Z",
      "2026-08-10T09:30:00.000Z",
      "2026-08-10T09:45:00.000Z",
    ]);
  });

  test("rejects arbitrary times outside the published slot grid", async () => {
    const DemoRequest = {
      findOne: jest.fn(),
    };

    await expect(
      DemoSchedulingService.assertDemoSlotAvailable(
        DemoRequest,
        "2026-08-10T09:07:00.000Z",
        {
          now: new Date("2026-08-10T08:00:00.000Z"),
          config,
        },
      ),
    ).rejects.toMatchObject({
      code: "DEMO_SLOT_INVALID",
    });

    expect(DemoRequest.findOne).not.toHaveBeenCalled();
  });

  test("rejects a slot that overlaps an active scheduled demo", async () => {
    const DemoRequest = {
      findOne: jest.fn(() =>
        makeQuery({
          _id: "existing",
          scheduledAt: new Date("2026-08-10T09:30:00.000Z"),
          scheduledEndAt: new Date("2026-08-10T09:45:00.000Z"),
        }),
      ),
    };

    await expect(
      DemoSchedulingService.assertDemoSlotAvailable(
        DemoRequest,
        "2026-08-10T09:30:00.000Z",
        {
          now: new Date("2026-08-10T08:00:00.000Z"),
          config,
        },
      ),
    ).rejects.toMatchObject({
      code: "DEMO_SLOT_TAKEN",
    });
  });

  test("builds a scheduled record with duration, slot key, and meeting URL", () => {
    const update = DemoSchedulingService.buildDemoScheduleUpdate(
      "2026-08-10T09:45:00.000Z",
      { config },
    );

    expect(update.status).toBe("scheduled");
    expect(update.scheduledAt.toISOString()).toBe(
      "2026-08-10T09:45:00.000Z",
    );
    expect(update.scheduledEndAt.toISOString()).toBe(
      "2026-08-10T10:00:00.000Z",
    );
    expect(update.slotKey).toBe("2026-08-10T09:45:00.000Z");
    expect(update.meetingUrl).toBe("https://meet.example.com/callbackiq");
  });
});
