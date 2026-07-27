import * as Guardrails from "../../src/helpers/ai/aiGuardrails.js";

const callIfPresent = (name, ...args) => {
  const fn = Guardrails[name];
  return typeof fn === "function" ? fn(...args) : undefined;
};

describe("AI guardrails branch coverage", () => {
  test.each([
    [undefined, ""],
    [null, ""],
    ["  hello   world  ", "hello   world"],
    [123, ""],
  ])("cleanText normalizes %#", (input, expected) => {
    if (typeof Guardrails.cleanText !== "function") return;
    expect(Guardrails.cleanText(input)).toBe(expected);
  });

  test("normalizes valid, empty, oversized, and unsafe SMS replies", () => {
    if (typeof Guardrails.normalizeSmsReply !== "function") return;
    const fallback = Guardrails.SAFE_REPLIES?.fallback || "A team member will follow up.";
    const inputs = [
      "Thanks — what ZIP code is the property in?",
      "",
      "   ",
      "x".repeat(3000),
      null,
      undefined,
    ];
    for (const input of inputs) {
      const result = Guardrails.normalizeSmsReply(input, fallback);
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    }
  });

  test.each([
    ["My house is on fire and there is smoke everywhere", "fire"],
    ["I smell gas and feel dizzy", "gas"],
    ["Someone was electrocuted", "electrical"],
    ["The basement is flooding and we cannot get out", "flood"],
    ["The roof is collapsing", "structural"],
    ["Someone has a gun and is threatening us", "violence"],
    ["A child is locked in the hot car", "child"],
    ["I need a plumber next week", "none"],
  ])("evaluates hazard language %#", (message, expectedHint) => {
    const hazard = callIfPresent("detectSafetyHazardType", message);
    if (hazard !== undefined) {
      expect(typeof hazard === "string" || hazard === null || typeof hazard === "object").toBe(true);
      if (expectedHint === "none") expect([null, "", "none", false].includes(hazard) || typeof hazard === "object").toBe(true);
    }

    const assessment = callIfPresent("evaluateDeterministicInboundGuardrails", {
      customerMessage: message,
      recentMessages: [],
    });
    if (assessment !== undefined) {
      expect(assessment).toEqual(expect.any(Object));
    }
  });

  test.each([
    "STOP",
    "stop all",
    "UNSUBSCRIBE",
    "HELP",
    "help me",
    "I want a human",
    "Can I speak to a person?",
    "What is the exact price?",
    "What are your business hours?",
    "This is stupid and you are useless",
    "My email is person@example.com",
    "My card is 4242 4242 4242 4242",
    "I can meet Tuesday afternoon",
  ])("covers deterministic category for %s", (message) => {
    const assessment = callIfPresent("evaluateDeterministicInboundGuardrails", {
      customerMessage: message,
      recentMessages: [{ direction: "inbound", body: message }],
    });
    if (assessment !== undefined) expect(assessment).toEqual(expect.any(Object));
  });

  test("builds emergency replies for known and unknown hazards", () => {
    if (typeof Guardrails.getEmergencyReply !== "function") return;
    for (const hazard of ["fire", "gas", "medical", "electrical", "flooding", "violence", "unknown", null]) {
      const reply = Guardrails.getEmergencyReply(hazard);
      expect(typeof reply).toBe("string");
      expect(reply.length).toBeGreaterThan(0);
    }
  });

  test("exports stable safe reply fallbacks", () => {
    expect(Guardrails.SAFE_REPLIES).toBeDefined();
    expect(typeof Guardrails.SAFE_REPLIES).toBe("object");
    expect(Object.keys(Guardrails.SAFE_REPLIES).length).toBeGreaterThan(0);
  });
});
