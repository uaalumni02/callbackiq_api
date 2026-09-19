
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


describe('availability service-area safety', () => {
  const request = { business: { _id: 'b1', timezone: 'America/New_York' }, serviceOfferingId: 's1', postalCode: '30318', startDate: '2026-09-20', endDate: '2026-09-21' };
  beforeEach(() => {
    jest.clearAllMocks();
    ServiceOffering.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    getSchedulingPolicy.mockResolvedValue({});
  });
  test.each([null, undefined])('unknown coverage (%s) requires review before contacting a provider', async supported => {
    const serviceArea = { supported, reason: 'distance_unavailable' };
    validateServiceArea.mockResolvedValue(serviceArea);
    await expect(AvailabilityService.getAvailability(request)).rejects.toMatchObject({
      code: 'SERVICE_AREA_REVIEW_REQUIRED', statusCode: 409, serviceArea,
    });
    expect(SchedulingProviderFactory.getProvider).not.toHaveBeenCalled();
  });
  test('out-of-area address returns no slots without contacting a provider', async () => {
    validateServiceArea.mockResolvedValue({ supported: false, reason: 'outside_radius' });
    await expect(AvailabilityService.getAvailability(request)).resolves.toMatchObject({
      supportedServiceArea: false, reason: 'outside_radius', slots: [],
    });
    expect(SchedulingProviderFactory.getProvider).not.toHaveBeenCalled();
  });
  test('verified coverage reaches the provider with the requested service and location', async () => {
    validateServiceArea.mockResolvedValue({ supported: true });
    const getAvailability = jest.fn().mockResolvedValue([]);
    SchedulingProviderFactory.getProvider.mockReturnValue({ getAvailability });
    await expect(AvailabilityService.getAvailability(request)).resolves.toMatchObject({ supportedServiceArea: true, slots: [] });
    expect(getAvailability).toHaveBeenCalledWith(expect.objectContaining({ serviceOfferingId: 's1', postalCode: '30318' }));
  });
});
