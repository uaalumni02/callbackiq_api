import {
  buildMissedCallRecoveryText,
  ensureOptOutDisclosure,
  estimateSmsSegments,
  evaluateSmsSendWindow,
  isSoftOptOutPhrase,
  validateManualSmsBody,
} from "../../src/services/messaging/smsCompliance.service.js";

describe("SMS compliance policy", () => {
  test("adds STOP disclosure to the first recovery template", () => {
    expect(
      buildMissedCallRecoveryText({
        business: { businessName: "Atlanta Pro Plumbing", smsTemplate: "Hi from {{businessName}}. How can we help?" },
      }),
    ).toBe("Hi from Atlanta Pro Plumbing. How can we help? Reply STOP to opt out.");
    expect(ensureOptOutDisclosure("Reply STOP to opt out.")).toBe("Reply STOP to opt out.");
  });

  test.each([
    "Please stop texting me",
    "Don't contact this number again",
    "Take me off your list",
    "No more messages",
  ])("recognizes a natural-language opt-out: %s", (message) => {
    expect(isSoftOptOutPhrase(message)).toBe(true);
  });

  test("counts GSM-7 and Unicode segments", () => {
    expect(estimateSmsSegments("a".repeat(161))).toMatchObject({
      encoding: "GSM-7",
      segmentCount: 2,
    });
    expect(estimateSmsSegments("🙂".repeat(71))).toMatchObject({
      encoding: "UCS-2",
      segmentCount: 3,
    });
  });

  test("allows direct customer responses outside scheduled send hours", () => {
    expect(
      evaluateSmsSendWindow({
        business: { timezone: "America/New_York" },
        directResponse: true,
        now: new Date("2026-08-05T06:00:00Z"),
      }),
    ).toMatchObject({ allowed: true, bypassed: true });
  });

  test("blocks sensitive manual content", () => {
    expect(validateManualSmsBody("My password: secret123")).toMatchObject({
      allowed: false,
      reason: "sensitive_data",
    });
  });
});
