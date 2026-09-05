import AvailabilityService from "../../src/services/scheduling/availability.service.js";
import SchedulingProviderFactory from "../../src/services/scheduling/schedulingProviderFactory.js";
import ServiceOffering from "../../src/models/serviceOffering.js";
import {
  getSchedulingPolicy,
  validateServiceArea,
} from "../../src/services/scheduling/appointmentPolicy.service.js";

jest.mock("../../src/services/scheduling/schedulingProviderFactory.js", () => ({
  __esModule: true,
  default: { getProvider: jest.fn() },
}));

jest.mock("../../src/models/serviceOffering.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));

jest.mock("../../src/services/scheduling/appointmentPolicy.service.js", () => ({
  __esModule: true,
  validateServiceArea: jest.fn(),
  getSchedulingPolicy: jest.fn(),
}));

const leanResult = (value) => ({ lean: jest.fn().mockResolvedValue(value) });

describe("customer-facing scheduling lead-time policy", () => {
  const business = {
    _id: "business-1",
    timezone: "America/New_York",
    calendarProvider: "internal",
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-09-05T16:00:00.000Z"));
    jest.clearAllMocks();

    validateServiceArea.mockResolvedValue({ supported: true, reason: "matched" });
    getSchedulingPolicy.mockResolvedValue({
      minimumNoticeMinutes: 1440,
      allowSameDayBooking: false,
      maximumAdvanceDays: 60,
    });
    ServiceOffering.findOne.mockReturnValue(
      leanResult({
        _id: "service-1",
        minimumNoticeMinutesOverride: null,
        allowSameDayBookingOverride: null,
      }),
    );

    SchedulingProviderFactory.getProvider.mockReturnValue({
      getAvailability: jest.fn().mockResolvedValue([
        {
          startAt: new Date("2026-09-05T18:00:00.000Z"),
          endAt: new Date("2026-09-05T19:30:00.000Z"),
        },
        {
          startAt: new Date("2026-09-06T15:00:00.000Z"),
          endAt: new Date("2026-09-06T16:30:00.000Z"),
        },
        {
          startAt: new Date("2026-09-06T17:00:00.000Z"),
          endAt: new Date("2026-09-06T18:30:00.000Z"),
        },
        {
          startAt: new Date("2026-09-07T16:00:00.000Z"),
          endAt: new Date("2026-09-07T17:30:00.000Z"),
        },
      ]),
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("does not expose slots inside the default 24-hour notice window", async () => {
    const result = await AvailabilityService.getAvailability({
      business,
      serviceOfferingId: "service-1",
      startDate: "2026-09-05",
      endDate: "2026-09-08",
      postalCode: "30303",
    });

    expect(result.minimumNoticeMinutes).toBe(1440);
    expect(result.slots).toHaveLength(2);
    expect(new Date(result.slots[0].startAt).getTime()).toBeGreaterThanOrEqual(
      new Date("2026-09-06T16:00:00.000Z").getTime(),
    );
  });

  test("allows an explicit service-level same-day override for true dispatch businesses", async () => {
    getSchedulingPolicy.mockResolvedValue({
      minimumNoticeMinutes: 1440,
      allowSameDayBooking: false,
      maximumAdvanceDays: 60,
    });
    ServiceOffering.findOne.mockReturnValue(
      leanResult({
        _id: "service-1",
        minimumNoticeMinutesOverride: 60,
        allowSameDayBookingOverride: true,
      }),
    );

    const result = await AvailabilityService.getAvailability({
      business,
      serviceOfferingId: "service-1",
      startDate: "2026-09-05",
      endDate: "2026-09-08",
      postalCode: "30303",
    });

    expect(result.minimumNoticeMinutes).toBe(60);
    expect(result.allowSameDayBooking).toBe(true);
    expect(result.slots.length).toBeGreaterThan(2);
  });
});
