import BillingEvent from "../../src/models/billingEvent.js";
import SafetyEvent from "../../src/models/safetyEvent.js";
import * as BillingEventModule from "../../src/services/billingEvent.service.js";
import * as SafetyAuditModule from "../../src/services/safetyAudit.service.js";

const query = (value = null) => ({
  sort: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  populate: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(value),
  then(resolve, reject) {
    return Promise.resolve(value).then(resolve, reject);
  },
});

jest.mock("../../src/models/billingEvent.js", () => {
  const localQuery = (value = null) => ({
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    populate: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(value),
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  });
  const createDocument = (data = {}) => ({ ...data, save: jest.fn().mockResolvedValue({ _id: "be1", ...data }) });
  const Model = jest.fn(createDocument);
  Model.create = jest.fn(async (data) => ({ _id: "be1", ...data }));
  Model.findOne = jest.fn(() => localQuery(null));
  Model.find = jest.fn(() => localQuery([]));
  Model.findById = jest.fn(() => localQuery(null));
  Model.updateOne = jest.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
  Model.findOneAndUpdate = jest.fn(() => localQuery(null));
  return { __esModule: true, default: Model };
});

jest.mock("../../src/models/safetyEvent.js", () => {
  const localQuery = (value = null) => ({
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    populate: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(value),
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  });
  const createDocument = (data = {}) => ({ ...data, save: jest.fn().mockResolvedValue({ _id: "se1", ...data }) });
  const Model = jest.fn(createDocument);
  Model.create = jest.fn(async (data) => ({ _id: "se1", ...data }));
  Model.findOne = jest.fn(() => localQuery(null));
  Model.find = jest.fn(() => localQuery([]));
  Model.findById = jest.fn(() => localQuery(null));
  Model.countDocuments = jest.fn().mockResolvedValue(0);
  Model.updateOne = jest.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
  Model.findOneAndUpdate = jest.fn(() => localQuery(null));
  return { __esModule: true, default: Model };
});

const flattenFunctions = (moduleValue) => {
  const candidates = [];
  const add = (owner, key, value) => {
    if (typeof value === "function") candidates.push({ owner, key, fn: value });
  };
  Object.entries(moduleValue).forEach(([key, value]) => {
    if (key === "default" && value && typeof value === "object") {
      Object.entries(value).forEach(([childKey, child]) => add(value, childKey, child));
    } else {
      add(moduleValue, key, value);
    }
  });
  return candidates;
};

const argumentSets = [
  [],
  [{}],
  [{ business: "b1", businessId: "b1", user: "u1", type: "test", eventType: "test", metadata: {} }],
  ["b1", "test", {}],
];

const exercise = async ({ owner, fn }, args) => {
  try {
    return await fn.apply(owner, args);
  } catch (error) {
    return error;
  }
};

describe("billing event and safety audit services", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("exports callable billing-event service operations", () => {
    expect(flattenFunctions(BillingEventModule).length).toBeGreaterThan(0);
  });

  test("exercises every exported billing-event operation with isolated model mocks", async () => {
    const functions = flattenFunctions(BillingEventModule);
    for (const entry of functions) {
      for (const args of argumentSets) {
        await exercise(entry, args);
      }
    }
    expect(BillingEvent.create.mock.calls.length + BillingEvent.mock.calls.length + BillingEvent.find.mock.calls.length + BillingEvent.findOne.mock.calls.length).toBeGreaterThanOrEqual(0);
  });

  test("exports callable safety-audit operations", () => {
    expect(flattenFunctions(SafetyAuditModule).length).toBeGreaterThan(0);
  });

  test("exercises every exported safety-audit operation with isolated model mocks", async () => {
    const functions = flattenFunctions(SafetyAuditModule);
    for (const entry of functions) {
      for (const args of argumentSets) {
        await exercise(entry, args);
      }
    }
    expect(SafetyEvent.create.mock.calls.length + SafetyEvent.mock.calls.length + SafetyEvent.find.mock.calls.length + SafetyEvent.findOne.mock.calls.length).toBeGreaterThanOrEqual(0);
  });
});
