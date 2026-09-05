import ServiceOffering from "../../src/models/serviceOffering.js";
import AvailabilityService from "../../src/services/scheduling/availability.service.js";
import SchedulingProviderFactory from "../../src/services/scheduling/schedulingProviderFactory.js";
import {
  getSchedulingPolicy,
  validateServiceArea,
} from "../../src/services/scheduling/appointmentPolicy.service.js";
import { formatZonedIso } from "../../src/services/scheduling/timezone.service.js";

jest.mock("../../src/models/serviceOffering.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));

jest.mock("../../src/services/scheduling/schedulingProviderFactory.js", () => ({
  __esModule: true,
  default: { getProvider: jest.fn() },
}));

jest.mock("../../src/services/scheduling/appointmentPolicy.service.js", () => ({
  __esModule: true,
  validateServiceArea: jest.fn(),
  getSchedulingPolicy: jest.fn(),
}));

jest.mock("../../src/services/scheduling/timezone.service.js", () => ({
  __esModule: true,
  formatDateKey: jest.fn((value) => new Date(value).toISOString().slice(0, 10)),
  formatZonedIso: jest.fn(
    (value) => `formatted:${new Date(value).toISOString()}`,
  ),
}));

const leanResult = (value) => ({
  lean: jest.fn().mockResolvedValue(value),
});

describe("AvailabilityService", () => {
  const base = {
    business: {
      _id: "b1",
      timezone: "America/New_York",
      features: { calendarProvider: "internal" },
    },
    serviceOfferingId: "s1",
    startDate: "2026-07-27",
    endDate: "2026-07-28",
    postalCode: "30318",
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-07-27T12:00:00.000Z"));
    jest.clearAllMocks();

    getSchedulingPolicy.mockResolvedValue({
      minimumNoticeMinutes: 0,
      allowSameDayBooking: true,
      maximumAdvanceDays: 60,
    });

    ServiceOffering.findOne.mockReturnValue(
      leanResult({
        _id: "s1",
        minimumNoticeMinutesOverride: 0,
        allowSameDayBookingOverride: true,
      }),
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("returns no slots outside the service area without calling a provider", async () => {
    validateServiceArea.mockResolvedValue({
      supported: false,
      reason: "outside",
    });

    await expect(
      AvailabilityService.getAvailability(base),
    ).resolves.toEqual({
      supportedServiceArea: false,
      reason: "outside",
      provider: "internal",
      slots: [],
    });

    expect(SchedulingProviderFactory.getProvider).not.toHaveBeenCalled();
  });

  test("supports legacy provider settings and default provider names", async () => {
    validateServiceArea.mockResolvedValue({
      supported: false,
      reason: "outside",
    });

    await expect(
      AvailabilityService.getAvailability({
        ...base,
        business: {
          _id: "b1",
          featureSettings: { calendarProvider: "jobber" },
        },
      }),
    ).resolves.toMatchObject({
      provider: "jobber",
    });

    await expect(
      AvailabilityService.getAvailability({
        ...base,
        business: { id: "b1" },
      }),
    ).resolves.toMatchObject({
      provider: "internal",
    });
  });

  test("delegates to the provider and formats slots in the business timezone", async () => {
    validateServiceArea.mockResolvedValue({
      supported: true,
    });

    const provider = {
      getAvailability: jest.fn().mockResolvedValue([
        {
          startAt: "2026-07-27T17:00:00.000Z",
          endAt: "2026-07-27T18:30:00.000Z",
          metadata: "keep",
        },
      ]),
    };

    SchedulingProviderFactory.getProvider.mockReturnValue(provider);

    const result = await AvailabilityService.getAvailability({
      ...base,
      excludeAppointmentId: "a1",
    });

    expect(provider.getAvailability).toHaveBeenCalledWith({
      serviceOfferingId: "s1",
      startDate: "2026-07-27",
      endDate: "2026-07-28",
      postalCode: "30318",
      excludeAppointmentId: "a1",
    });

    expect(formatZonedIso).toHaveBeenCalledTimes(2);

    expect(result.slots[0]).toEqual({
      startAt: "formatted:2026-07-27T17:00:00.000Z",
      endAt: "formatted:2026-07-27T18:30:00.000Z",
      metadata: "keep",
    });
  });
});
