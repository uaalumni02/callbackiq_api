const mockFindOneAndUpdate = jest.fn();

jest.mock("../../src/models/requestRateLimitBucket.js", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: mockFindOneAndUpdate,
  },
}));

import {
  createDistributedAuthRateLimit,
} from "../../src/middleware/auth-distributed-rate-limits.js";

const makeResponse = () => {
  const res = {
    set: jest.fn(),
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};

const queryResult = (value) => ({
  lean: jest.fn().mockResolvedValue(value),
});

describe("distributed auth rate limiting", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, NODE_ENV: "production" };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("allows requests within the shared limit", async () => {
    mockFindOneAndUpdate.mockReturnValue(queryResult({ count: 1 }));
    const middleware = createDistributedAuthRateLimit({
      scope: "test",
      windowMs: 60000,
      limit: 2,
    });
    const req = { ip: "203.0.113.7", socket: {} };
    const res = makeResponse();
    const next = jest.fn();

    await middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  test("returns 429 after the distributed limit", async () => {
    mockFindOneAndUpdate.mockReturnValue(queryResult({ count: 3 }));
    const middleware = createDistributedAuthRateLimit({
      scope: "test",
      windowMs: 60000,
      limit: 2,
    });
    const res = makeResponse();

    await middleware({ ip: "203.0.113.7", socket: {} }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.set).toHaveBeenCalledWith("Retry-After", expect.any(String));
  });

  test("fails closed in production when Mongo rate limiting fails", async () => {
    mockFindOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockRejectedValue(new Error("db down")),
    });
    const middleware = createDistributedAuthRateLimit({
      scope: "test",
      windowMs: 60000,
      limit: 2,
    });
    const res = makeResponse();

    await middleware({ ip: "203.0.113.7", socket: {} }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(503);
  });

  test("can fail open only when explicitly configured", async () => {
    process.env.AUTH_RATE_LIMIT_FAIL_CLOSED = "false";
    mockFindOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockRejectedValue(new Error("db down")),
    });
    const middleware = createDistributedAuthRateLimit({
      scope: "test",
      windowMs: 60000,
      limit: 2,
    });
    const next = jest.fn();

    await middleware(
      { ip: "203.0.113.7", socket: {} },
      makeResponse(),
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("is a no-op outside production unless explicitly enabled", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.DISTRIBUTED_AUTH_RATE_LIMIT_ENABLED;
    const middleware = createDistributedAuthRateLimit({
      scope: "test",
      windowMs: 60000,
      limit: 2,
    });
    const next = jest.fn();

    await middleware({ ip: "127.0.0.1", socket: {} }, makeResponse(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test("rejects invalid factory configuration", () => {
    expect(() =>
      createDistributedAuthRateLimit({ scope: "", windowMs: 1, limit: 1 }),
    ).toThrow(/Invalid/);
  });
});
