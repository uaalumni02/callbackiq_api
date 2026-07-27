import AvailabilityException from "../../src/models/availabilityException.js";
import AvailabilityRule from "../../src/models/availabilityRule.js";
import SchedulingPolicy from "../../src/models/schedulingPolicy.js";
import ServiceArea from "../../src/models/serviceArea.js";
import ServiceOffering from "../../src/models/serviceOffering.js";
import {
  getBookableService,
  getSchedulingPolicy,
  getSlotCapacity,
  validateBookingWindow,
  validateServiceArea,
} from "../../src/services/scheduling/appointmentPolicy.service.js";
import {
  formatDateKey,
  getUtcDayOfWeekForDateKey,
} from "../../src/services/scheduling/timezone.service.js";

jest.mock("../../src/models/availabilityException.js", () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock("../../src/models/availabilityRule.js", () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock("../../src/models/schedulingPolicy.js", () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock("../../src/models/serviceArea.js", () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock("../../src/models/serviceOffering.js", () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock("../../src/services/scheduling/timezone.service.js", () => ({
  __esModule: true,
  formatDateKey: jest.fn(),
  getUtcDayOfWeekForDateKey: jest.fn(),
}));

const leanResult = (value) => ({ lean: jest.fn().mockResolvedValue(value) });

describe("appointment policy service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    formatDateKey.mockReturnValue("2026-07-27");
    getUtcDayOfWeekForDateKey.mockReturnValue(1);
  });

  test("returns defaults when no policy exists", async () => {
    SchedulingPolicy.findOne.mockReturnValue(leanResult(null));
    await expect(getSchedulingPolicy("b1")).resolves.toMatchObject({
      minimumNoticeMinutes: 120,
      maximumAdvanceDays: 60,
      slotIntervalMinutes: 30,
      defaultDurationMinutes: 90,
      requireAddressBeforeBooking: true,
      requireServiceBeforeBooking: true,
      allowSameDayBooking: false,
      allowAfterHoursBooking: false,
      customerCancellationAllowed: true,
      cancellationNoticeMinutes: 1440,
    });
  });

  test("overlays persisted policy values", async () => {
    SchedulingPolicy.findOne.mockReturnValue(
      leanResult({ minimumNoticeMinutes: 30, allowSameDayBooking: true }),
    );
    await expect(getSchedulingPolicy("b1")).resolves.toMatchObject({
      minimumNoticeMinutes: 30,
      allowSameDayBooking: true,
      maximumAdvanceDays: 60,
    });
  });

  test("requires a service offering id", async () => {
    await expect(getBookableService({ businessId: "b1" })).rejects.toMatchObject({
      statusCode: 400,
      message: "serviceOfferingId is required.",
    });
  });

  test("returns an active bookable service", async () => {
    const service = { _id: "s1", aiCanBook: true };
    ServiceOffering.findOne.mockReturnValue(leanResult(service));
    await expect(
      getBookableService({ businessId: "b1", serviceOfferingId: "s1" }),
    ).resolves.toBe(service);
    expect(ServiceOffering.findOne).toHaveBeenCalledWith({
      _id: "s1",
      business: "b1",
      active: true,
    });
  });

  test("rejects missing and non-bookable services", async () => {
    ServiceOffering.findOne.mockReturnValueOnce(leanResult(null));
    await expect(
      getBookableService({ businessId: "b1", serviceOfferingId: "missing" }),
    ).rejects.toMatchObject({ statusCode: 404 });

    ServiceOffering.findOne.mockReturnValueOnce(
      leanResult({ aiCanBook: false, aiCanDiscuss: false }),
    );
    await expect(
      getBookableService({ businessId: "b1", serviceOfferingId: "blocked" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "SERVICE_NOT_BOOKABLE" });
  });

  test("allows an omitted service-area ZIP", async () => {
    await expect(validateServiceArea({ businessId: "b1", postalCode: "" })).resolves.toEqual({
      supported: true,
      reason: "not_provided",
    });
  });

  test.each(["1234", "ABCDE", "123456", "12345-123"])(
    "rejects invalid ZIP %s",
    async (postalCode) => {
      await expect(validateServiceArea({ businessId: "b1", postalCode })).rejects.toMatchObject({
        statusCode: 400,
      });
    },
  );

  test.each([
    [null],
    [{ type: "radius", zipCodes: [] }],
    [{ type: "zip_codes", zipCodes: [] }],
  ])("allows the ZIP when no ZIP restriction exists", async (area) => {
    ServiceArea.findOne.mockReturnValue(leanResult(area));
    await expect(validateServiceArea({ businessId: "b1", postalCode: "30318" })).resolves.toEqual({
      supported: true,
      reason: "no_restriction_configured",
    });
  });

  test("matches five-digit and ZIP+4 service areas", async () => {
    ServiceArea.findOne.mockReturnValue(
      leanResult({ type: "zip_codes", zipCodes: ["30318", "30309-1234"] }),
    );
    await expect(validateServiceArea({ businessId: "b1", postalCode: "30318-9999" })).resolves.toEqual({
      supported: true,
      reason: "matched",
    });
    await expect(validateServiceArea({ businessId: "b1", postalCode: "99999" })).resolves.toEqual({
      supported: false,
      reason: "outside_configured_service_area",
    });
  });

  test("validates date, minimum notice, maximum advance, and accepted windows", () => {
    const now = new Date("2026-07-27T12:00:00.000Z");
    const policy = { minimumNoticeMinutes: 120, maximumAdvanceDays: 60 };
    expect(() => validateBookingWindow({ startAt: "bad", policy, now })).toThrow("valid date");

    try {
      validateBookingWindow({ startAt: "2026-07-27T13:00:00.000Z", policy, now });
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 409, code: "MINIMUM_NOTICE_NOT_MET" });
    }

    try {
      validateBookingWindow({ startAt: "2026-10-01T12:00:00.000Z", policy, now });
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 409, code: "MAXIMUM_ADVANCE_EXCEEDED" });
    }

    expect(
      validateBookingWindow({ startAt: "2026-07-28T12:00:00.000Z", policy, now }),
    ).toBeUndefined();
  });

  test("uses safe defaults for missing policy window values", () => {
    const now = new Date("2026-07-27T12:00:00.000Z");
    expect(
      validateBookingWindow({ startAt: "2026-07-28T12:00:00.000Z", policy: {}, now }),
    ).toBeUndefined();
  });

  test("uses exception capacity before rule capacity and clamps the result", async () => {
    AvailabilityRule.findOne.mockReturnValueOnce(leanResult({ capacity: 3 }));
    AvailabilityException.findOne.mockReturnValueOnce(leanResult({ capacity: 7 }));
    await expect(getSlotCapacity({ businessId: "b1", startAt: new Date(), timeZone: "UTC" })).resolves.toBe(7);

    AvailabilityRule.findOne.mockReturnValueOnce(leanResult({ capacity: 200 }));
    AvailabilityException.findOne.mockReturnValueOnce(leanResult(null));
    await expect(getSlotCapacity({ businessId: "b1", startAt: new Date() })).resolves.toBe(100);

    AvailabilityRule.findOne.mockReturnValueOnce(leanResult({ capacity: 0 }));
    AvailabilityException.findOne.mockReturnValueOnce(leanResult(null));
    await expect(getSlotCapacity({ businessId: "b1", startAt: new Date() })).resolves.toBe(1);
  });
});
