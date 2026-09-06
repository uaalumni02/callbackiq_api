import { buildSmsRecoveryVoicePrompt } from "../../src/voice/smsRecoveryVoicePrompt.service.js";

describe("SMS recovery voice prompt", () => {
  test("names the business and promises a text only after a successful send", () => {
    const prompt = buildSmsRecoveryVoicePrompt({
      businessName: "Atlanta Pro Plumbing & Drain",
      smsEnabled: true,
      smsStatus: "sent",
    });

    expect(prompt).toContain("Atlanta Pro Plumbing &amp; Drain");
    expect(prompt).toContain("A text message is on its way now");
    expect(prompt).toContain("Please reply with the service you need");
  });

  test("does not promise a text when the recipient is suppressed", () => {
    const prompt = buildSmsRecoveryVoicePrompt({
      businessName: "Atlanta Pro Plumbing & Drain",
      smsEnabled: true,
      smsStatus: "suppressed",
    });

    expect(prompt).toContain("Atlanta Pro Plumbing &amp; Drain");
    expect(prompt).toContain("unable to send a text to this number");
    expect(prompt).not.toContain("on its way");
  });

  test("uses a delivery-failure message when SMS is enabled but not sent", () => {
    const prompt = buildSmsRecoveryVoicePrompt({
      businessName: "Atlanta Pro Plumbing",
      smsEnabled: true,
      smsStatus: "failed",
    });

    expect(prompt).toContain("unable to send the text");
    expect(prompt).toContain("response timing is not guaranteed");
    expect(prompt).not.toContain("on its way");
  });

  test("uses a notification-only message when SMS is disabled", () => {
    const prompt = buildSmsRecoveryVoicePrompt({
      businessName: "Atlanta Pro Plumbing",
      smsEnabled: false,
      smsStatus: "disabled",
    });

    expect(prompt).toContain("Thank you for calling Atlanta Pro Plumbing");
    expect(prompt).toContain("response timing is not guaranteed");
    expect(prompt).not.toContain("text message is on its way");
  });

  test.each([
    ["sent", true],
    ["suppressed", true],
    ["failed", true],
    ["disabled", false],
  ])(
    "never makes an unverified staff-response promise for %s recovery",
    (smsStatus, smsEnabled) => {
      const prompt = buildSmsRecoveryVoicePrompt({
        businessName: "Atlanta Pro Plumbing",
        smsEnabled,
        smsStatus,
      });

      expect(prompt).toContain("response timing is not guaranteed");
      expect(prompt).not.toMatch(
        /will follow up|as soon as possible|will contact|will call/i,
      );
    },
  );

  test("covers missing optional metadata without creating a commitment", () => {
    const prompt = buildSmsRecoveryVoicePrompt({
      businessName: "",
      smsEnabled: false,
      smsStatus: null,
    });

    expect(prompt).toContain("Thank you for calling the business");
    expect(prompt).toContain("response timing is not guaranteed");
    expect(prompt).not.toMatch(
      /will follow up|as soon as possible|will contact|will call/i,
    );
  });

  test("covers default arguments safely", () => {
    const prompt = buildSmsRecoveryVoicePrompt();

    expect(prompt).toContain("Thank you for calling the business");
    expect(prompt).toContain("response timing is not guaranteed");
    expect(prompt).not.toMatch(
      /will follow up|as soon as possible|will contact|will call/i,
    );
  });

  test("escapes business names before inserting them into TwiML", () => {
    const prompt = buildSmsRecoveryVoicePrompt({
      businessName: 'A & B <Home> "Services"',
      smsEnabled: false,
      smsStatus: "disabled",
    });

    expect(prompt).toContain(
      "A &amp; B &lt;Home&gt; &quot;Services&quot;",
    );
    expect(prompt).not.toContain("A & B <Home>");
  });
});
