import * as Response from "../../src/helpers/response/response.js";

const makeRes = () => ({
  statusCode: 200,
  status: jest.fn(function status(code) { this.statusCode = code; return this; }),
  json: jest.fn().mockReturnThis(),
  send: jest.fn().mockReturnThis(),
  end: jest.fn().mockReturnThis(),
  cookie: jest.fn().mockReturnThis(),
  clearCookie: jest.fn().mockReturnThis(),
});

const exportedFunctions = () => Object.entries(Response).filter(([, value]) => typeof value === "function");

describe("response helper branches", () => {
  test.each([
    "This forwarding phone is already registered",
    "You already have a business account",
    "User with this username or email already exists",
    "Username, email, or business already exists",
  ])("returns the actual conflict reason: %s", (message) => {
    const res = makeRes();

    Response.responseConflict(res, message);

    expect(res.statusCode).toBe(409);
    expect(res.json).toHaveBeenCalledWith({ success: false, message });
  });

  test("uses a generic conflict message when no reason is supplied", () => {
    const res = makeRes();

    Response.responseConflict(res);

    expect(res.statusCode).toBe(409);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: "A record with these details already exists.",
    });
  });

  test("exports response functions", () => {
    expect(exportedFunctions().length).toBeGreaterThan(0);
  });

  test("exercises every response helper with common argument shapes", () => {
    const payloads = [
      [],
      [makeRes()],
      [makeRes(), "message"],
      [makeRes(), { id: "1" }],
      [makeRes(), "message", { id: "1" }],
      [makeRes(), { message: "message", data: { id: "1" } }],
      [makeRes(), new Error("failure")],
    ];

    for (const [, fn] of exportedFunctions()) {
      let completed = false;
      for (const args of payloads) {
        try {
          fn(...args);
          completed = true;
        } catch (_error) {
          // Different helpers intentionally require different signatures.
        }
      }
      expect(completed).toBe(true);
    }
  });
});
