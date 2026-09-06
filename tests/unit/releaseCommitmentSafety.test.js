import {
  buildSmsRecoveryVoicePrompt,
} from "../../src/voice/smsRecoveryVoicePrompt.service.js";
import {
  hasUnverifiedStaffCommitment,
} from "../../src/services/customerCommitmentSafety.service.js";

describe("release invariant: missed-call voice never promises staff response", () => {
  test.each([
    ["sent", true],
    ["suppressed", true],
    ["failed", true],
    ["disabled", false],
  ])("%s recovery prompt contains no unverified staff commitment", (smsStatus, smsEnabled) => {
    const prompt = buildSmsRecoveryVoicePrompt({
      businessName: "Atlanta Pro Plumbing & Drain",
      smsEnabled,
      smsStatus,
    });

    expect(prompt).toContain("Atlanta Pro Plumbing &amp; Drain");
    expect(prompt).not.toMatch(/will follow up|follow up as soon as possible|will call|will contact/i);
    expect(hasUnverifiedStaffCommitment(prompt)).toBe(false);
  });
});
