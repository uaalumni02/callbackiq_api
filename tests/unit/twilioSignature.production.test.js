import { validateTwilioRequestWithRotation } from "../../src/services/twilioSignatureRotation.service.js";
import validateTwilioSignature, {
  isValidationDisabled,
} from "../../src/middleware/validate-twilio-signature.js";

jest.mock("../../src/services/twilioSignatureRotation.service.js", () => ({
  __esModule: true,
  validateTwilioRequestWithRotation: jest.fn(),
}));

const response = () => {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
};

test("TWILIO_VALIDATE_WEBHOOKS=false cannot disable production validation", () => {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    validateWebhooks: process.env.TWILIO_VALIDATE_WEBHOOKS,
    authToken: process.env.TWILIO_AUTH_TOKEN,
  };
  process.env.NODE_ENV = "production";
  process.env.TWILIO_VALIDATE_WEBHOOKS = "false";
  process.env.TWILIO_AUTH_TOKEN = "token";
  expect(isValidationDisabled()).toBe(false);

  validateTwilioRequestWithRotation.mockReturnValue(false);
  const req = {
    body: {},
    headers: {},
    originalUrl: "/api/twilio/sms",
    protocol: "https",
    get: jest.fn((name) =>
      name === "x-twilio-signature" ? "bad" : "api.example.com",
    ),
  };
  const res = response();
  const next = jest.fn();
  validateTwilioSignature(req, res, next);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(next).not.toHaveBeenCalled();
  if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previous.nodeEnv;
  if (previous.validateWebhooks === undefined) delete process.env.TWILIO_VALIDATE_WEBHOOKS;
  else process.env.TWILIO_VALIDATE_WEBHOOKS = previous.validateWebhooks;
  if (previous.authToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
  else process.env.TWILIO_AUTH_TOKEN = previous.authToken;
});
