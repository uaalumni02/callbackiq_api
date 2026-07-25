import twilio from "twilio";

import { isSmsSuppressed } from "./messaging/contactPreference.service.js";

let twilioClient = null;
let cachedAccountSid = "";
let cachedAuthToken = "";

const getTwilioCredentials = () => {
  const accountSid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
  const authToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim();

  if (!accountSid) {
    throw new Error("TWILIO_ACCOUNT_SID is not configured");
  }

  if (!authToken) {
    throw new Error("TWILIO_AUTH_TOKEN is not configured");
  }

  return {
    accountSid,
    authToken,
  };
};

const getTwilioClient = () => {
  const { accountSid, authToken } = getTwilioCredentials();

  /*
   * Initialize lazily so tests and startup scripts can set environment
   * variables after importing the module.
   */
  if (
    !twilioClient ||
    accountSid !== cachedAccountSid ||
    authToken !== cachedAuthToken
  ) {
    twilioClient = twilio(accountSid, authToken);
    cachedAccountSid = accountSid;
    cachedAuthToken = authToken;
  }

  return twilioClient;
};

const normalizeRequiredText = (value, fieldName) => {
  const normalizedValue = String(value || "").trim();

  if (!normalizedValue) {
    throw new Error(`${fieldName} is required to send an SMS`);
  }

  return normalizedValue;
};

export const sendSms = async ({
  to,
  from,
  body,
  businessId = null,
  allowOptedOut = false,
}) => {
  const normalizedTo = normalizeRequiredText(to, "to");
  const normalizedFrom = normalizeRequiredText(from, "from");
  const normalizedBody = normalizeRequiredText(body, "body");

  /*
   * Automated workflows must include businessId so local STOP preferences are
   * enforced. Command confirmations such as STOP, START, and HELP may pass
   * allowOptedOut=true.
   */
  if (businessId && !allowOptedOut) {
    const suppressed = await isSmsSuppressed({
      businessId,
      phone: normalizedTo,
    });

    if (suppressed) {
      return {
        sid: "",
        status: "suppressed",
        suppressed: true,
        reason: "customer_opted_out",
        to: normalizedTo,
        from: normalizedFrom,
      };
    }
  }

  const client = getTwilioClient();

  return client.messages.create({
    to: normalizedTo,
    from: normalizedFrom,
    body: normalizedBody,
  });
};

export const resetTwilioClient = () => {
  twilioClient = null;
  cachedAccountSid = "";
  cachedAuthToken = "";
};

export { getTwilioClient };
