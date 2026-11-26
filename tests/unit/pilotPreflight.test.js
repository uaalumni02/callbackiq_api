import { validateEnvironment } from "../../src/config/env.js";
const core = () => ({
  APP_ENV: "production",
  NODE_ENV: "production",
  MONGODB_URI: "mongodb://127.0.0.1/pilot",
  JWT_SECRET: "a".repeat(40),
  CLIENT_URL: "https://pilot.meekcall.com",
  PUBLIC_API_URL: "https://api.meekcall.com",
  TWILIO_ACCOUNT_SID: "AC" + "1".repeat(32),
  TWILIO_AUTH_TOKEN: "a".repeat(32),
  STRIPE_SECRET_KEY: "sk_live_inert_fixture",
  STRIPE_WEBHOOK_SECRET: "whsec_inert_fixture",
  OPENAI_API_KEY: "inert-fixture",
  MEEKCALL_ENABLED_CAPABILITIES:
    "signup,billing,sms,voice,google,staff_notifications",
});
test("H06 refuses enabled but unconfigured onboarding/billing/calendar/notification capabilities", () => {
  const result = validateEnvironment(core(), { throwOnError: false });
  expect(result.valid).toBe(false);
  for (const key of [
    "TURNSTILE_SECRET_KEY",
    "TWILIO_VERIFY_SERVICE_SID",
    "STRIPE_PRO_PRICE_ID",
    "STRIPE_BILLING_PORTAL_CONFIGURATION_ID",
    "INTEGRATION_ENCRYPTION_KEY",
    "VOICE_WEBSOCKET_PUBLIC_URL",
    "A2P_NOTIFICATION_EMAIL",
    "GOOGLE_CALENDAR_CLIENT_ID",
  ])
    expect(result.errors.join(" ")).toContain(key);
});
test("H06 validates only explicitly enabled capabilities and rejects unknown names", () => {
  expect(
    validateEnvironment(
      {
        ...core(),
        MEEKCALL_ENABLED_CAPABILITIES: "billing",
        STRIPE_PRO_PRICE_ID: "price_pilot",
        STRIPE_BILLING_PORTAL_CONFIGURATION_ID: "bpc_pilot",
      },
      { throwOnError: false },
    ).valid,
  ).toBe(true);
  expect(
    validateEnvironment(
      { ...core(), MEEKCALL_ENABLED_CAPABILITIES: "unknown" },
      { throwOnError: false },
    ).valid,
  ).toBe(false);
});
