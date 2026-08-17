import twilio from "twilio";
import validateTwilioSignature, {
  getWebhookUrl,
} from "../../src/middleware/validate-twilio-signature.js";

jest.mock("twilio", () => ({
  __esModule: true,
  default: {
    validateRequest: jest.fn(),
  },
}));

const makeReq = (overrides = {}) => ({
  headers: {},
  body: { From: "+14045550100" },
  originalUrl: "/api/twilio/sms",
  protocol: "http",
  get: jest.fn((name) => {
    const normalized = String(name).toLowerCase();
    if (normalized === "host") return "localhost:3000";
    if (normalized === "x-twilio-signature") return overrides.signature;
    return undefined;
  }),
  ...overrides,
});

const makeRes = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

describe("Twilio signature middleware", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NODE_ENV: "production",
      TWILIO_VALIDATE_WEBHOOKS: "true",
      TWILIO_AUTH_TOKEN: "auth-token",
    };
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  test("bypasses validation automatically in the test environment", () => {
    process.env.NODE_ENV = "test";
    const next = jest.fn();
    validateTwilioSignature(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(twilio.validateRequest).not.toHaveBeenCalled();
  });

  test("supports TWILIO_VALIDATE_WEBHOOKS=false outside production", () => {
    process.env.NODE_ENV = "development";
    process.env.TWILIO_VALIDATE_WEBHOOKS = " FALSE ";
    const next = jest.fn();
    validateTwilioSignature(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(twilio.validateRequest).not.toHaveBeenCalled();
  });

  test("returns 503 when production validation has no auth token", () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const res = makeRes();
    validateTwilioSignature(makeReq(), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: "Twilio webhook validation is not configured.",
    });
  });

  test("warns once and proceeds without an auth token outside production", () => {
    process.env.NODE_ENV = "development";
    delete process.env.TWILIO_AUTH_TOKEN;
    const next1 = jest.fn();
    const next2 = jest.fn();
    validateTwilioSignature(makeReq(), makeRes(), next1);
    validateTwilioSignature(makeReq(), makeRes(), next2);
    expect(next1).toHaveBeenCalledWith();
    expect(next2).toHaveBeenCalledWith();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  test("rejects a request with no signature", () => {
    const res = makeRes();
    validateTwilioSignature(makeReq(), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: "Invalid Twilio webhook signature.",
    });
  });

  test("accepts a valid Twilio signature", () => {
    twilio.validateRequest.mockReturnValue(true);
    const req = makeReq({ signature: "valid-signature" });
    const next = jest.fn();
    validateTwilioSignature(req, makeRes(), next);
    expect(twilio.validateRequest).toHaveBeenCalledWith(
      "auth-token",
      "valid-signature",
      getWebhookUrl(req),
      req.body,
    );
    expect(next).toHaveBeenCalledWith();
  });

  test("rejects an invalid signature", () => {
    twilio.validateRequest.mockReturnValue(false);
    const res = makeRes();
    validateTwilioSignature(
      makeReq({ signature: "bad-signature" }),
      res,
      jest.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(console.warn).toHaveBeenCalledWith(
      "Rejected Twilio webhook with an invalid signature",
      { path: "/api/twilio/sms" },
    );
  });

  test("uses a configured webhook base URL and removes trailing slashes", () => {
    process.env.TWILIO_WEBHOOK_BASE_URL = "https://api.example.com///";
    expect(getWebhookUrl(makeReq())).toBe(
      "https://api.example.com/api/twilio/sms",
    );
  });

  test("uses the first forwarded protocol and host values", () => {
    delete process.env.TWILIO_WEBHOOK_BASE_URL;
    const req = makeReq({
      headers: {
        "x-forwarded-proto": "https, http",
        "x-forwarded-host": "callbackiq.example.com, internal:3000",
      },
    });
    expect(getWebhookUrl(req)).toBe(
      "https://callbackiq.example.com/api/twilio/sms",
    );
  });

  test("propagates validator exceptions to the global error handler", () => {
    twilio.validateRequest.mockImplementation(() => {
      throw new Error("validator failure");
    });
    expect(() =>
      validateTwilioSignature(
        makeReq({ signature: "signature" }),
        makeRes(),
        jest.fn(),
      ),
    ).toThrow("validator failure");
  });
});
