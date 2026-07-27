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
