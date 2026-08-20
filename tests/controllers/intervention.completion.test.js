import Alert from "../../src/models/alert.js";
import InterventionController, {
  compareInterventions,
} from "../../src/controllers/intervention.js";
import getOwnedBusiness from "../../src/services/businessScope.service.js";

jest.mock("../../src/models/alert.js", () => ({
  __esModule: true,
  default: { find: jest.fn(),
    aggregate: jest.fn(),
    countDocuments: jest.fn(), findOneAndUpdate: jest.fn() },
}));
jest.mock("../../src/services/businessScope.service.js", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("../../src/services/socket.service.js", () => ({
  __esModule: true,
  default: { emitAlertUpdated: jest.fn() },
}));

const queryChain = (value) => {
  const chain = {
    populate: jest.fn(() => chain),
    sort: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    lean: jest.fn().mockResolvedValue(value),
  };
  return chain;
};

const response = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

describe("intervention completion behavior", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getOwnedBusiness.mockResolvedValue({ _id: "b1" });
  });

  test("orders critical work before high, normal, and low work", () => {
    const items = [
      { priority: "low", createdAt: "2026-07-27T12:00:00Z" },
      { priority: "critical", createdAt: "2026-07-27T11:00:00Z" },
      { priority: "high", createdAt: "2026-07-27T13:00:00Z" },
      { priority: "medium", createdAt: "2026-07-27T14:00:00Z" },
    ].sort(compareInterventions);

    expect(items.map((item) => item.priority)).toEqual([
      "critical",
      "high",
      "medium",
      "low",
    ]);
  });

  test("returns a severity-sorted intervention queue", async () => {
    const records = [
      {
        _id: "low",
        priority: "low",
        createdAt: "2026-07-27T12:00:00Z",
      },
      {
        _id: "critical",
        priority: "critical",
        createdAt: "2026-07-27T11:00:00Z",
      },
    ];

    Alert.aggregate.mockResolvedValue([
      { _id: "critical" },
      { _id: "low" },
    ]);
    Alert.countDocuments.mockResolvedValue(2);
    Alert.find.mockReturnValue(queryChain(records));

    const res = response();

    await InterventionController.list(
      { user: { userId: "u1" }, query: {} },
      res,
      jest.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(200);

    expect(
      res.json.mock.calls[0][0].data.map((item) => item._id),
    ).toEqual(["critical", "low"]);
  });

  test("adds escaped search criteria and respects limits", async () => {
    Alert.aggregate.mockResolvedValue([]);
    Alert.countDocuments.mockResolvedValue(0);

    const res = response();

    await InterventionController.list(
      {
        user: { userId: "u1" },
        query: {
          search: "gas (leak)",
          limit: "10",
          resolved: "all",
        },
      },
      res,
      jest.fn(),
    );

    const pipeline = Alert.aggregate.mock.calls[0][0];
    const matchStage = pipeline.find((stage) => stage.$match);

    expect(matchStage).toBeDefined();
    expect(matchStage.$match).toEqual(
      expect.objectContaining({
        $and: expect.any(Array),
      }),
    );

    expect(pipeline).toContainEqual({ $skip: 0 });
    expect(pipeline).toContainEqual({ $limit: 10 });

    expect(Alert.countDocuments).toHaveBeenCalledWith(
      matchStage.$match,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: [],
      }),
    );
  });
});
