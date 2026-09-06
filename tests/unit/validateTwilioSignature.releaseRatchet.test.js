import * as signatureModule from "../../src/middleware/validate-twilio-signature.js";

const resolveMiddleware = () => {
  const candidates = [
    "validateTwilioSignature",
    "validateTwilioRequest",
    "validateTwilioWebhook",
  ];

  for (const name of candidates) {
    if (typeof signatureModule?.[name] === "function") {
      return signatureModule[name];
    }
  }

  if (typeof signatureModule?.default === "function") {
    return signatureModule.default;
  }

  throw new Error(
    "Could not resolve Twilio signature middleware export.",
  );
};

const validateTwilioSignature = resolveMiddleware();

const makeResponse = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
  send: jest.fn().mockReturnThis(),
});

const originalEnvironment = { ...process.env };

const restoreEnvironment = () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) {
      delete process.env[key];
    }
  }

  Object.assign(process.env, originalEnvironment);
};

describe("Twilio signature release coverage ratchet", () => {
  afterEach(() => {
    restoreEnvironment();
    jest.restoreAllMocks();
  });

  test("uses the empty-string fallback when webhook validation flag is absent", async () => {
    process.env.NODE_ENV = "development";

    delete process.env.TWILIO_VALIDATE_WEBHOOKS;
    delete process.env.TWILIO_AUTH_TOKEN;

    const next = jest.fn();
    const res = makeResponse();

    const req = {
      headers: {},
      body: {},
      originalUrl: "/api/twilio/sms",
      protocol: "http",
      get: jest.fn(() => undefined),
    };

    await validateTwilioSignature(
      req,
      res,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test("falls back to req.protocol and req.get host when forwarded headers are absent", async () => {
    process.env.NODE_ENV = "production";
    process.env.TWILIO_VALIDATE_WEBHOOKS = "true";
    process.env.TWILIO_AUTH_TOKEN =
      "callbackiq-release-twilio-test-token";

    delete process.env.TWILIO_WEBHOOK_BASE_URL;

    const signature =
      "intentionally-invalid-twilio-signature";

    const next = jest.fn();
    const res = makeResponse();

    const req = {
      headers: {
        "x-twilio-signature": signature,
      },

      originalUrl: "/api/twilio/sms",
      protocol: "https",

      body: {
        From: "+14045550000",
        To: "+14045551111",
        Body: "coverage test",
      },

      get(name) {
        const normalized =
          String(name || "").toLowerCase();

        if (normalized === "host") {
          return "api.callbackiq.test";
        }

        if (
          normalized ===
          "x-twilio-signature"
        ) {
          return signature;
        }

        return undefined;
      },
    };

    await validateTwilioSignature(
      req,
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();

    expect(res.status).toHaveBeenCalledWith(
      403,
    );
  });
});
