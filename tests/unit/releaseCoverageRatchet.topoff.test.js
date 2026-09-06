import jwt from "jsonwebtoken";
import User from "../../src/models/user.js";

import * as socketAuthModule from "../../src/middleware/socket-auth.js";
import * as twilioSignatureModule from "../../src/middleware/validate-twilio-signature.js";

import {
  buildUnconfiguredA2pState,
  toMessagingComplianceUpdate,
} from "../../src/services/a2pMessagingRegistration.service.js";

const resolveFunction = (module, candidates) => {
  for (const name of candidates) {
    if (typeof module?.[name] === "function") {
      return module[name];
    }
  }

  if (typeof module?.default === "function") {
    return module.default;
  }

  throw new Error(
    `Expected one of these middleware exports: ${candidates.join(", ")}`,
  );
};

const socketAuth = resolveFunction(socketAuthModule, [
  "socketAuth",
  "socketAuthMiddleware",
  "authenticateSocket",
  "authorizeSocket",
]);

const validateTwilioSignature = resolveFunction(
  twilioSignatureModule,
  [
    "validateTwilioSignature",
    "validateTwilioRequest",
    "validateTwilioWebhook",
  ],
);

const invokeSocketAuth = async (socket) => {
  const next = jest.fn();

  await socketAuth(socket, next);

  return next;
};

const makeResponse = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
  send: jest.fn().mockReturnThis(),
});

describe("release coverage ratchet top-off", () => {
  const originalEnvironment = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnvironment };
    jest.restoreAllMocks();
  });

  describe("A2P messaging registration coverage", () => {
    test("builds the explicit unconfigured state", () => {
      expect(buildUnconfiguredA2pState()).toMatchObject({
        a2pStatus: "unconfigured",
        campaignStatus: "",
        smsReady: false,
        senderAttached: false,
      });
    });

    test("maps an empty state using safe defaults", () => {
      const update = toMessagingComplianceUpdate();

      expect(update).toEqual(
        expect.objectContaining({
          "messagingCompliance.a2pStatus": "unconfigured",
          "messagingCompliance.campaignStatus": "",
          "messagingCompliance.smsReady": false,
          "messagingCompliance.senderAttached": false,
          "messagingCompliance.senderAttachedAt": null,
          "messagingCompliance.lastError": "",
        }),
      );

      expect(
        update["messagingCompliance.lastCheckedAt"],
      ).toBeInstanceOf(Date);
    });

    test("sanitizes an unknown provider error instead of leaking provider text", () => {
      const update = toMessagingComplianceUpdate({
        lastError:
          "UNKNOWN_PROVIDER_ERROR: secret provider diagnostic details",
      });

      const publicError =
        update["messagingCompliance.lastError"];

      expect(typeof publicError).toBe("string");
      expect(publicError.length).toBeGreaterThan(0);
      expect(publicError).not.toContain(
        "secret provider diagnostic details",
      );
    });

    test("handles a known code without a colon separator", () => {
      const update = toMessagingComplianceUpdate({
        lastError: "A2P_LINK_FAILED",
      });

      expect(
        typeof update["messagingCompliance.lastError"],
      ).toBe("string");
    });
  });

  describe("Socket authentication coverage", () => {
    test("ignores a cookie with an empty name", async () => {
      const next = await invokeSocketAuth({
        handshake: {
          auth: {},
          headers: {
            cookie: "=ignored",
          },
        },
        data: {},
      });

      expect(next).toHaveBeenCalled();
      expect(next.mock.calls[0][0]).toBeTruthy();
    });

    test("survives malformed percent encoding in a cookie", async () => {
      const next = await invokeSocketAuth({
        handshake: {
          auth: {},
          headers: {
            cookie: "token=%E0%A4%A",
          },
        },
        data: {},
      });

      expect(next).toHaveBeenCalled();
      expect(next.mock.calls[0][0]).toBeTruthy();
    });

    test("rejects a token after the persisted session version changes", async () => {
      const secret =
        "callbackiq-release-coverage-secret-12345678901234567890";

      process.env.JWT_SECRET = secret;

      const userId = "507f1f77bcf86cd799439011";

      const token = jwt.sign(
        {
          _id: userId,
          id: userId,
          userId,
          email: "owner@example.com",
          role: "owner",
          sessionVersion: 3,
        },
        secret,
        {
          expiresIn: "5m",
        },
      );

      const lean = jest.fn().mockResolvedValue({
        _id: userId,
        email: "owner@example.com",
        role: "owner",
        sessionVersion: 4,
      });

      const select = jest.fn().mockReturnValue({
        lean,
      });

      jest
        .spyOn(User, "findById")
        .mockReturnValue({
          select,
        });

      const next = await invokeSocketAuth({
        handshake: {
          auth: {
            token,
          },
          headers: {},
        },
        data: {},
      });

      expect(next).toHaveBeenCalledTimes(1);

      const error = next.mock.calls[0][0];

      expect(error).toBeTruthy();
      expect(error.data?.code).toBe(
        "SOCKET_SESSION_REVOKED",
      );
    });
  });

  describe("Twilio signature coverage", () => {
    test("supports explicitly disabled validation outside production", async () => {
      process.env.NODE_ENV = "development";
      process.env.TWILIO_VALIDATE_WEBHOOKS = "false";

      const next = jest.fn();
      const res = makeResponse();

      await validateTwilioSignature(
        {
          headers: {},
          body: undefined,
          originalUrl: "/api/twilio/sms",
          protocol: "https",
          get: jest.fn(),
        },
        res,
        next,
      );

      expect(next).toHaveBeenCalledTimes(1);
    });

    test("uses an empty parameter object when a signed request has no body", async () => {
      process.env.NODE_ENV = "production";
      process.env.TWILIO_VALIDATE_WEBHOOKS = "true";
      process.env.TWILIO_AUTH_TOKEN =
        "callbackiq-twilio-coverage-token";
      process.env.PUBLIC_API_URL =
        "https://api.callbackiq.test";

      const res = makeResponse();
      const next = jest.fn();

      const req = {
        headers: {
          host: "api.callbackiq.test",
          "x-twilio-signature":
            "intentionally-invalid-signature",
        },
        originalUrl: "/api/twilio/sms",
        protocol: "https",
        body: undefined,
        socket: {
          encrypted: true,
        },
        get(name) {
          const key = String(name).toLowerCase();

          if (key === "host") {
            return this.headers.host;
          }

          if (key === "x-twilio-signature") {
            return this.headers[
              "x-twilio-signature"
            ];
          }

          return undefined;
        },
      };

      await validateTwilioSignature(
        req,
        res,
        next,
      );

      expect(res.status).toHaveBeenCalled();
    });
  });
});
