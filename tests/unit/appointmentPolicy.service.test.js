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
      minimumNoticeMinutes: 1440,
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

  test("requires a ZIP for configured coverage", async () => {
    ServiceArea.findOne.mockReturnValue(leanResult({ type: "zip_codes", zipCodes: ["30318"] }));
    await expect(validateServiceArea({ businessId: "b1", postalCode: "" })).resolves.toMatchObject({
      supported: null,
      reason: "zip_code_required",
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
    [{ type: "zip_codes", zipCodes: [] }],
  ])("does not assume coverage when configuration is missing", async (area) => {
    ServiceArea.findOne.mockReturnValue(leanResult(area));
    await expect(
      validateServiceArea({ businessId: "b1", postalCode: "30318" }),
    ).resolves.toMatchObject({
      supported: null,
      reason: "service_area_not_configured",
    });
  });

  test("fails closed when a radius service area is incomplete", async () => {
    ServiceArea.findOne.mockReturnValue(
      leanResult({
        type: "radius",
        centerPostalCode: "",
        radiusMiles: null,
      }),
    );

    await expect(
      validateServiceArea({ businessId: "b1", postalCode: "30318" }),
    ).resolves.toMatchObject({
      supported: null,
      reason: "service_area_configuration_incomplete",
    });
  });

  test("validates configured radius service areas", async () => {
    ServiceArea.findOne.mockReturnValue(
      leanResult({
        type: "radius",
        centerPostalCode: "30318",
        radiusMiles: 25,
      }),
    );
    const distanceResolver = jest.fn().mockResolvedValue(12.345);

    await expect(
      validateServiceArea({
        businessId: "b1",
        postalCode: "30309",
        distanceResolver,
      }),
    ).resolves.toMatchObject({
      supported: true,
      reason: "matched_radius",
      mode: "radius",
      distanceMiles: 12.35,
      radiusMiles: 25,
      centerPostalCode: "30318",
    });
  });

  test("matches five-digit and ZIP+4 service areas", async () => {
    ServiceArea.findOne.mockReturnValue(
      leanResult({ type: "zip_codes", zipCodes: ["30318", "30309-1234"] }),
    );
    await expect(
      validateServiceArea({ businessId: "b1", postalCode: "30318-9999" }),
    ).resolves.toMatchObject({
      supported: true,
      reason: "matched",
      mode: "zip_codes",
    });
    await expect(
      validateServiceArea({ businessId: "b1", postalCode: "99999" }),
    ).resolves.toMatchObject({
      supported: false,
      reason: "outside_configured_service_area",
      mode: "zip_codes",
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
