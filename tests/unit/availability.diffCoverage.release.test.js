
import ServiceOffering from "../../src/models/serviceOffering.js";
import AvailabilityService from "../../src/services/scheduling/availability.service.js";
import {
  getSchedulingPolicy,
  validateServiceArea,
} from "../../src/services/scheduling/appointmentPolicy.service.js";
import SchedulingProviderFactory from "../../src/services/scheduling/schedulingProviderFactory.js";

jest.mock("../../src/models/serviceOffering.js", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
  },
}));

jest.mock(
  "../../src/services/scheduling/appointmentPolicy.service.js",
  () => ({
    __esModule: true,
    getSchedulingPolicy: jest.fn(),
    validateServiceArea: jest.fn(),
  }),
);

jest.mock(
  "../../src/services/scheduling/calendarProviderName.service.js",
  () => ({
    __esModule: true,
    businessCalendarProviderName: jest.fn(
      () => "internal",
    ),
    normalizeCalendarProviderName: jest.fn(
      (value) => value || "internal",
    ),
  }),
);

jest.mock(
  "../../src/services/scheduling/schedulingProviderFactory.js",
  () => ({
    __esModule: true,
    default: {
      getProvider: jest.fn(),
    },
  }),
);

describe(
  "availability changed-code release coverage",
  () => {
    let provider;

    beforeEach(() => {
      jest.clearAllMocks();
      jest.useFakeTimers();
      jest.setSystemTime(
        new Date("2026-09-05T14:00:00.000Z"),
      );

      provider = {
        getAvailability: jest.fn(),
      };

      SchedulingProviderFactory.getProvider
        .mockReturnValue(provider);

      validateServiceArea.mockResolvedValue({
        supported: true,
      });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test(
      "uses safe policy defaults when service and policy overrides are absent",
      async () => {
        ServiceOffering.findOne.mockReturnValue({
          lean: jest.fn().mockResolvedValue(
            null,
          ),
        });

        getSchedulingPolicy.mockResolvedValue(
          {},
        );

        provider.getAvailability.mockResolvedValue(
          {
            unexpected: true,
          },
        );

        const result =
          await AvailabilityService.getAvailability(
            {
              business: {
                _id: "business-1",
                timezone: "America/New_York",
              },
              serviceOfferingId: "service-1",
              startDate: "2026-09-05",
              endDate: "2026-09-10",
              postalCode: "30303",
            },
          );

        expect(
          result.minimumNoticeMinutes,
        ).toBe(1440);

        expect(
          result.allowSameDayBooking,
        ).toBe(false);

        expect(result.slots).toEqual([]);

        expect(
          provider.getAvailability,
        ).toHaveBeenCalledWith(
          expect.not.objectContaining({
            excludeExternalEventId:
              expect.anything(),
          }),
        );
      },
    );

    test(
      "rejects invalid notice overrides and removes disallowed same-day slots",
      async () => {
        ServiceOffering.findOne.mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            minimumNoticeMinutesOverride:
              -5,
            allowSameDayBookingOverride:
              false,
          }),
        });

        getSchedulingPolicy.mockResolvedValue({
          minimumNoticeMinutes: 0,
          allowSameDayBooking: true,
        });

        provider.getAvailability.mockResolvedValue([
          {
            startAt:
              "2026-09-05T18:00:00.000Z",
            endAt:
              "2026-09-05T19:00:00.000Z",
          },
          {
            startAt:
              "2026-09-06T18:00:00.000Z",
            endAt:
              "2026-09-06T19:00:00.000Z",
          },
        ]);

        const result =
          await AvailabilityService.getAvailability(
            {
              business: {
                _id: "business-1",
                timezone: "America/New_York",
              },
              serviceOfferingId: "service-1",
              startDate: "2026-09-05",
              endDate: "2026-09-10",
              postalCode: "30303",
              excludeExternalEventId:
                "external-1",
            },
          );

        expect(
          result.minimumNoticeMinutes,
        ).toBe(0);

        expect(
          result.allowSameDayBooking,
        ).toBe(false);

        expect(result.slots).toHaveLength(
          1,
        );

        expect(
          provider.getAvailability,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            excludeExternalEventId:
              "external-1",
          }),
        );
      },
    );
  },
);
