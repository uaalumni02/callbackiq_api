import {
  buildTwilioWebhookUrls,
} from "../../src/services/twilioWebhookReliability.service.js";

describe("Twilio webhook reliability configuration", () => {
  test("adds retry connection overrides and separate fallback URLs", () => {
    const urls = buildTwilioWebhookUrls(
      "https://api.callbackiq.example",
      {},
    );

    expect(urls.voiceUrl).toContain("/api/twilio/voice#");
    expect(urls.voiceUrl).toContain("tt=14000");
    expect(urls.voiceUrl).toContain("rp=ct,rt,5xx");
    expect(urls.smsUrl).toContain("/api/twilio/sms#");
    expect(urls.smsUrl).toContain("rc=2");
    expect(urls.smsFallbackUrl).toContain(
      "/api/twilio/sms-fallback#",
    );
    expect(urls.voiceFallbackUrl).toContain(
      "/api/twilio/voice-fallback#",
    );
  });

  test("supports a separate HTTPS fallback origin", () => {
    const urls = buildTwilioWebhookUrls(
      "https://api.callbackiq.example",
      {
        TWILIO_FALLBACK_WEBHOOK_BASE_URL:
          "https://fallback.callbackiq.example",
      },
    );

    expect(urls.smsFallbackUrl).toContain(
      "https://fallback.callbackiq.example/api/twilio/sms-fallback#",
    );
    expect(urls.voiceFallbackUrl).toContain(
      "https://fallback.callbackiq.example/api/twilio/voice-fallback#",
    );
  });

  test("allows explicit production override policies", () => {
    const urls = buildTwilioWebhookUrls(
      "https://api.callbackiq.example",
      {
        TWILIO_SMS_WEBHOOK_OVERRIDES:
          "ct=1000&rt=3000&tt=9000&rc=1&rp=all",
      },
    );

    expect(urls.smsUrl).toBe(
      "https://api.callbackiq.example/api/twilio/sms#ct=1000&rt=3000&tt=9000&rc=1&rp=all",
    );
  });

  test("rejects non-HTTPS bases", () => {
    expect(() =>
      buildTwilioWebhookUrls("http://localhost:3000", {}),
    ).toThrow(/HTTPS/i);
  });
});
