import {
  assertTwilioProductionConfig,
} from "../../src/config/twilio-production-config.js";

describe("Twilio production configuration", () => {
  test("does not require the public base URL outside production", () => {
    expect(
      assertTwilioProductionConfig({
        NODE_ENV: "development",
      }),
    ).toEqual({
      production: false,
      webhookBaseUrl: "",
    });
  });

  test("fails closed when production is missing TWILIO_WEBHOOK_BASE_URL", () => {
    expect(() =>
      assertTwilioProductionConfig({
        NODE_ENV: "production",
      }),
    ).toThrow(/TWILIO_WEBHOOK_BASE_URL/i);
  });

  test("requires HTTPS in production", () => {
    expect(() =>
      assertTwilioProductionConfig({
        NODE_ENV: "production",
        TWILIO_WEBHOOK_BASE_URL: "http://api.example.com",
      }),
    ).toThrow(/public HTTPS/i);
  });

  test("accepts and normalizes a production HTTPS base URL", () => {
    expect(
      assertTwilioProductionConfig({
        NODE_ENV: "production",
        TWILIO_WEBHOOK_BASE_URL: "https://api.example.com/",
      }),
    ).toEqual({
      production: true,
      webhookBaseUrl: "https://api.example.com",
      fallbackWebhookBaseUrl: "",
    });
  });

  test("validates an optional fallback origin", () => {
    expect(() =>
      assertTwilioProductionConfig({
        NODE_ENV: "production",
        TWILIO_WEBHOOK_BASE_URL: "https://api.example.com",
        TWILIO_FALLBACK_WEBHOOK_BASE_URL: "http://fallback.example.com",
      }),
    ).toThrow(/FALLBACK_WEBHOOK_BASE_URL/i);

    expect(
      assertTwilioProductionConfig({
        NODE_ENV: "production",
        TWILIO_WEBHOOK_BASE_URL: "https://api.example.com",
        TWILIO_FALLBACK_WEBHOOK_BASE_URL: "https://fallback.example.com/",
      }),
    ).toMatchObject({
      fallbackWebhookBaseUrl: "https://fallback.example.com",
    });
  });
});
