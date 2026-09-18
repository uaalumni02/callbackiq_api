const mockServiceSort = jest.fn();
const mockRuleFindOne = jest.fn();
const mockExceptionFind = jest.fn();
const mockPolicyFindOne = jest.fn();
const mockAreaFindOne = jest.fn();
const mockOpsFindOne = jest.fn();

jest.mock("../../src/models/serviceOffering.js", () => ({
  __esModule: true,
  default: {
    find: jest.fn(() => ({ sort: mockServiceSort })),
  },
}));
jest.mock("../../src/models/availabilityRule.js", () => ({
  __esModule: true,
  default: { findOne: (...args) => mockRuleFindOne(...args) },
}));
jest.mock("../../src/models/availabilityException.js", () => ({
  __esModule: true,
  default: { find: (...args) => mockExceptionFind(...args) },
}));
jest.mock("../../src/models/schedulingPolicy.js", () => ({
  __esModule: true,
  default: { findOne: (...args) => mockPolicyFindOne(...args) },
}));
jest.mock("../../src/models/serviceArea.js", () => ({
  __esModule: true,
  default: { findOne: (...args) => mockAreaFindOne(...args) },
}));
jest.mock("../../src/models/businessOperationsSettings.js", () => ({
  __esModule: true,
  default: { findOne: (...args) => mockOpsFindOne(...args) },
}));

const { evaluateBookingEligibility } = require("../../src/services/bookingEligibility.service.js");

const BUSINESS = {
  _id: "biz-coverage",
  timezone: "UTC",
  features: { aiBookingEnabled: true },
};

const BASE_POLICY = {
  minimumNoticeMinutes: 0,
  maximumAdvanceDays: 60,
  requireAddressBeforeBooking: false,
  requireServiceBeforeBooking: false,
  allowSameDayBooking: true,
  allowAfterHoursBooking: false,
  defaultDurationMinutes: 90,
};

const BASE_SERVICE = {
  _id: "svc-1",
  name: "Drain Cleaning",
  category: "Plumbing",
  keywords: ["clog", "drain"],
  excludedKeywords: [],
  active: true,
  aiCanBook: true,
  aiCanDiscuss: true,
  durationMinutes: 60,
  bufferBeforeMinutes: 10,
  bufferAfterMinutes: 15,
  emergencyEligible: false,
  requiresHumanReview: false,
};

const BASE_OPS = {
  aiPermissions: {
    canBookEligibleServices: true,
    requireHumanReviewForUnknownService: false,
  },
  humanHandoffContacts: [],
};

const future = (days = 1, hour = 12, minute = 0) => {
  const date = new Date("2026-08-17T00:00:00.000Z");
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(hour, minute, 0, 0);
  return date.toISOString();
};

const arrange = ({
  services = [BASE_SERVICE],
  policy = BASE_POLICY,
  area = { type: "zip_codes", zipCodes: ["30301"] },
  ops = BASE_OPS,
  exceptions = [],
  rule = {
    enabled: true,
    windows: [{ startTime: "08:00", endTime: "17:00" }],
    capacity: 2,
  },
} = {}) => {
  mockServiceSort.mockResolvedValue(services);
  mockPolicyFindOne.mockResolvedValue(policy);
  mockAreaFindOne.mockResolvedValue(area);
  mockOpsFindOne.mockResolvedValue(ops);
  mockExceptionFind.mockResolvedValue(exceptions);
  mockRuleFindOne.mockResolvedValue(rule);
};

const evaluate = (overrides = {}) =>
  evaluateBookingEligibility({
    business: BUSINESS,
    serviceQuery: "drain",
    zipCode: "30301",
    requestedStart: future(),
    customerHasAddress: true,
    ...overrides,
  });

describe("bookingEligibility target coverage", () => {
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-08-17T00:00:00.000Z"));
  });

  afterAll(() => jest.useRealTimers());

  beforeEach(() => {
    jest.clearAllMocks();
    arrange();
  });

  test("fully eligible service may be booked by AI and includes buffers/capacity", async () => {
    const result = await evaluate();
    expect(result).toMatchObject({
      servicePerformed: true,
      locationSupported: true,
      serviceAreaReason: "matched",
      serviceAiCanBook: true,
      businessAiBookingEnabled: true,
      operationsAiBookingAllowed: true,
      mayAiBook: true,
      requiresHumanReview: false,
      emergencyEscalation: false,
      durationMinutes: 60,
      totalBlockMinutes: 85,
    });
    expect(result.availability).toMatchObject({
      available: true,
      reason: "operating_window_available",
      capacity: 2,
    });
    expect(result.reasons).toEqual([]);
  });

  test("blank query does not match a service and surfaces all missing prerequisites", async () => {
    arrange({
      services: [BASE_SERVICE],
      policy: {
        ...BASE_POLICY,
        requireAddressBeforeBooking: true,
        requireServiceBeforeBooking: true,
      },
      area: null,
      ops: {
        aiPermissions: {
          canBookEligibleServices: false,
          requireHumanReviewForUnknownService: true,
        },
      },
      rule: null,
    });

    const result = await evaluate({
      business: { ...BUSINESS, features: {} },
      serviceQuery: "   ",
      zipCode: "",
      requestedStart: null,
      customerHasAddress: false,
    });

    expect(result.servicePerformed).toBe(false);
    expect(result.requiresHumanReview).toBe(true);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "service_not_matched",
        "human_review_required",
        "service_area_not_configured",
        "requested_start_required",
        "address_required",
        "service_required",
        "business_ai_booking_feature_disabled",
        "operations_ai_booking_permission_disabled",
      ]),
    );
  });

  test.each([
    [null, "", "service_area_not_configured", null],
    [{ type: "zip_codes", zipCodes: ["30301"] }, "", "zip_code_required", null],
    [{ type: "zip_codes", zipCodes: ["30301"] }, "99999", "outside_configured_service_area", false],
    [{ type: "radius", centerPostalCode: "30301", radiusMiles: 20 }, "30301", "matched_radius", true],
  ])("covers service-area state %#", async (area, zipCode, reason, supported) => {
    arrange({ area });
    const result = await evaluate({ zipCode });
    expect(result.serviceAreaReason).toBe(reason);
    expect(result.locationSupported).toBe(supported);
    expect(result.mayAiBook).toBe(supported === true);
  });

  test("excluded service keyword defeats an otherwise matching term", async () => {
    arrange({
      services: [
        {
          ...BASE_SERVICE,
          excludedKeywords: ["commercial"],
        },
      ],
    });
    const result = await evaluate({ serviceQuery: "commercial drain" });
    expect(result.servicePerformed).toBe(false);
    expect(result.reasons).toContain("service_not_matched");
  });

  test.each([
    ["Drain Cleaning", "drain"],
    ["Plumbing", "plumbing"],
    ["clog", "clog"],
  ])("matches service by %s", async (_kind, query) => {
    arrange();
    const result = await evaluate({ serviceQuery: query });
    expect(result.matchedService).toEqual(BASE_SERVICE);
  });

  test("disabled service AI booking blocks automation", async () => {
    arrange({ services: [{ ...BASE_SERVICE, aiCanBook: false }] });
    const result = await evaluate();
    expect(result.mayAiBook).toBe(false);
    expect(result.reasons).toContain("service_ai_booking_disabled");
  });

  test.each([
    [{ ...BASE_SERVICE, requiresHumanReview: true }, false],
    [{ ...BASE_SERVICE, emergencyEligible: true }, true],
  ])("human review service state %#", async (service, emergencyEscalation) => {
    arrange({ services: [service] });
    const result = await evaluate();
    expect(result.requiresHumanReview).toBe(true);
    expect(result.emergencyEscalation).toBe(emergencyEscalation);
    expect(result.mayAiBook).toBe(false);
    expect(result.reasons).toContain("human_review_required");
  });

  test("invalid requested start is rejected", async () => {
    arrange();
    const result = await evaluate({ requestedStart: "not-a-date" });
    expect(result.availability).toEqual({
      available: false,
      reason: "invalid_requested_start",
    });
  });

  test("minimum notice rejects a near-term appointment", async () => {
    arrange({ policy: { ...BASE_POLICY, minimumNoticeMinutes: 180 } });
    const result = await evaluate({ requestedStart: future(0, 1) });
    expect(result.availability.reason).toBe("minimum_notice_not_met");
  });

  test("maximum advance rejects an appointment too far out", async () => {
    arrange({ policy: { ...BASE_POLICY, maximumAdvanceDays: 2 } });
    const result = await evaluate({ requestedStart: future(10) });
    expect(result.availability.reason).toBe("maximum_advance_exceeded");
  });

  test("same-day disabled rejects otherwise valid availability", async () => {
    arrange({ policy: { ...BASE_POLICY, allowSameDayBooking: false } });
    const result = await evaluate({ requestedStart: future(0, 12) });
    expect(result.availability.reason).toBe("same_day_booking_disabled");
  });

  test.each([
    "holiday",
    "closure",
    "fully_booked",
    "technician_meeting",
    "emergency_only",
  ])("full-day %s exception blocks booking", async (type) => {
    arrange({
      exceptions: [{ type, allDay: true }],
    });
    const result = await evaluate();
    expect(result.availability).toMatchObject({
      available: false,
      reason: `availability_exception:${type}`,
    });
  });

  test.each(["fully_booked", "technician_meeting", "emergency_only"])(
    "partial %s exception blocks an overlapping time",
    async (type) => {
      arrange({
        exceptions: [
          {
            type,
            allDay: false,
            windows: [{ startTime: "11:00", endTime: "13:00" }],
          },
        ],
      });
      const result = await evaluate();
      expect(result.availability.reason).toBe(`availability_exception:${type}`);
    },
  );

  test("partial exception outside requested time does not block", async () => {
    arrange({
      exceptions: [
        {
          type: "fully_booked",
          allDay: false,
          windows: [{ startTime: "18:00", endTime: "19:00" }],
        },
      ],
    });
    const result = await evaluate();
    expect(result.availability.reason).toBe("operating_window_available");
  });

  test("special hours override normal rules and capacity", async () => {
    arrange({
      exceptions: [
        {
          type: "special_hours",
          allDay: false,
          windows: [{ startTime: "11:00", endTime: "14:00" }],
          capacity: 4,
        },
      ],
      rule: { enabled: false, windows: [], capacity: 1 },
    });
    const result = await evaluate();
    expect(result.availability).toMatchObject({
      available: true,
      reason: "operating_window_available",
      capacity: 4,
    });
  });

  test.each([
    [false, "business_closed", false],
    [true, "after_hours_booking_allowed", true],
  ])("closed business after-hours policy %#", async (allowAfterHoursBooking, reason, available) => {
    arrange({
      policy: { ...BASE_POLICY, allowAfterHoursBooking },
      rule: { enabled: false, windows: [] },
    });
    const result = await evaluate();
    expect(result.availability).toMatchObject({ available, reason });
  });

  test.each([
    [false, "outside_operating_window", false],
    [true, "after_hours_booking_allowed", true],
  ])("outside-window after-hours policy %#", async (allowAfterHoursBooking, reason, available) => {
    arrange({
      policy: { ...BASE_POLICY, allowAfterHoursBooking },
      rule: {
        enabled: true,
        windows: [{ startTime: "08:00", endTime: "09:00" }],
      },
    });
    const result = await evaluate();
    expect(result.availability).toMatchObject({ available, reason });
  });

  test("default policy is used when none exists", async () => {
    arrange({ policy: null });
    const result = await evaluate({
      requestedStart: future(2, 12),
      customerHasAddress: true,
    });
    expect(result.durationMinutes).toBe(60);
  });

  test.each([
    [{ active: true, phone: "+14045550100" }, true],
    [{ active: true, email: "dispatch@example.com" }, true],
    [{ active: false, phone: "+14045550100" }, false],
    [{ active: true }, false],
  ])("handoff detection %#", async (contact, expected) => {
    arrange({
      ops: {
        ...BASE_OPS,
        humanHandoffContacts: [contact],
      },
    });
    const result = await evaluate();
    expect(result.handoffAvailable).toBe(expected);
  });

  test("business feature and operations permission independently gate booking", async () => {
    arrange({
      ops: {
        ...BASE_OPS,
        aiPermissions: {
          ...BASE_OPS.aiPermissions,
          canBookEligibleServices: false,
        },
      },
    });
    const result = await evaluate({
      business: { ...BUSINESS, features: { aiBookingEnabled: false } },
    });
    expect(result.mayAiBook).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "business_ai_booking_feature_disabled",
        "operations_ai_booking_permission_disabled",
      ]),
    );
  });
});
