const mockFindOneAndUpdate = jest.fn();
const mockUpdateOne = jest.fn();
const mockDeleteOne = jest.fn();

jest.mock("../../src/models/productionOperationLease.js", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: mockFindOneAndUpdate,
    updateOne: mockUpdateOne,
    deleteOne: mockDeleteOne,
  },
}));

import {
  acquireDistributedLease,
  releaseDistributedLease,
  renewDistributedLease,
  withDistributedLease,
} from "../../src/services/distributedLease.service.js";

const leaseQuery = (value) => ({
  lean: jest.fn().mockResolvedValue(value),
});

describe("distributed lease service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("acquires an available lease", async () => {
    mockFindOneAndUpdate.mockImplementation((filter, update) =>
      leaseQuery({
        _id: filter._id,
        ownerToken: update.$set.ownerToken,
        expiresAt: update.$set.expiresAt,
      }),
    );

    const result = await acquireDistributedLease("job:1", { ttlMs: 5000 });
    expect(result.acquired).toBe(true);
    expect(result.ownerToken).toEqual(expect.any(String));
  });

  test("treats duplicate-key contention as a skipped lease", async () => {
    mockFindOneAndUpdate.mockImplementation(() => ({
      lean: jest.fn().mockRejectedValue(Object.assign(new Error("duplicate"), { code: 11000 })),
    }));

    await expect(acquireDistributedLease("job:1")).resolves.toEqual({
      acquired: false,
      key: "job:1",
    });
  });

  test("propagates unexpected acquisition failures", async () => {
    mockFindOneAndUpdate.mockImplementation(() => ({
      lean: jest.fn().mockRejectedValue(new Error("db down")),
    }));

    await expect(acquireDistributedLease("job:1")).rejects.toThrow("db down");
  });

  test("renews and releases by owner token", async () => {
    mockUpdateOne.mockResolvedValue({ matchedCount: 1 });
    mockDeleteOne.mockResolvedValue({ deletedCount: 1 });

    await expect(
      renewDistributedLease("job:1", "owner", { ttlMs: 1000 }),
    ).resolves.toBe(true);
    await expect(releaseDistributedLease("job:1", "owner")).resolves.toBe(true);
    await expect(releaseDistributedLease("", "")).resolves.toBe(false);
  });

  test("skips operation when lease is held elsewhere", async () => {
    mockFindOneAndUpdate.mockImplementation(() => leaseQuery(null));
    const operation = jest.fn();

    const result = await withDistributedLease("job:1", operation, {
      heartbeat: false,
    });

    expect(result).toEqual({
      acquired: false,
      skipped: true,
      value: undefined,
    });
    expect(operation).not.toHaveBeenCalled();
  });

  test("runs operation and releases acquired lease", async () => {
    mockFindOneAndUpdate.mockImplementation((filter, update) =>
      leaseQuery({
        _id: filter._id,
        ownerToken: update.$set.ownerToken,
      }),
    );
    mockDeleteOne.mockResolvedValue({ deletedCount: 1 });

    const result = await withDistributedLease(
      "job:1",
      async () => "done",
      { heartbeat: false },
    );

    expect(result).toEqual({
      acquired: true,
      skipped: false,
      value: "done",
    });
    expect(mockDeleteOne).toHaveBeenCalledTimes(1);
  });

  test("requires a key and operation", async () => {
    await expect(acquireDistributedLease("")).rejects.toThrow(/key is required/);
    await expect(withDistributedLease("job", null)).rejects.toThrow(
      /must be a function/,
    );
  });
});
