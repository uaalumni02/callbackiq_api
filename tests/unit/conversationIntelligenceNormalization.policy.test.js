import fs from "node:fs";
import {
  cleanString, prepareAnalysisNormalization, mapAnalysisActionToReplyAction,
  finalizeAnalysisNormalization, withAnalysisModel, validateMeaningfulAnalysis,
} from "../../src/services/conversationIntelligenceNormalization.policy.js";
import { normalizationCases, validAnalysis } from "../fixtures/conversationIntelligence/normalizationCases.js";

const expected = JSON.parse(fs.readFileSync("tests/fixtures/conversationIntelligence/characterization.json", "utf8"));
const unvaluedRevenue = { minimum: null, maximum: null, likely: null, currency: "USD", confidence: 0, basis: "Not estimated" };
const cases = normalizationCases().filter(fixture => !fixture.errorMode && typeof expected[fixture.name]?.output?.summary === "string");

test.each(cases)("pure phases reproduce the frozen normalization fields: $name", fixture => {
  const baseline = expected[fixture.name];
  const guardrailResult = baseline.trace.find(record => record.fn === "sanitizeOutboundReply").result;
  const before = JSON.stringify({ analysis: fixture.analysis, guardrailResult });
  const prepared = prepareAnalysisNormalization(fixture.analysis);
  const normalized = finalizeAnalysisNormalization(fixture.analysis, prepared, guardrailResult);
  const result = withAnalysisModel(normalized, { modelUsed: baseline.output.modelUsed });
  expect(result).toEqual({ ...baseline.output, estimatedRevenue: unvaluedRevenue });
  expect(JSON.stringify({ analysis: fixture.analysis, guardrailResult })).toBe(before);
  expect(withAnalysisModel(finalizeAnalysisNormalization(fixture.analysis, prepareAnalysisNormalization(fixture.analysis), guardrailResult),
    { modelUsed: baseline.output.modelUsed })).toEqual(result);
  expect(result).not.toBeInstanceOf(Promise);
  expect(() => validateMeaningfulAnalysis(result)).not.toThrow();
});

test.each([undefined, null, {}])("missing analysis has conservative fields and retains validation failure: %s", analysis => {
  const prepared = prepareAnalysisNormalization(analysis);
  expect(prepared).toEqual({ buyingScore: 0, appointmentScore: 0, urgencyLevel: "unknown", actionType: "none" });
  const result = finalizeAnalysisNormalization(analysis, prepared, { reply: "Safe reply", usedFallback: false, violations: [] });
  expect(result.sentiment.score).toBe(-1);
  expect(result.nextBestAction.recommendedWithinMinutes).toBe(0);
  expect(result.estimatedRevenue).toEqual(unvaluedRevenue);
  expect(() => validateMeaningfulAnalysis(result)).toThrow("AI conversation analysis was incomplete: summary is missing");
});

test.each([NaN, Infinity, -Infinity, "not numeric"])("non-finite percentage inputs retain zero fallback: %s", score => {
  expect(prepareAnalysisNormalization({ buyingLikelihood: { score }, appointmentProbability: { score } }))
    .toMatchObject({ buyingScore: 0, appointmentScore: 0 });
});

test.each([
  ["collect_appointment_preference", "collect_appointment_preference"],
  ["request_information", "request_information"], ["call_now", "acknowledge"], ["none", "acknowledge"],
])("maps analysis action %s to guardrail action %s", (input, output) => {
  expect(mapAnalysisActionToReplyAction(input)).toBe(output);
});

test.each([
  [{ summary: "", nextBestAction: { action: "" } }, "summary is missing, next best action is missing"],
  [{ summary: "Present", nextBestAction: { action: "" } }, "next best action is missing"],
])("meaningful-analysis validation retains all error branches", (input, detail) => {
  expect(() => validateMeaningfulAnalysis(input)).toThrow(`AI conversation analysis was incomplete: ${detail}`);
});

test("metadata uses explicit configuration and leaves its inputs unchanged", () => {
  const value = Object.freeze({ summary: "A result", analysisVersion: "1.1" });
  const config = Object.freeze({ modelUsed: "explicit-model" });
  expect(withAnalysisModel(value, config)).toEqual({ ...value, modelUsed: "explicit-model" });
  expect(value).not.toHaveProperty("modelUsed");
});

test("text trimming, non-string fallback and UTF-16 truncation retain existing semantics", () => {
  expect(cleanString("  text  ")).toBe("text");
  expect(cleanString(42, "fallback")).toBe("fallback");
  expect(cleanString("😀", "", 1)).toBe("\ud83d");
});

test("guardrail fallback reserves the tenth risk and preserves the violation reference", () => {
  const input = validAnalysis();
  input.riskFlags = Array.from({ length: 12 }, (_, i) => ({ type: "other", severity: "low", explanation: `Risk ${i}` }));
  const violations = ["unverified_booking", "unverified_price"];
  const result = finalizeAnalysisNormalization(input, prepareAnalysisNormalization(input),
    { reply: "Safe fallback", usedFallback: true, violations });
  expect(result.riskFlags).toHaveLength(10);
  expect(result.riskFlags[8].explanation).toBe("Risk 8");
  expect(result.riskFlags[9]).toEqual({ type: "unverified_commitment", severity: "medium",
    explanation: "The proposed customer message was replaced by an outbound guardrail: unverified_booking, unverified_price." });
  expect(result.nextBestAction.suggestedMessageGuardrail.violations).toBe(violations);
});
