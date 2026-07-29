import { assessInboundSafety } from "../../src/services/safetyAssessmentService.js";

describe("safetyAssessmentService Phase 9 compatibility", () => {
  test("uses the existing deterministic guardrails for a voice emergency", async () => {
    const result = await assessInboundSafety({
      customerMessage: "I smell gas and someone passed out.",
      allowAIClassifier: false,
    });

    expect(result).toMatchObject({
      isEmergency: true,
      shouldSendSafetyReply: true,
      shouldAlertOwner: true,
      alertPriority: "critical",
      source: "deterministic",
      confidence: 100,
    });
    expect(result.hazardType).toBeTruthy();
    expect(result.reply).toMatch(/911|emergency|danger/i);
  });

  test("does not escalate a routine service request", async () => {
    const result = await assessInboundSafety({
      customerMessage: "I need help scheduling a drain cleaning.",
      allowAIClassifier: false,
    });

    expect(result).toMatchObject({
      isEmergency: false,
      shouldSendSafetyReply: false,
      shouldAlertOwner: false,
      source: "deterministic",
    });
  });
});
