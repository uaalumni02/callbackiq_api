import {
  redactPhone,
  sanitizeError,
  sanitizeLogDetails,
} from "../../src/helpers/logging/safeLogger.js";

describe("production log redaction", () => {
  const previousNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "production";
  });

  afterAll(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });

  test("never exposes a complete phone number or message body", () => {
    const sanitized = sanitizeLogDetails({
      from: "+1 (404) 555-0101",
      to: "+1 (404) 555-0102",
      body: "I smell gas at 123 Main Street",
      customerName: "Jane Customer",
    });

    expect(sanitized.from).toBe("***0101");
    expect(sanitized.to).toBe("***0102");
    expect(sanitized.body).toMatch(/^\[redacted:[a-f0-9]{12}\]$/);
    expect(sanitized.customerName).toMatch(/^\[redacted:[a-f0-9]{12}\]$/);
    expect(JSON.stringify(sanitized)).not.toContain("123 Main Street");
    expect(JSON.stringify(sanitized)).not.toContain("4045550101");
  });

  test("redacts provider errors while preserving operational codes", () => {
    const result = sanitizeError(
      Object.assign(new Error("Delivery to +14045550101 failed"), {
        code: "TWILIO_DELIVERY_FAILED",
        status: 400,
      }),
    );

    expect(result.message).toMatch(/^\[redacted:[a-f0-9]{12}\]$/);
    expect(result.code).toBe("TWILIO_DELIVERY_FAILED");
    expect(result.status).toBe(400);
    expect(redactPhone("+14045550101")).toBe("***0101");
  });
});
