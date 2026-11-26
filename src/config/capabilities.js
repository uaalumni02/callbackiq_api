import { emailConfiguration } from "../helpers/email/emailConfiguration.js";
const capabilities = [
  "signup",
  "billing",
  "sms",
  "voice",
  "google",
  "staff_notifications",
];
const required = {
  signup: ["TURNSTILE_SECRET_KEY", "TWILIO_VERIFY_SERVICE_SID"],
  billing: ["STRIPE_PRO_PRICE_ID", "STRIPE_BILLING_PORTAL_CONFIGURATION_ID"],
  sms: [
    "TWILIO_PRIMARY_CUSTOMER_PROFILE_SID",
    "A2P_NOTIFICATION_EMAIL",
    "A2P_EVENT_STREAM_USERNAME",
    "A2P_EVENT_STREAM_PASSWORD",
  ],
  voice: ["VOICE_WEBSOCKET_PUBLIC_URL"],
  google: ["INTEGRATION_ENCRYPTION_KEY", "OAUTH_STATE_SECRET"],
  staff_notifications: [],
};
/** Returns the explicit server capability set; unknown names fail validation. */
export function enabledCapabilities(source = process.env) {
  return new Set(
    String(source.MEEKCALL_ENABLED_CAPABILITIES ?? capabilities.join(","))
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}
const validateGoogleCapability = (source, enabled, present, errors) => {
  if (enabled.has("google")) {
    for (const [key, alias] of [
      ["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CLIENT_ID"],
      ["GOOGLE_CALENDAR_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET"],
      ["GOOGLE_CALENDAR_REDIRECT_URI", "GOOGLE_REDIRECT_URI"],
    ])
      if (!present(source[key] || source[alias]))
        errors.push(`${key} is required for enabled google`);
    if (
      source.INTEGRATION_ENCRYPTION_KEY &&
      String(source.INTEGRATION_ENCRYPTION_KEY).length < 32
    )
      errors.push(
        "INTEGRATION_ENCRYPTION_KEY must contain at least 32 characters",
      );
    if (
      source.OAUTH_STATE_SECRET &&
      String(source.OAUTH_STATE_SECRET).length < 24
    )
      errors.push("OAUTH_STATE_SECRET must contain at least 24 characters");
  }
};
/** Validates enabled capabilities before production startup; returns bounded config errors. */
export function validateCapabilityConfiguration(source, environment) {
  if (!["production", "staging"].includes(environment)) return [];
  const errors = [];
  if (
    source.PILOT_PROVIDER_DISPATCH_PAUSED &&
    !["true", "false"].includes(source.PILOT_PROVIDER_DISPATCH_PAUSED)
  )
    errors.push("PILOT_PROVIDER_DISPATCH_PAUSED must be true or false");
  const enabled = enabledCapabilities(source);
  const present = (value) =>
    Boolean(String(value || "").trim()) &&
    !/replace[-_ ]?me|changeme|<.*>/i.test(String(value));
  for (const name of enabled) {
    if (!capabilities.includes(name)) {
      errors.push(`Unknown MEEKCALL_ENABLED_CAPABILITIES value: ${name}`);
      continue;
    }
    for (const key of required[name])
      if (!present(source[key]))
        errors.push(`${key} is required for enabled ${name}`);
  }
  validateGoogleCapability(source, enabled, present, errors);
  if (
    (enabled.has("signup") || enabled.has("staff_notifications")) &&
    !emailConfiguration(source).configured
  )
    errors.push(
      "Configured SMTP or Gmail credentials are required for enabled email delivery",
    );
  if (enabled.has("staff_notifications"))
    for (const key of [
      "STAFF_NOTIFICATION_EMAIL_ENABLED",
      "STAFF_NOTIFICATION_SMS_ENABLED",
      "STAFF_APPROVAL_SMS_ENABLED",
    ])
      if (source[key] !== "true")
        errors.push(
          `${key} must be true for enabled staff_notifications during the pilot`,
        );
  if (
    enabled.has("voice") &&
    source.VOICE_WEBSOCKET_PUBLIC_URL &&
    !/^wss:\/\//.test(source.VOICE_WEBSOCKET_PUBLIC_URL)
  )
    errors.push("VOICE_WEBSOCKET_PUBLIC_URL must use WSS");
  return errors;
}
/** Refuses a globally disabled capability before any external side effect. */
export function assertCapabilityEnabled(name, source = process.env) {
  if (!enabledCapabilities(source).has(name))
    throw Object.assign(
      new Error("This capability is disabled for this deployment."),
      { code: "CAPABILITY_DISABLED", statusCode: 503 },
    );
}
