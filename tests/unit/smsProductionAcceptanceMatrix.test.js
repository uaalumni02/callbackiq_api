import matrix from "../fixtures/smsProductionAcceptanceMatrix.js";
import { applySmsProductionInvariants } from "../../src/services/messaging/smsProductionInvariant.service.js";

const normalize = (value) => String(value || "").toLowerCase();

const expressesUnconfirmedAppointment = (value) => {
  const text = normalize(value).replace(/\s+/g, " ").trim();
  return [
    /\bnot (?:a )?confirmed appointment\b/,
    /\b(?:the )?appointment (?:is|remains) not confirmed\b/,
    /\bno appointment is confirmed\b/,
    /\b(?:the )?appointment (?:has not|hasn't) been confirmed\b/,
    /\bbooking (?:is|remains) not confirmed\b/,
  ].some((pattern) => pattern.test(text));
};

const categoryCounts = () =>
  matrix.reduce((acc, scenario) => {
    acc[scenario.category] = (acc[scenario.category] || 0) + 1;
    return acc;
  }, {});

describe("SMS production acceptance matrix", () => {
  test("keeps the fixed release corpus between 75 and 150 representative cases", () => {
    expect(matrix.length).toBeGreaterThanOrEqual(75);
    expect(matrix.length).toBeLessThanOrEqual(150);
  });

  test("covers every production invariant class", () => {
    expect(categoryCounts()).toEqual(
      expect.objectContaining({
        false_commitment: expect.any(Number),
        known_fact_reask: expect.any(Number),
        unsupported_service: expect.any(Number),
        staff_review_boundary: expect.any(Number),
        multi_intent: expect.any(Number),
        callback_continuity: expect.any(Number),
        safe_ambiguity: expect.any(Number),
        safety_dedupe: expect.any(Number),
      }),
    );
  });

  test.each(matrix)("$id [$category]", (scenario) => {
    const result = applySmsProductionInvariants({
      result: scenario.result,
      business: scenario.business,
      lead: scenario.lead,
      conversation: scenario.conversation,
      customerMessage: scenario.customerMessage,
      now: new Date("2026-09-21T16:00:00-04:00"),
    });

    const reply = normalize(result.reply);
    expect(result.guardrail?.productionInvariantApplied).toBe(true);

    for (const required of scenario.expect?.requires || []) {
      expect(reply).toContain(normalize(required));
    }

    for (const forbidden of scenario.expect?.forbids || []) {
      expect(reply).not.toContain(normalize(forbidden));
    }

    if (scenario.expect?.unconfirmedAppointment === true) {
      expect(expressesUnconfirmedAppointment(reply)).toBe(true);
    }

    for (const group of scenario.expect?.requiresAny || []) {
      expect(group.some((candidate) => reply.includes(normalize(candidate)))).toBe(true);
    }

    if (Number.isFinite(scenario.expect?.max911)) {
      const matches = result.reply.match(/\b911\b/g) || [];
      expect(matches.length).toBeLessThanOrEqual(scenario.expect.max911);
    }
  });
});
