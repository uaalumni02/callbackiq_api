import Alert from "../../src/models/alert.js";
import InterventionController, {
  compareInterventions,
  resolveAssignableUserId,
} from "../../src/controllers/intervention.js";
import getOwnedBusiness from "../../src/services/businessScope.service.js";
import SocketService from "../../src/services/socket.service.js";

jest.mock("../../src/models/alert.js", () => ({
  __esModule: true,
  default: {
    find: jest.fn(),
    aggregate: jest.fn(),
    countDocuments: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
  },
}));

jest.mock("../../src/services/businessScope.service.js", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("../../src/services/socket.service.js", () => ({
  __esModule: true,
  default: {
    emitAlertUpdated: jest.fn(),
    emitDashboardRefresh: jest.fn(),
  },
}));

const OWNER_ID = "507f1f77bcf86cd799439011";
const BUSINESS_ID = "507f1f77bcf86cd799439012";
const ALERT_ID = "507f1f77bcf86cd799439013";

const populatedQuery = (value) => {
  const query = {
    populate: jest.fn(() => query),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return query;
};

const listQuery = (value) => {
  const query = {
    populate: jest.fn(() => query),
    sort: jest.fn(() => query),
    limit: jest.fn(() => query),
    lean: jest.fn().mockResolvedValue(value),
  };
  return query;
};

const response = () => {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};

const request = ({ body = {}, query = {}, params = { id: ALERT_ID } } = {}) => ({
  body,
  query,
  params,
  user: { userId: OWNER_ID, role: "owner" },
});

const business = { _id: BUSINESS_ID, owner: OWNER_ID };

beforeEach(() => {
  jest.clearAllMocks();
  getOwnedBusiness.mockResolvedValue(business);
});

describe("Intervention Center completion audit", () => {
  test("sorts critical items first, then due date, then newest", () => {
    const items = [
      { priority: "high", dueAt: "2026-07-28T13:00:00Z", createdAt: "2026-07-28T10:00:00Z" },
      { priority: "critical", dueAt: null, createdAt: "2026-07-28T09:00:00Z" },
      { priority: "high", dueAt: "2026-07-28T12:00:00Z", createdAt: "2026-07-28T08:00:00Z" },
    ];

    items.sort(compareInterventions);

    expect(items.map((item) => item.priority)).toEqual([
      "critical",
      "high",
      "high",
    ]);
    expect(items[1].dueAt).toContain("12:00:00");
  });

  test("restricts assignment to the current business owner", () => {
    expect(
      resolveAssignableUserId({ business, requestedAssignee: OWNER_ID }),
    ).toBe(OWNER_ID);
    expect(
      resolveAssignableUserId({ business, requestedAssignee: null }),
    ).toBeNull();
    expect(() =>
      resolveAssignableUserId({
        business,
        requestedAssignee: "507f1f77bcf86cd799439099",
      }),
    ).toThrow("Only the business owner");
  });

  test("lists only business-scoped intervention records and applies filters", async () => {
    const records = [
      {
        _id: "critical",
        priority: "critical",
        createdAt: new Date("2026-07-28T10:00:00Z"),
      },
      {
        _id: "high",
        priority: "high",
        createdAt: new Date("2026-07-28T11:00:00Z"),
      },
    ];

    Alert.aggregate.mockResolvedValue([
      { _id: "critical" },
      { _id: "high" },
    ]);
    Alert.countDocuments.mockResolvedValue(records.length);
    Alert.find.mockReturnValue(listQuery(records));

    const res = response();

    await InterventionController.list(
      request({
        query: {
          resolved: "false",
          priority: "high",
          search: "gas leak",
          limit: "25",
        },
      }),
      res,
      jest.fn(),
    );

    const pipeline = Alert.aggregate.mock.calls[0][0];
    const matchStage = pipeline.find((stage) => stage.$match);

    expect(matchStage).toBeDefined();

    expect(matchStage.$match).toEqual(
      expect.objectContaining({
        business: BUSINESS_ID,
        priority: "high",
        resolvedAt: null,
        $and: expect.any(Array),
      }),
    );

    expect(pipeline).toContainEqual({ $skip: 0 });
    expect(pipeline).toContainEqual({ $limit: 25 });

    expect(Alert.countDocuments).toHaveBeenCalledWith(
      matchStage.$match,
    );

    expect(Alert.find).toHaveBeenCalledWith({
      _id: { $in: ["critical", "high"] },
      business: BUSINESS_ID,
    });

    expect(res.status).toHaveBeenCalledWith(200);
  });

  test("acknowledgement is idempotent and does not rewrite its audit time", async () => {
    const acknowledgedAt = new Date("2026-07-28T12:00:00Z");
    const existing = {
      _id: ALERT_ID,
      assignedTo: { _id: OWNER_ID },
      acknowledgedAt,
      resolvedAt: null,
    };
    Alert.findOne.mockReturnValue(populatedQuery(existing));
    const res = response();

    await InterventionController.acknowledge(request(), res, jest.fn());

    expect(Alert.findOneAndUpdate).not.toHaveBeenCalled();
    expect(SocketService.emitAlertUpdated).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true, data: existing });
    expect(existing.acknowledgedAt).toBe(acknowledgedAt);
  });

  test("acknowledges, assigns, and records the acting user atomically", async () => {
    const existing = {
      _id: ALERT_ID,
      assignedTo: null,
      acknowledgedAt: null,
      resolvedAt: null,
    };
    const updated = { ...existing, assignedTo: { _id: OWNER_ID }, acknowledgedAt: new Date() };
    Alert.findOne.mockReturnValue(populatedQuery(existing));
    Alert.findOneAndUpdate.mockReturnValue(populatedQuery(updated));
    const res = response();

    await InterventionController.acknowledge(request(), res, jest.fn());

    expect(Alert.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: ALERT_ID,
        business: BUSINESS_ID,
        resolvedAt: null,
        acknowledgedAt: null,
      }),
      {
        $set: expect.objectContaining({
          status: "acknowledged",
          acknowledgedAt: expect.any(Date),
          acknowledgedBy: OWNER_ID,
          assignedTo: OWNER_ID,
          assignedAt: expect.any(Date),
          assignedBy: OWNER_ID,
        }),
      },
      { returnDocument: "after", runValidators: true },
    );
    expect(SocketService.emitAlertUpdated).toHaveBeenCalledWith(BUSINESS_ID, updated);
  });

  test("resolution is idempotent and preserves the original resolution", async () => {
    const resolvedAt = new Date("2026-07-28T12:30:00Z");
    const existing = {
      _id: ALERT_ID,
      resolvedAt,
      resolution: "Customer reached.",
    };
    Alert.findOne.mockReturnValue(populatedQuery(existing));
    const res = response();

    await InterventionController.resolve(
      request({ body: { resolution: "Overwrite attempt" } }),
      res,
      jest.fn(),
    );

    expect(Alert.findOneAndUpdate).not.toHaveBeenCalled();
    expect(SocketService.emitAlertUpdated).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true, data: existing });
    expect(existing.resolution).toBe("Customer reached.");
    expect(existing.resolvedAt).toBe(resolvedAt);
  });

  test("resolves with assignment and complete audit metadata", async () => {
    const existing = {
      _id: ALERT_ID,
      assignedTo: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedAt: null,
      readAt: null,
    };
    const updated = { ...existing, resolvedAt: new Date(), resolution: "Handled" };
    Alert.findOne.mockReturnValue(populatedQuery(existing));
    Alert.findOneAndUpdate.mockReturnValue(populatedQuery(updated));
    const res = response();

    await InterventionController.resolve(
      request({ body: { resolution: "Handled" } }),
      res,
      jest.fn(),
    );

    expect(Alert.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: ALERT_ID, business: BUSINESS_ID, resolvedAt: null },
      {
        $set: expect.objectContaining({
          status: "resolved",
          resolvedAt: expect.any(Date),
          resolvedBy: OWNER_ID,
          acknowledgedAt: expect.any(Date),
          acknowledgedBy: OWNER_ID,
          assignedTo: OWNER_ID,
          assignedAt: expect.any(Date),
          assignedBy: OWNER_ID,
          actionRequired: false,
          resolution: "Handled",
        }),
      },
      { returnDocument: "after", runValidators: true },
    );
    expect(SocketService.emitDashboardRefresh).toHaveBeenCalledWith(
      BUSINESS_ID,
      "intervention:resolved",
    );
  });

  test("rejects cross-tenant assignment before updating the alert", async () => {
    const existing = { _id: ALERT_ID, assignedTo: null, resolvedAt: null };
    Alert.findOne.mockReturnValue(populatedQuery(existing));
    const res = response();
    const next = jest.fn();

    await InterventionController.assign(
      request({ body: { assignedTo: "507f1f77bcf86cd799439099" } }),
      res,
      next,
    );

    expect(Alert.findOneAndUpdate).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403 }),
    );
  });

  test("assigns and unassigns through audited updates", async () => {
    const existing = { _id: ALERT_ID, assignedTo: null, resolvedAt: null };
    const assigned = { ...existing, assignedTo: { _id: OWNER_ID } };
    Alert.findOne.mockReturnValueOnce(populatedQuery(existing));
    Alert.findOneAndUpdate.mockReturnValueOnce(populatedQuery(assigned));
    const assignResponse = response();

    await InterventionController.assign(
      request({ body: { assignedTo: OWNER_ID } }),
      assignResponse,
      jest.fn(),
    );

    expect(Alert.findOneAndUpdate).toHaveBeenNthCalledWith(
      1,
      { _id: ALERT_ID, business: BUSINESS_ID, resolvedAt: null },
      {
        $set: {
          assignedTo: OWNER_ID,
          assignedAt: expect.any(Date),
          assignedBy: OWNER_ID,
        },
      },
      { returnDocument: "after", runValidators: true },
    );

    Alert.findOne.mockReturnValueOnce(populatedQuery(assigned));
    Alert.findOneAndUpdate.mockReturnValueOnce(
      populatedQuery({ ...existing, assignedTo: null }),
    );
    const unassignResponse = response();

    await InterventionController.assign(
      request({ body: { assignedTo: null } }),
      unassignResponse,
      jest.fn(),
    );

    expect(Alert.findOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      { _id: ALERT_ID, business: BUSINESS_ID, resolvedAt: null },
      { $set: { assignedTo: null, assignedAt: null, assignedBy: null } },
      { returnDocument: "after", runValidators: true },
    );
  });
});
