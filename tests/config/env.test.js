import {
  resetRuntimeConfigForTests,
  validateEnvironment,
} from "../../src/config/env.js";

const base = {
  APP_ENV: "development",
  MONGODB_URI: "mongodb://127.0.0.1:27017/callbackiq_test",
  JWT_SECRET: "a".repeat(32),
  CLIENT_URL: "http://localhost:3001",
  PUBLIC_API_URL: "http://localhost:3000",
  ALLOWED_ORIGINS: "http://localhost:3001",
};

afterEach(() => {
  resetRuntimeConfigForTests();
});

describe("Phase 1 environment validation", () => {
  test("accepts a safe development environment", () => {
    const result = validateEnvironment(base, { throwOnError: false });
    expect(result.valid).toBe(true);
  });

  test("rejects localhost production URLs and missing providers", () => {
    const result = validateEnvironment(
      {
        ...base,
        APP_ENV: "production",
      },
      { throwOnError: false },
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/localhost/i);
    expect(result.errors.join(" ")).toMatch(/TWILIO_ACCOUNT_SID/);
  });

  test("rejects unsigned provider webhooks in staging", () => {
    const result = validateEnvironment(
      {
        ...base,
        APP_ENV: "staging",
        CLIENT_URL: "https://staging.callbackiq.com",
        PUBLIC_API_URL: "https://api-staging.callbackiq.com",
        TWILIO_WEBHOOK_BASE_URL: "https://api-staging.callbackiq.com",
        ALLOWED_ORIGINS: "https://staging.callbackiq.com",
        TWILIO_ACCOUNT_SID: "AC_test",
        TWILIO_AUTH_TOKEN: "token",
        STRIPE_SECRET_KEY: "sk_test_example",
        STRIPE_WEBHOOK_SECRET: "whsec_example",
        OPENAI_API_KEY: "openai-example",
        ALLOW_UNSIGNED_PROVIDER_WEBHOOKS: "true",
      },
      { throwOnError: false },
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/unsigned/i);
  });
});
