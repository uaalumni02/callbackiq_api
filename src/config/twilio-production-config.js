const requiredHttpsBaseUrl = (value) => {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }

  if (parsed.protocol !== "https:") return "";
  if (!parsed.hostname) return "";
  if (parsed.hash) return "";
  return raw;
};

export const assertTwilioProductionConfig = (env = process.env) => {
  if (String(env.NODE_ENV || "").toLowerCase() !== "production") {
    return {
      production: false,
      webhookBaseUrl: String(env.TWILIO_WEBHOOK_BASE_URL || "")
        .trim()
        .replace(/\/+$/, ""),
    };
  }

  const webhookBaseUrl = requiredHttpsBaseUrl(
    env.TWILIO_WEBHOOK_BASE_URL,
  );
  if (!webhookBaseUrl) {
    const error = new Error(
      "Production requires TWILIO_WEBHOOK_BASE_URL to be a valid public HTTPS base URL.",
    );
    error.code = "TWILIO_WEBHOOK_BASE_URL_REQUIRED";
    throw error;
  }

  const fallbackWebhookBaseUrl = env.TWILIO_FALLBACK_WEBHOOK_BASE_URL
    ? requiredHttpsBaseUrl(env.TWILIO_FALLBACK_WEBHOOK_BASE_URL)
    : "";
  if (env.TWILIO_FALLBACK_WEBHOOK_BASE_URL && !fallbackWebhookBaseUrl) {
    const error = new Error(
      "TWILIO_FALLBACK_WEBHOOK_BASE_URL must be a valid HTTPS base URL when configured.",
    );
    error.code = "TWILIO_FALLBACK_WEBHOOK_BASE_URL_INVALID";
    throw error;
  }

  return {
    production: true,
    webhookBaseUrl,
    fallbackWebhookBaseUrl,
  };
};

export default {
  assertTwilioProductionConfig,
};
