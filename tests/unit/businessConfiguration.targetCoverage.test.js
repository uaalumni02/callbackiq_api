const mockPolicyFindOneAndUpdate = jest.fn();
const mockAreaFindOneAndUpdate = jest.fn();
const mockOpsFindOneAndUpdate = jest.fn();
const mockRuleSort = jest.fn();
const mockRuleFind = jest.fn(() => ({ sort: mockRuleSort }));
const mockRuleInsertMany = jest.fn();
const mockServiceSort = jest.fn();
const mockServiceFind = jest.fn(() => ({ sort: mockServiceSort }));
const mockExceptionSort = jest.fn();
const mockExceptionFind = jest.fn(() => ({ sort: mockExceptionSort }));

jest.mock("../../src/models/availabilityException.js", () => ({
  __esModule: true,
  default: { find: (...args) => mockExceptionFind(...args) },
}));
jest.mock("../../src/models/availabilityRule.js", () => ({
  __esModule: true,
  default: {
    find: (...args) => mockRuleFind(...args),
    insertMany: (...args) => mockRuleInsertMany(...args),
  },
}));
jest.mock("../../src/models/businessOperationsSettings.js", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: (...args) => mockOpsFindOneAndUpdate(...args),
  },
}));
jest.mock("../../src/models/schedulingPolicy.js", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: (...args) => mockPolicyFindOneAndUpdate(...args),
  },
}));
jest.mock("../../src/models/serviceArea.js", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: (...args) => mockAreaFindOneAndUpdate(...args),
  },
}));
jest.mock("../../src/models/serviceOffering.js", () => ({
  __esModule: true,
  default: { find: (...args) => mockServiceFind(...args) },
}));

const {
  DAY_NAMES,
  getOrCreateSchedulingPolicy,
  getOrCreateServiceArea,
  getOrCreateOperationsSettings,
  ensureAvailabilityRules,
  getConfigurationReadiness,
  getBusinessConfigurationBootstrap,
  buildAIConfigurationContext,
} = require("../../src/services/businessConfiguration.service.js");

const BUSINESS = {
  _id: "biz-config",
  businessName: "Atlanta Pro Plumbing",
  timezone: "America/New_York",
  features: { aiBookingEnabled: true },
};

const POLICY = { _id: "policy-1", business: BUSINESS._id };
const AREA = { _id: "area-1", type: "zip_codes", zipCodes: ["30301"] };
const OPS = {
  _id: "ops-1",
  emergencyPolicy: { enabled: true },
  aiPermissions: { canBookEligibleServices: true },
  followUpSettings: { enabled: true },
  humanHandoffContacts: [
    { active: true, phone: "+14045550100", email: "" },
  ],
};

const completeRules = () =>
  Array.from({ length: 7 }, (_, dayOfWeek) => ({
    dayOfWeek,
    enabled: dayOfWeek >= 1 && dayOfWeek <= 5,
    windows:
      dayOfWeek >= 1 && dayOfWeek <= 5
        ? [{ startTime: "08:00", endTime: "17:00" }]
        : [],
    timezone: BUSINESS.timezone,
    capacity: 1,
  }));

const services = [
  {
    _id: "svc-discuss",
    active: true,
    aiCanDiscuss: true,
    aiCanBook: true,
    name: "Drain Cleaning",
    category: "Plumbing",
    description: "Clear a clogged drain",
    durationMinutes: 60,
    bufferBeforeMinutes: 10,
    bufferAfterMinutes: 15,
    estimatedValue: 250,
    discloseDiagnosticFee: true,
    diagnosticFee: 89,
    emergencyEligible: false,
    requiresHumanReview: false,
    keywords: ["clog"],
    excludedKeywords: [],
  },
  {
    _id: "svc-hidden",
    active: true,
    aiCanDiscuss: false,
    aiCanBook: false,
    name: "Internal Only",
    durationMinutes: 30,
  },
  {
    _id: "svc-inactive",
    active: false,
    aiCanDiscuss: true,
    aiCanBook: false,
    name: "Inactive",
    durationMinutes: 30,
  },
];

describe("businessConfiguration target coverage", () => {
  let consoleError;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    mockPolicyFindOneAndUpdate.mockResolvedValue(POLICY);
    mockAreaFindOneAndUpdate.mockResolvedValue(AREA);
    mockOpsFindOneAndUpdate.mockResolvedValue(OPS);
    mockRuleSort.mockResolvedValue(completeRules());
    mockRuleInsertMany.mockResolvedValue([]);
    mockServiceSort.mockResolvedValue(services);
    mockExceptionSort.mockResolvedValue([]);
  });

  afterEach(() => consoleError.mockRestore());

  test("DAY_NAMES is complete and ordered", () => {
    expect(DAY_NAMES).toEqual([
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ]);
  });

  test("get-or-create wrappers use upserts with defaults", async () => {
    await expect(getOrCreateSchedulingPolicy("biz")).resolves.toBe(POLICY);
    await expect(getOrCreateServiceArea("biz")).resolves.toBe(AREA);
    await expect(getOrCreateOperationsSettings("biz")).resolves.toBe(OPS);

    expect(mockPolicyFindOneAndUpdate).toHaveBeenCalledWith(
      { business: "biz" },
      { $setOnInsert: { business: "biz" } },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    );
    expect(mockAreaFindOneAndUpdate).toHaveBeenCalledWith(
      { business: "biz" },
      { $setOnInsert: { business: "biz", type: "zip_codes" } },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    );
  });

  test("availability rules return immediately when all seven exist", async () => {
    const existing = completeRules();
    mockRuleSort.mockResolvedValueOnce(existing);
    await expect(ensureAvailabilityRules("biz", "UTC")).resolves.toBe(existing);
    expect(mockRuleInsertMany).not.toHaveBeenCalled();
  });

  test("availability rules insert only missing weekdays with weekday defaults", async () => {
    const existing = completeRules().filter((rule) => ![0, 3, 6].includes(rule.dayOfWeek));
    const completed = completeRules();
    mockRuleSort
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(completed);

    await expect(ensureAvailabilityRules("biz", "UTC")).resolves.toEqual(completed);

    expect(mockRuleInsertMany).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          business: "biz",
          dayOfWeek: 0,
          enabled: false,
          windows: [],
          timezone: "UTC",
        }),
        expect.objectContaining({
          business: "biz",
          dayOfWeek: 3,
          enabled: true,
          windows: [{ startTime: "08:00", endTime: "17:00" }],
          timezone: "UTC",
        }),
        expect.objectContaining({
          business: "biz",
          dayOfWeek: 6,
          enabled: false,
          windows: [],
          timezone: "UTC",
        }),
      ]),
      { ordered: false },
    );
  });

  test("duplicate-key race while creating availability rules is tolerated", async () => {
    mockRuleSort
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(completeRules());
    mockRuleInsertMany.mockRejectedValueOnce(Object.assign(new Error("duplicate"), { code: 11000 }));

    await expect(ensureAvailabilityRules("biz", "UTC")).resolves.toHaveLength(7);
  });

  test("non-duplicate availability creation error is propagated", async () => {
    mockRuleSort.mockResolvedValueOnce([]);
    mockRuleInsertMany.mockRejectedValueOnce(new Error("mongo down"));
    await expect(ensureAvailabilityRules("biz")).rejects.toThrow("mongo down");
  });

  test("readiness reports every missing category when configuration is empty", () => {
    const readiness = getConfigurationReadiness({
      services: [],
      rules: [],
      schedulingPolicy: null,
      serviceArea: null,
      operationsSettings: null,
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.completionPercentage).toBe(0);
    expect(readiness.missing).toEqual(
      expect.arrayContaining([
        "activeServiceCatalog",
        "appointmentDurations",
        "operatingHours",
        "serviceArea",
        "schedulingPolicy",
        "humanHandoff",
        "emergencyPolicy",
        "aiPermissions",
        "followUpSettings",
      ]),
    );
  });

  test("zip-code configuration can be fully ready", () => {
    const readiness = getConfigurationReadiness({
      services,
      rules: completeRules(),
      schedulingPolicy: POLICY,
      serviceArea: AREA,
      operationsSettings: OPS,
    });
    expect(readiness).toMatchObject({
      ready: true,
      completionPercentage: 100,
      missing: [],
    });
    expect(Object.values(readiness.checks).every(Boolean)).toBe(true);
  });

  test("radius area requires both center and miles", () => {
    const base = {
      services,
      rules: completeRules(),
      schedulingPolicy: POLICY,
      operationsSettings: OPS,
    };
    expect(
      getConfigurationReadiness({
        ...base,
        serviceArea: { type: "radius", centerPostalCode: "30301", radiusMiles: 25 },
      }).checks.serviceArea,
    ).toBe(true);

    expect(
      getConfigurationReadiness({
        ...base,
        serviceArea: { type: "radius", centerPostalCode: "30301", radiusMiles: 0 },
      }).checks.serviceArea,
    ).toBe(false);
  });

  test.each([
    [{ active: true, phone: "+14045550100" }, true],
    [{ active: true, email: "dispatch@example.com" }, true],
    [{ active: false, phone: "+14045550100" }, false],
    [{ active: true }, false],
  ])("handoff readiness %#", (contact, expected) => {
    const readiness = getConfigurationReadiness({
      services,
      rules: completeRules(),
      schedulingPolicy: POLICY,
      serviceArea: AREA,
      operationsSettings: {
        ...OPS,
        humanHandoffContacts: [contact],
      },
    });
    expect(readiness.checks.humanHandoff).toBe(expected);
  });

  test("bootstrap returns all configuration surfaces and readiness", async () => {
    const result = await getBusinessConfigurationBootstrap(BUSINESS);
    expect(result.business).toEqual({
      _id: BUSINESS._id,
      businessName: BUSINESS.businessName,
      timezone: BUSINESS.timezone,
      features: BUSINESS.features,
    });
    expect(result.services).toBe(services);
    expect(result.availabilityRules).toHaveLength(7);
    expect(result.schedulingPolicy).toBe(POLICY);
    expect(result.serviceArea).toBe(AREA);
    expect(result.operationsSettings).toBe(OPS);
    expect(result.readiness.ready).toBe(true);
  });

  test("bootstrap normalizes absent business features", async () => {
    const result = await getBusinessConfigurationBootstrap({
      ...BUSINESS,
      features: undefined,
    });
    expect(result.business.features).toEqual({});
  });

  test("AI context without business id is deterministic and safe", async () => {
    await expect(buildAIConfigurationContext({})).resolves.toEqual({
      configured: false,
      services: [],
      availabilityRules: [],
      availabilityExceptions: [],
      schedulingPolicy: null,
      serviceArea: null,
      operations: null,
    });
  });

  test("AI context filters services and redacts undisclosed diagnostic fees", async () => {
    mockServiceSort.mockResolvedValueOnce([
      services[0],
      { ...services[0], _id: "svc-2", discloseDiagnosticFee: false, diagnosticFee: 125 },
      services[1],
      services[2],
    ]);

    const result = await buildAIConfigurationContext(BUSINESS);

    expect(result.configured).toBe(true);
    expect(result.services).toHaveLength(2);
    expect(result.services[0]).toMatchObject({
      id: "svc-discuss",
      diagnosticFee: 89,
    });
    expect(result.services[1]).toMatchObject({
      id: "svc-2",
      diagnosticFee: null,
    });
    expect(result.availabilityRules[1]).toMatchObject({
      dayOfWeek: 1,
      dayName: "Monday",
    });
    expect(result.operations.hasActiveHandoffContact).toBe(true);
  });

  test("AI context detects email handoff and ignores inactive contacts", async () => {
    mockOpsFindOneAndUpdate.mockResolvedValueOnce({
      ...OPS,
      humanHandoffContacts: [
        { active: false, phone: "+14045550100" },
        { active: true, email: "dispatch@example.com" },
      ],
    });

    const result = await buildAIConfigurationContext(BUSINESS);
    expect(result.operations.hasActiveHandoffContact).toBe(true);
  });

  test("AI context fails closed when bootstrap persistence fails", async () => {
    mockServiceSort.mockRejectedValueOnce(new Error("database unavailable"));
    const result = await buildAIConfigurationContext(BUSINESS);
    expect(result).toEqual({
      configured: false,
      services: [],
      availabilityRules: [],
      availabilityExceptions: [],
      schedulingPolicy: null,
      serviceArea: null,
      operations: null,
      error: "business_configuration_unavailable",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "Unable to build business configuration context:",
      expect.objectContaining({
        businessId: BUSINESS._id,
        message: "database unavailable",
      }),
    );
  });
});
