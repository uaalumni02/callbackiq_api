import {
  assertExternalProviderUrlAllowed,
  isBlockedProviderHost,
} from "../setup/externalProviderSafety.js";

describe("external provider test-safety guard", () => {
  test.each([
    "api.twilio.com",
    "messaging.twilio.com",
    "events.twilio.com",
    "api.stripe.com",
    "api.openai.com",
    "www.googleapis.com",
    "oauth2.googleapis.com",
    "api.resend.com",
    "smtp.gmail.com",
  ])("blocks %s", (hostname) => {
    expect(isBlockedProviderHost(hostname)).toBe(true);
  });

  test.each([
    "127.0.0.1",
    "localhost",
    "::1",
    "callbackiq.test",
  ])("does not block local/non-provider host %s", (hostname) => {
    expect(isBlockedProviderHost(hostname)).toBe(false);
  });

  test("fails before a live Twilio fetch can leave the test process", async () => {
    await expect(
      fetch("https://api.twilio.com/2010-04-01/Accounts.json"),
    ).rejects.toMatchObject({
      code: "EXTERNAL_PROVIDER_NETWORK_BLOCKED",
      hostname: "api.twilio.com",
    });
  });

  test("allows relative application URLs", () => {
    expect(() =>
      assertExternalProviderUrlAllowed("/api/appointments"),
    ).not.toThrow();
  });
});
