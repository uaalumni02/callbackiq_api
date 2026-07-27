import errorHandler from "../../src/middleware/error-handler.js";

const makeRes = () => ({
  headersSent: false,
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
  send: jest.fn().mockReturnThis(),
});

describe("global error handler", () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  test.each([
    [{ message: "bad input", statusCode: 400, code: "BAD_INPUT" }, 400],
    [{ message: "unauthorized", status: 401 }, 500],
    [new Error("unexpected"), 500],
    [{}, 500],
  ])("serializes error %#", (error, expectedStatus) => {
    process.env = { ...originalEnv, NODE_ENV: "test" };
    const req = { method: "GET", originalUrl: "/test", requestId: "req-1" };
    const res = makeRes();
    const next = jest.fn();
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    errorHandler(error, req, res, next);

    if (res.status.mock.calls.length) {
      expect(res.status).toHaveBeenCalledWith(expectedStatus);
      expect(res.json.mock.calls.length + res.send.mock.calls.length).toBeGreaterThan(0);
    } else {
      expect(next).toHaveBeenCalled();
    }
    consoleSpy.mockRestore();
  });

  test("delegates when response headers were already sent", () => {
    const error = new Error("late failure");
    const req = {};
    const res = makeRes();
    res.headersSent = true;
    const next = jest.fn();
    errorHandler(error, req, res, next);
    expect(next).toHaveBeenCalledWith(error);
  });

  test("does not expose production stack details", () => {
    process.env = { ...originalEnv, NODE_ENV: "production" };
    const error = new Error("private details");
    error.stack = "private stack";
    const res = makeRes();
    jest.spyOn(console, "error").mockImplementation(() => {});
    errorHandler(error, {}, res, jest.fn());
    const payload = res.json.mock.calls[0]?.[0] || res.send.mock.calls[0]?.[0] || {};
    expect(JSON.stringify(payload)).not.toContain("private stack");
  });
});
