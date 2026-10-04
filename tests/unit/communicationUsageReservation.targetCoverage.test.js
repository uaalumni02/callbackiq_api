const mockFind = jest.fn();
const mockFindOne = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockFindById = jest.fn();
const mockFindByIdAndUpdate = jest.fn();
const mockUpdateOne = jest.fn();
const mockCreate = jest.fn();

const mockReserveUsage = jest.fn();
const mockReleaseUsage = jest.fn();
const mockEmitThresholds = jest.fn();
const mockWarn = jest.fn();
const mockError = jest.fn();
const mockStartSession = jest.fn();

jest.mock("mongoose", () => ({
  __esModule: true,
  default: {
    startSession: (...args) => mockStartSession(...args),
  },
}));

jest.mock("../../src/models/communicationUsageReservation.js", () => ({
  __esModule: true,
  default: {
    find: (...args) => mockFind(...args),
    findOne: (...args) => mockFindOne(...args),
    findOneAndUpdate: (...args) => mockFindOneAndUpdate(...args),
    findById: (...args) => mockFindById(...args),
    findByIdAndUpdate: (...args) => mockFindByIdAndUpdate(...args),
    updateOne: (...args) => mockUpdateOne(...args),
    create: (...args) => mockCreate(...args),
  },
}));

jest.mock("../../src/services/communicationUsage.service.js", () => ({
  reserveCommunicationUsage: (...args) => mockReserveUsage(...args),
  releaseCommunicationUsage: (...args) => mockReleaseUsage(...args),
  emitCommunicationUsageThresholdAlerts: (...args) => mockEmitThresholds(...args),
}));

jest.mock("../../src/helpers/logging/safeLogger.js", () => ({
  logOperationalWarning: (...args) => mockWarn(...args),
  logOperationalError: (...args) => mockError(...args),
}));

const {
  beginCommunicationUsageReservation,
  commitCommunicationUsageReservation,
  findCommunicationOperation,
  isUncertainProviderFailure,
  markCommunicationUsageUncertain,
  releaseCommunicationUsageReservation,
  reserveCommunicationUsageOperation,
  sweepExpiredCommunicationReservations,
} = require("../../src/services/communicationUsageReservation.service.js");

describe("communication usage reservation provider-free target coverage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReleaseUsage.mockResolvedValue(undefined);
  });

  test.each([
    [{ code: "ETIMEDOUT" }, true],
    [{ cause: { code: "ECONNRESET" } }, true],
    [{ code: "EPIPE" }, true],
    [{ message: "socket hang up" }, true],
    [{ message: "network connection reset" }, true],
    [{ status: 400, message: "timeout" }, false],
    [{ code: "VALIDATION_ERROR", status: 422 }, false],
  ])("classifies uncertain provider failure %#", (error, expected) => {
    expect(isUncertainProviderFailure(error)).toBe(expected);
  });

  test("refuses reservation without business context before opening a Mongo session", async () => {
    await expect(
      reserveCommunicationUsageOperation({ business: null, key: "sms:no-business" }),
    ).resolves.toEqual({
      allowed: false,
      usage: { allowed: false, reason: "business_context_required", reservations: [] },
      reservation: null,
      replayed: false,
    });
    expect(mockStartSession).not.toHaveBeenCalled();
  });

  test.each([
    [{ bypassed: true, reservations: [{ _id: "c1" }] }],
    [{ degraded: true, reservations: [{ _id: "c1" }] }],
    [{ reservations: [] }],
    [null],
  ])("does not persist non-reservable usage %#", async (usage) => {
    await expect(
      beginCommunicationUsageReservation({ businessId: "b1", usage, key: "sms:b1:1" }),
    ).resolves.toBeNull();
  });

  test("findCommunicationOperation normalizes and returns lean result", async () => {
    const lean = jest.fn().mockResolvedValue({ operationKey: "sms:b1:1" });
    mockFindOne.mockReturnValue({ lean });
    await expect(findCommunicationOperation("  sms:b1:1  ")).resolves.toEqual({
      operationKey: "sms:b1:1",
    });
    expect(mockFindOne).toHaveBeenCalledWith({ operationKey: "sms:b1:1" });
    expect(lean).toHaveBeenCalledTimes(1);
  });

  test("commit is a no-op without a persisted reservation", async () => {
    await expect(commitCommunicationUsageReservation({ reservation: null })).resolves.toBeNull();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test("commit fences state and records provider acceptance", async () => {
    mockFindOneAndUpdate.mockResolvedValue({ _id: "r1", state: "committed" });
    const result = await commitCommunicationUsageReservation({
      reservation: { _id: "r1" },
      providerOperationId: "SM123",
      providerStatus: "accepted",
    });
    expect(result).toEqual({ _id: "r1", state: "committed" });
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: "r1", state: { $in: ["pending", "uncertain"] } },
      expect.objectContaining({
        $set: expect.objectContaining({
          state: "committed",
          providerOperationId: "SM123",
          providerStatus: "accepted",
        }),
      }),
      { returnDocument: "after" },
    );
  });

  test("uncertain delivery is a no-op without reservation", async () => {
    await expect(
      markCommunicationUsageUncertain({ reservation: null, error: new Error("timeout") }),
    ).resolves.toBeNull();
  });

  test("marks uncertain delivery with a bounded retry lease and safe warning", async () => {
    mockFindByIdAndUpdate.mockResolvedValue({ _id: "r1", state: "uncertain" });
    const error = Object.assign(new Error("socket timeout"), { code: "ETIMEDOUT" });
    const result = await markCommunicationUsageUncertain({
      reservation: { _id: "r1", operationKey: "sms:b1:1" },
      error,
    });
    expect(result.state).toBe("uncertain");
    expect(mockWarn).toHaveBeenCalledWith(
      "communication_usage.delivery_uncertain",
      expect.objectContaining({ reservationId: "r1", errorCode: "ETIMEDOUT" }),
    );
    expect(mockFindByIdAndUpdate).toHaveBeenCalledWith(
      "r1",
      expect.objectContaining({ $set: expect.objectContaining({ state: "uncertain" }) }),
      { returnDocument: "after" },
    );
  });

  test("releases raw usage when no operation reservation exists", async () => {
    await expect(
      releaseCommunicationUsageReservation({
        reservation: null,
        usage: { reservations: [{ _id: "c1" }], amount: 2 },
      }),
    ).resolves.toBeNull();
    expect(mockReleaseUsage).toHaveBeenCalledWith({
      reservations: [{ _id: "c1" }],
      amount: 2,
    });
  });

  test.each(["committed", "released"])("does not release terminal %s reservation", async (state) => {
    const reservation = { _id: "r1", state };
    await expect(releaseCommunicationUsageReservation({ reservation })).resolves.toBe(reservation);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test("returns current reservation when another worker owns release claim", async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockFindById.mockResolvedValue({ _id: "r1", state: "pending" });
    await expect(
      releaseCommunicationUsageReservation({ reservation: { _id: "r1", state: "pending" } }),
    ).resolves.toEqual({ _id: "r1", state: "pending" });
  });

  test("empty expiration sweep is bounded and side-effect free", async () => {
    const chain = {
      sort: jest.fn(),
      limit: jest.fn(),
      select: jest.fn(),
      lean: jest.fn().mockResolvedValue([]),
    };
    chain.sort.mockReturnValue(chain);
    chain.limit.mockReturnValue(chain);
    chain.select.mockReturnValue(chain);
    mockFind.mockReturnValue(chain);

    await expect(
      sweepExpiredCommunicationReservations({
        now: new Date("2026-09-01T00:00:00Z"),
        limit: 99999,
      }),
    ).resolves.toEqual({ inspected: 0, released: 0 });

    expect(chain.limit).toHaveBeenCalledWith(5000);
  });
});

test('transaction quota denial returns blocked after abort instead of becoming replay', async () => {
  const usage = { allowed:false, reason:'customer_hour_sms_outbound_limit', reservations:[] };
  const endSession=jest.fn();
  mockStartSession.mockResolvedValue({withTransaction:jest.fn().mockRejectedValue(Object.assign(new Error('quota'),{code:'COMMUNICATION_USAGE_LIMIT',usage})),endSession});
  mockFindOne.mockClear();
  expect(await reserveCommunicationUsageOperation({business:{_id:'business'},key:'quota'})).toEqual({allowed:false,usage,reservation:null,replayed:false});
  expect(mockFindOne).not.toHaveBeenCalled();expect(endSession).toHaveBeenCalled();
});
