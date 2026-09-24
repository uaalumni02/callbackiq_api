import Appointment from "../../src/models/appointment.js";
import AvailabilityException from "../../src/models/availabilityException.js";
import AvailabilityRule from "../../src/models/availabilityRule.js";
import { generateInternalSlots } from "../../src/services/scheduling/slotGenerator.service.js";
import {
  addMinutes,
  enumerateDateKeys,
  getUtcDayOfWeekForDateKey,
  minutesFromTimeKey,
  timeKeyFromMinutes,
  zonedDateTimeToUtc,
} from "../../src/services/scheduling/timezone.service.js";
import {
  getBookableService,
  getSchedulingPolicy,
  validateBookingWindow,
} from "../../src/services/scheduling/appointmentPolicy.service.js";

jest.mock("../../src/models/appointment.js", () => ({ __esModule: true, default: { find: jest.fn() } }));
jest.mock("../../src/models/availabilityException.js", () => ({ __esModule: true, default: { find: jest.fn() } }));
jest.mock("../../src/models/availabilityRule.js", () => ({ __esModule: true, default: { find: jest.fn() } }));
jest.mock("../../src/services/scheduling/timezone.service.js", () => ({
  __esModule: true,
  addMinutes: jest.fn((date, minutes) => new Date(new Date(date).getTime() + minutes * 60_000)),
  enumerateDateKeys: jest.fn(),
  getUtcDayOfWeekForDateKey: jest.fn(),
  minutesFromTimeKey: jest.fn((value) => {
    const [hour, minute] = value.split(":").map(Number);
    return hour * 60 + minute;
  }),
  timeKeyFromMinutes: jest.fn((minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`),
  zonedDateTimeToUtc: jest.fn(({ dateKey, timeKey }) => new Date(`${dateKey}T${timeKey}:00.000Z`)),
}));
jest.mock("../../src/services/scheduling/appointmentPolicy.service.js", () => ({
  __esModule: true,
  getBookableService: jest.fn(),
  getSchedulingPolicy: jest.fn(),
  validateBookingWindow: jest.fn(),
}));

const leanResult = (value) => ({ lean: jest.fn().mockResolvedValue(value) });

describe("generateInternalSlots", () => {
  const business = { _id: "b1", timezone: "UTC" };
  const service = {
    _id: "s1",
    durationMinutes: 60,
    bufferBeforeMinutes: 15,
    bufferAfterMinutes: 10,
    emergencyEligible: false,
  };
  const policy = { slotIntervalMinutes: 30, defaultDurationMinutes: 90 };

  beforeEach(() => {
    jest.clearAllMocks();
    getBookableService.mockResolvedValue(service);
    getSchedulingPolicy.mockResolvedValue(policy);
    enumerateDateKeys.mockReturnValue(["2026-07-27"]);
    getUtcDayOfWeekForDateKey.mockReturnValue(1);
    AvailabilityRule.find.mockReturnValue(
      leanResult([{ dayOfWeek: 1, enabled: true, capacity: 1, windows: [{ startTime: "09:00", endTime: "11:00" }] }]),
    );
    AvailabilityException.find.mockReturnValue(leanResult([]));
    Appointment.find.mockReturnValue(leanResult([]));
    validateBookingWindow.mockReturnValue(undefined);
  });

  test("loads rules, policies, exceptions, and appointments with overlap boundaries", async () => {
    const now = new Date("2026-07-27T00:00:00Z");
    const slots = await generateInternalSlots({
      business,
      serviceOfferingId: "s1",
      startDate: "2026-07-27",
      endDate: "2026-07-27",
      excludeAppointmentId: "a-old",
      now,
    });
    expect(getBookableService).toHaveBeenCalledWith({ businessId: "b1", serviceOfferingId: "s1" });
    expect(getSchedulingPolicy).toHaveBeenCalledWith("b1");
    expect(Appointment.find).toHaveBeenCalledWith({
      business: "b1",
      status: { $in: ["held", "confirmed"] },
      startAt: { $lt: new Date("2026-07-29T00:00:00.000Z") },
      endAt: { $gt: new Date("2026-07-26T00:00:00.000Z") },
      $or: [
        { status: "confirmed" },
        { status: "held", heldExpiresAt: { $gt: now } },
      ],
      _id: { $ne: "a-old" },
    });
    expect(slots).toHaveLength(3);
    expect(slots[0]).toEqual({
      startAt: new Date("2026-07-27T09:00:00.000Z"),
      endAt: new Date("2026-07-27T10:00:00.000Z"),
      timezone: "UTC",
      bufferBeforeMinutes: 15,
      bufferAfterMinutes: 10,
      serviceOfferingId: "s1",
    });
  });

  test("supports business.id and default timezone/durations/intervals", async () => {
    getBookableService.mockResolvedValue({ _id: 123, durationMinutes: 0 });
    getSchedulingPolicy.mockResolvedValue({ defaultDurationMinutes: 30, slotIntervalMinutes: 0 });
    AvailabilityRule.find.mockReturnValue(
      leanResult([{ dayOfWeek: 1, enabled: true, windows: [{ startTime: "09:00", endTime: "10:00" }] }]),
    );
    const result = await generateInternalSlots({
      business: { id: "b2" },
      serviceOfferingId: "s1",
      startDate: "2026-07-27",
      endDate: "2026-07-27",
    });
    expect(result[0]).toMatchObject({ timezone: "America/New_York", serviceOfferingId: "123" });
  });

  test.each(["holiday", "closure", "fully_booked", "technician_meeting"])(
    "closes the date for %s exceptions",
    async (type) => {
      AvailabilityException.find.mockReturnValue(leanResult([{ date: "2026-07-27", type }]));
      await expect(
        generateInternalSlots({ business, serviceOfferingId: "s1", startDate: "2026-07-27", endDate: "2026-07-27" }),
      ).resolves.toEqual([]);
    },
  );

  test("closes emergency-only dates for ordinary services but permits eligible services", async () => {
    AvailabilityException.find.mockReturnValue(
      leanResult([{ date: "2026-07-27", type: "emergency_only", capacity: 2 }]),
    );
    await expect(
      generateInternalSlots({ business, serviceOfferingId: "s1", startDate: "2026-07-27", endDate: "2026-07-27" }),
    ).resolves.toEqual([]);

    getBookableService.mockResolvedValue({ ...service, emergencyEligible: true });
    await expect(
      generateInternalSlots({ business, serviceOfferingId: "s1", startDate: "2026-07-27", endDate: "2026-07-27" }),
    ).resolves.toHaveLength(3);
  });

  test.each([
    [{ type: "special_hours", windows: [{ startTime: "12:00", endTime: "13:00" }] }],
    [{ type: "special_hours", allDay: false, windows: [{ startTime: "12:00", endTime: "13:00" }] }],
  ])("uses exception windows %#", async (exception) => {
    AvailabilityException.find.mockReturnValue(leanResult([{ date: "2026-07-27", ...exception }]));
    const slots = await generateInternalSlots({
      business,
      serviceOfferingId: "s1",
      startDate: "2026-07-27",
      endDate: "2026-07-27",
    });
    expect(slots[0].startAt).toEqual(new Date("2026-07-27T12:00:00.000Z"));
  });

  test("normalizes malformed windows and ignores invalid exception dates", async () => {
    AvailabilityRule.find.mockReturnValue(
      leanResult([
        {
          dayOfWeek: 1,
          enabled: true,
          windows: [null, { startTime: "", endTime: "10:00" }, { startTime: "09:00", endTime: "" }, { startTime: " 09:00 ", endTime: " 10:00 " }],
        },
      ]),
    );
    AvailabilityException.find.mockReturnValue(
      leanResult([{ date: "not-a-date", type: "holiday" }, { date: "", type: "closure" }]),
    );
    await expect(
      generateInternalSlots({ business, serviceOfferingId: "s1", startDate: "2026-07-27", endDate: "2026-07-27" }),
    ).resolves.toHaveLength(1);
  });

  test("returns no slots for disabled or malformed rule windows", async () => {
    AvailabilityRule.find.mockReturnValue(leanResult([{ dayOfWeek: 1, enabled: false, windows: [] }]));
    await expect(
      generateInternalSlots({ business, serviceOfferingId: "s1", startDate: "2026-07-27", endDate: "2026-07-27" }),
    ).resolves.toEqual([]);

    AvailabilityRule.find.mockReturnValue(leanResult([{ dayOfWeek: 1, enabled: true, windows: "bad" }]));
    await expect(
      generateInternalSlots({ business, serviceOfferingId: "s1", startDate: "2026-07-27", endDate: "2026-07-27" }),
    ).resolves.toEqual([]);
  });

  test("skips minimum-notice and maximum-advance failures but rethrows other policy errors", async () => {
    validateBookingWindow
      .mockImplementationOnce(() => { throw Object.assign(new Error("notice"), { code: "MINIMUM_NOTICE_NOT_MET" }); })
      .mockImplementationOnce(() => { throw Object.assign(new Error("advance"), { code: "MAXIMUM_ADVANCE_EXCEEDED" }); })
      .mockReturnValueOnce(undefined);
    await expect(
      generateInternalSlots({ business, serviceOfferingId: "s1", startDate: "2026-07-27", endDate: "2026-07-27" }),
    ).resolves.toHaveLength(1);

    validateBookingWindow.mockImplementation(() => { throw Object.assign(new Error("unexpected"), { code: "OTHER" }); });
    await expect(
      generateInternalSlots({ business, serviceOfferingId: "s1", startDate: "2026-07-27", endDate: "2026-07-27" }),
    ).rejects.toThrow("unexpected");
  });

  test("applies appointment buffers and capacity", async () => {
    Appointment.find.mockReturnValue(
      leanResult([
        {
          startAt: "2026-07-27T09:45:00Z",
          endAt: "2026-07-27T10:15:00Z",
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
        },
      ]),
    );
    const slots = await generateInternalSlots({
      business,
      serviceOfferingId: "s1",
      startDate: "2026-07-27",
      endDate: "2026-07-27",
    });
    expect(slots).toEqual([]);

    AvailabilityRule.find.mockReturnValue(
      leanResult([{ dayOfWeek: 1, enabled: true, capacity: 2, windows: [{ startTime: "09:00", endTime: "11:00" }] }]),
    );
    const capacitySlots = await generateInternalSlots({
      business,
      serviceOfferingId: "s1",
      startDate: "2026-07-27",
      endDate: "2026-07-27",
    });
    expect(capacitySlots).toHaveLength(3);
  });

  test("uses exception capacity before rule capacity", async () => {
    AvailabilityRule.find.mockReturnValue(
      leanResult([{ dayOfWeek: 1, enabled: true, capacity: 1, windows: [{ startTime: "09:00", endTime: "10:00" }] }]),
    );
    AvailabilityException.find.mockReturnValue(
      leanResult([{ date: "2026-07-27", type: "special_hours", capacity: 2, windows: [{ startTime: "09:00", endTime: "10:00" }] }]),
    );
    Appointment.find.mockReturnValue(
      leanResult([{ startAt: "2026-07-27T09:00:00Z", endAt: "2026-07-27T10:00:00Z" }]),
    );
    await expect(
      generateInternalSlots({ business, serviceOfferingId: "s1", startDate: "2026-07-27", endDate: "2026-07-27" }),
    ).resolves.toHaveLength(1);
  });
});
