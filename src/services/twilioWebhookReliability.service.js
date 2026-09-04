const normalizeBaseUrl = (value) =>
  String(value || "")
    .trim()
    .replace(/\/+$/, "");

const withOverrides = (url, fragment) =>
  fragment ? `${url}#${fragment}` : url;

// Keep total budgets below Twilio's hard 15-second ceiling for call-related
// requests. SMS/status retries are additional redundancy; durable DB ingress
// remains the primary recovery mechanism.
export const DEFAULT_TWILIO_VOICE_WEBHOOK_OVERRIDES =
  "ct=1500&rt=5000&tt=14000&rc=1&rp=ct,rt,5xx";
export const DEFAULT_TWILIO_SMS_WEBHOOK_OVERRIDES =
  "ct=1500&rt=5000&tt=12000&rc=2&rp=ct,rt,5xx";
export const DEFAULT_TWILIO_STATUS_WEBHOOK_OVERRIDES =
  "ct=1500&rt=5000&tt=12000&rc=2&rp=ct,rt,5xx";
export const DEFAULT_TWILIO_FALLBACK_OVERRIDES =
  "ct=1500&rt=5000&tt=12000&rc=0";

export const buildTwilioWebhookUrls = (
  baseUrl,
  env = process.env,
) => {
  const base = normalizeBaseUrl(baseUrl);
  if (!/^https:\/\//i.test(base)) {
    const error = new Error(
      "A public HTTPS Twilio webhook base URL is required.",
    );
    error.code = "TWILIO_WEBHOOK_BASE_URL_REQUIRED";
    throw error;
  }

  const fallbackBase = normalizeBaseUrl(
    env.TWILIO_FALLBACK_WEBHOOK_BASE_URL || base,
  );
  if (!/^https:\/\//i.test(fallbackBase)) {
    const error = new Error(
      "TWILIO_FALLBACK_WEBHOOK_BASE_URL must be HTTPS when configured.",
    );
    error.code = "TWILIO_FALLBACK_WEBHOOK_BASE_URL_INVALID";
    throw error;
  }

  const voiceOverrides = String(
    env.TWILIO_VOICE_WEBHOOK_OVERRIDES ||
      DEFAULT_TWILIO_VOICE_WEBHOOK_OVERRIDES,
  ).trim();
  const smsOverrides = String(
    env.TWILIO_SMS_WEBHOOK_OVERRIDES ||
      DEFAULT_TWILIO_SMS_WEBHOOK_OVERRIDES,
  ).trim();
  const statusOverrides = String(
    env.TWILIO_STATUS_WEBHOOK_OVERRIDES ||
      DEFAULT_TWILIO_STATUS_WEBHOOK_OVERRIDES,
  ).trim();
  const fallbackOverrides = String(
    env.TWILIO_FALLBACK_WEBHOOK_OVERRIDES ||
      DEFAULT_TWILIO_FALLBACK_OVERRIDES,
  ).trim();

  return {
    voiceUrl: withOverrides(
      `${base}/api/twilio/voice`,
      voiceOverrides,
    ),
    voiceFallbackUrl: withOverrides(
      `${fallbackBase}/api/twilio/voice-fallback`,
      fallbackOverrides,
    ),
    smsUrl: withOverrides(
      `${base}/api/twilio/sms`,
      smsOverrides,
    ),
    smsFallbackUrl: withOverrides(
      `${fallbackBase}/api/twilio/sms-fallback`,
      fallbackOverrides,
    ),
    statusCallback: withOverrides(
      `${base}/api/twilio/status`,
      statusOverrides,
    ),
  };
};

export default {
  buildTwilioWebhookUrls,
};
