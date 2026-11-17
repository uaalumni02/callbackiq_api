import { safeConsole } from "../helpers/logging/safeLogger.js";
import { validateTwilioRequestWithRotation } from "../services/twilioSignatureRotation.service.js";

const isValidationDisabled = () => process.env.NODE_ENV === 'test';

const getFirstHeaderValue = (value) =>
  typeof value === "string" ? value.split(",")[0].trim() : "";

const getWebhookUrl = (req) => {
  const configuredBaseUrl = String(process.env.TWILIO_WEBHOOK_BASE_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (configuredBaseUrl) return `${configuredBaseUrl}${req.originalUrl}`;

  const forwardedProtocol = getFirstHeaderValue(req.headers["x-forwarded-proto"]);
  const forwardedHost = getFirstHeaderValue(req.headers["x-forwarded-host"]);
  const protocol = forwardedProtocol || req.protocol;
  const host = forwardedHost || req.get("host");
  return `${protocol}://${host}${req.originalUrl}`;
};

const validateTwilioSignature = (req, res, next) => {
  if (isValidationDisabled()) return next();

  const hasAuthToken = [
    process.env.TWILIO_AUTH_TOKEN,
    process.env.TWILIO_AUTH_TOKEN_NEXT,
    process.env.TWILIO_AUTH_TOKEN_PREVIOUS,
  ].some((value) => Boolean(String(value || "").trim()));

  if (!hasAuthToken) {
      safeConsole.error("A Twilio auth token is required to validate webhooks.");
      return res.status(503).json({
        success: false,
        message: "Twilio webhook validation is not configured.",
      });
  }

  const signature = req.get("x-twilio-signature");
  if (!signature) {
    return res.status(403).json({ success: false, message: "Invalid Twilio webhook signature." });
  }

  const isValid = validateTwilioRequestWithRotation({
    signature,
    url: getWebhookUrl(req),
    params: req.body || {},
  });
  if (!isValid) {
    safeConsole.warn("Rejected Twilio webhook with an invalid signature", {
      path: req.originalUrl,
    });
    return res.status(403).json({ success: false, message: "Invalid Twilio webhook signature." });
  }
  return next();
};

export { getWebhookUrl, isValidationDisabled };
export default validateTwilioSignature;
