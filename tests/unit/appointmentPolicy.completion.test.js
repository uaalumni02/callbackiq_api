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

jest.mock("../../src/models/availabilityException.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));
jest.mock("../../src/models/availabilityRule.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));
jest.mock("../../src/models/schedulingPolicy.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));
jest.mock("../../src/models/serviceArea.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));
jest.mock("../../src/models/serviceOffering.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));

const lean = (value) => ({ lean: jest.fn().mockResolvedValue(value) });

describe("appointment policy completion gates", () => {
  beforeEach(() => jest.clearAllMocks());

  test("enforces same-day booking in the business timezone", () => {
    expect(() =>
      validateBookingWindow({
        startAt: "2026-07-27T20:00:00.000Z",
        now: new Date("2026-07-27T12:00:00.000Z"),
        timeZone: "America/New_York",
        policy: {
          allowSameDayBooking: false,
          minimumNoticeMinutes: 0,
          maximumAdvanceDays: 60,
        },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "SAME_DAY_BOOKING_DISABLED",
        statusCode: 409,
      }),
    );
  });

  test("allows same-day booking when enabled", () => {
    expect(
      validateBookingWindow({
        startAt: "2026-07-27T20:00:00.000Z",
        now: new Date("2026-07-27T12:00:00.000Z"),
        timeZone: "America/New_York",
        policy: {
          allowSameDayBooking: true,
          minimumNoticeMinutes: 0,
          maximumAdvanceDays: 60,
        },
      }),
    ).toBeUndefined();
  });

  test("validates a configured radius", async () => {
    ServiceArea.findOne.mockReturnValue(
      lean({
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
    ).resolves.toEqual({
      supported: true,
      reason: "matched_radius",
      mode: "radius",
      distanceMiles: 12.35,
      radiusMiles: 25,
      centerPostalCode: "30318",
    });
  });

  test("rejects a ZIP outside the configured radius", async () => {
    ServiceArea.findOne.mockReturnValue(
      lean({
        type: "radius",
        centerPostalCode: "30318",
        radiusMiles: 10,
      }),
    );

    await expect(
      validateServiceArea({
        businessId: "b1",
        postalCode: "30060",
        distanceResolver: jest.fn().mockResolvedValue(18.5),
      }),
    ).resolves.toMatchObject({
      supported: false,
      reason: "outside_configured_service_area",
      mode: "radius",
    });
  });

  test("fails closed for incomplete radius configuration", async () => {
    ServiceArea.findOne.mockReturnValue(
      lean({ type: "radius", centerPostalCode: "", radiusMiles: 25 }),
    );

    await expect(
      validateServiceArea({ businessId: "b1", postalCode: "30318" }),
    ).rejects.toMatchObject({
      code: "SERVICE_AREA_CONFIGURATION_INCOMPLETE",
      statusCode: 409,
    });
  });

  test("retains ZIP-list behavior", async () => {
    ServiceArea.findOne.mockReturnValue(
      lean({ type: "zip_codes", zipCodes: ["30318", "30309-1000"] }),
    );

    await expect(
      validateServiceArea({ businessId: "b1", postalCode: "30309" }),
    ).resolves.toMatchObject({ supported: true, mode: "zip_codes" });
    await expect(
      validateServiceArea({ businessId: "b1", postalCode: "99999" }),
    ).resolves.toMatchObject({ supported: false, mode: "zip_codes" });
  });

  test("retains existing policy, service, and capacity behavior", async () => {
    SchedulingPolicy.findOne.mockReturnValue(lean(null));
    await expect(getSchedulingPolicy("b1")).resolves.toMatchObject({
      allowSameDayBooking: false,
      minimumNoticeMinutes: 120,
    });

    ServiceOffering.findOne.mockReturnValue(
      lean({ _id: "s1", active: true, aiCanBook: true }),
    );
    await expect(
      getBookableService({ businessId: "b1", serviceOfferingId: "s1" }),
    ).resolves.toMatchObject({ _id: "s1" });

    AvailabilityRule.findOne.mockReturnValue(lean({ capacity: 2 }));
    AvailabilityException.findOne.mockReturnValue(lean({ capacity: 3 }));
    await expect(
      getSlotCapacity({
        businessId: "b1",
        startAt: new Date("2026-07-28T13:00:00Z"),
        timeZone: "America/New_York",
      }),
    ).resolves.toBe(3);
  });
});
