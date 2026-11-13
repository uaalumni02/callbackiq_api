// Plain provider inputs used to freeze behavior before the extraction at a41bd09.
export const business = {
  _id: "business-ci", businessName: "Cedar Plumbing", businessType: "plumbing",
  city: "Atlanta", state: "GA", features: { aiBookingEnabled: true },
};
export const conversation = { _id: "conversation-ci", status: "active", humanTakeover: false,
  customerName: "Alex", customerPhone: "+14045550123" };
export const messages = [
  { direction: "inbound", body: "Please repair my sink", createdAt: "2026-11-01T10:00:00.000Z" },
  { direction: "outbound", body: "Which address needs service?", createdAt: "2026-11-01T10:01:00.000Z" },
];
export const validAnalysis = () => ({
  summary: "Customer requests sink repair.",
  customerIntent: { primary: "Sink repair", category: "repair", serviceType: "Sink repair" },
  sentiment: { label: "neutral", score: 0.25, explanation: "Calm request" },
  buyingLikelihood: { score: 75, reasons: ["Requested service"] },
  appointmentProbability: { score: 50, reasons: ["Address needed"] },
  urgency: { level: "normal", score: 50, reason: "Routine repair" },
  estimatedRevenue: { minimum: 1, maximum: 9999, likely: 4000, confidence: 99, basis: "Provider guess" },
  nextBestAction: { action: "Ask for the service address.", actionType: "request_information",
    priority: "medium", recommendedWithinMinutes: 30, suggestedMessage: "What is the service address?" },
  objections: [{ category: "price", description: "Asked about price" }],
  missingInformation: ["Service address"],
  riskFlags: [{ type: "other", severity: "low", explanation: "Review request" }],
  overallConfidence: 80,
});

export function normalizationCases() {
  const cases = [];
  const add = (name, change = () => {}, extra = {}) => {
    const analysis = validAnalysis(); change(analysis); cases.push({ name, analysis, ...extra });
  };
  add("happy");
  cases.push({ name: "empty-object", analysis: {} }, { name: "null-analysis", analysis: null });
  add("null-sections", a => { for (const k of Object.keys(a)) if (k !== "summary") a[k] = null; });
  add("missing-sections", a => { for (const k of Object.keys(a)) if (k !== "summary") delete a[k]; });
  for (const value of [-1, 0, 1, 24, 25, 49, 50, 74, 75, 89, 90, 100, 101, 49.5, "bad", "0.8", null, "", false, true]) {
    add(`scores-${JSON.stringify(value)}`, a => {
      a.buyingLikelihood.score = value; a.appointmentProbability.score = value;
      a.urgency.score = value; a.overallConfidence = value;
    });
  }
  for (const value of [-2, -1, 0, 1, 2, "bad", null]) add(`sentiment-${JSON.stringify(value)}`, a => { a.sentiment.score = value; });
  for (const value of [-1, 0, 1, 43200, 43201, 1.5, "bad", null]) add(`minutes-${JSON.stringify(value)}`, a => { a.nextBestAction.recommendedWithinMinutes = value; });
  add("unknown-enums", a => {
    a.customerIntent.category = "future_intent"; a.sentiment.label = "future_sentiment";
    a.urgency.level = "future_urgency"; a.nextBestAction.actionType = "future_action";
    a.nextBestAction.priority = "future_priority";
  });
  for (const actionType of ["send_estimate", "schedule_appointment", "call_now", "call_soon", "send_message",
    "prepare_estimate_for_review", "collect_appointment_preference", "request_appointment_confirmation",
    "request_information", "assign_team_member", "escalate", "follow_up_later", "close_lead", "none"]) {
    add(`action-${actionType}`, a => { a.nextBestAction.actionType = actionType; a.nextBestAction.action = ""; });
  }
  for (const level of ["low", "normal", "high", "emergency", "unknown"]) {
    add(`urgency-fallback-${level}`, a => { a.urgency.level = level; delete a.urgency.score; });
  }
  add("risk-filter-and-cap", a => {
    a.riskFlags = [null, { type: "invalid", severity: "low", explanation: "Unknown type" },
      { type: "other", severity: "invalid", explanation: "Unknown severity" },
      { type: "other", severity: "low", explanation: " " },
      ...Array.from({ length: 12 }, (_, i) => ({ type: "other", severity: "high", explanation: `Risk ${i}` }))];
    a.objections = [null, { category: "invalid", description: "Unknown" }, { category: "price", description: " " },
      ...Array.from({ length: 12 }, (_, i) => ({ category: "price", description: `Objection ${i}` }))];
    a.missingInformation = [null, 2, " ", ...Array.from({ length: 12 }, (_, i) => ` Detail ${i} `)];
    a.buyingLikelihood.reasons = a.missingInformation; a.appointmentProbability.reasons = {};
  });
  add("guardrail-clean");
  add("guardrail-fallback", a => { a.nextBestAction.suggestedMessage = "Your appointment is confirmed. Our technician is on the way."; });
  add("guardrail-replaces-tenth-risk", a => {
    a.nextBestAction.suggestedMessage = "Your appointment is confirmed.";
    a.riskFlags = Array.from({ length: 12 }, (_, i) => ({ type: "other", severity: "low", explanation: `Risk ${i}` }));
  });
  add("guardrail-raw-category", a => { a.customerIntent.category = "off_topic"; a.nextBestAction.suggestedMessage = "A raw message"; });
  for (const [field, limit] of Object.entries({ summary: 2000, intent: 200, explanation: 500, action: 1000, suggestedMessage: 1500 })) {
    for (const delta of [-1, 0, 1]) for (const charset of ["ascii", "multibyte"]) {
      const length = limit + delta;
      const value = (charset === "ascii" ? "x" : "é😀").repeat(length).slice(0, length);
      add(`limit-${field}-${delta}-${charset}`, a => {
        if (field === "summary") a.summary = value;
        if (field === "intent") { a.customerIntent.primary = value; a.customerIntent.serviceType = value; }
        if (field === "explanation") {
          a.sentiment.explanation = value; a.urgency.reason = value;
          a.buyingLikelihood.reasons = [value]; a.appointmentProbability.reasons = [value];
          a.missingInformation = [value]; a.objections = [{ category: "price", description: value }];
          a.riskFlags = [{ type: "other", severity: "low", explanation: value }];
        }
        if (field === "action") a.nextBestAction.action = value;
        if (field === "suggestedMessage") a.nextBestAction.suggestedMessage = value;
      }, field === "suggestedMessage" ? { guardrailResult: { reply: value, usedFallback: false, violations: [] } } : {});
    }
  }
  for (const [name, env] of [
    ["specific", { OPENAI_CONVERSATION_MODEL: "conversation-specific", OPENAI_MODEL: "general" }],
    ["general", { OPENAI_MODEL: "general" }], ["default", {}],
    ["empty-specific", { OPENAI_CONVERSATION_MODEL: "", OPENAI_MODEL: "general" }],
    ["both-empty", { OPENAI_CONVERSATION_MODEL: "", OPENAI_MODEL: "" }],
  ]) add(`model-${name}`, () => {}, { env });
  add("model-changes-during-provider", () => {}, { env: { OPENAI_MODEL: "before-provider" }, providerEnv: { OPENAI_CONVERSATION_MODEL: "after-provider" } });
  add("model-changes-during-guardrail", () => {}, { env: { OPENAI_MODEL: "before-guardrail" }, guardrailEnv: { OPENAI_CONVERSATION_MODEL: "after-guardrail" } });
  for (const [name, moduleEnv] of [
    ["minimum", { CONVERSATION_INTELLIGENCE_MAX_MESSAGES: "1", CONVERSATION_INTELLIGENCE_MAX_CHARACTERS: "1" }],
    ["maximum", { CONVERSATION_INTELLIGENCE_MAX_MESSAGES: "2001", CONVERSATION_INTELLIGENCE_MAX_CHARACTERS: "200001" }],
    ["invalid", { CONVERSATION_INTELLIGENCE_MAX_MESSAGES: "bad", CONVERSATION_INTELLIGENCE_MAX_CHARACTERS: "bad" }],
  ]) add(`transcript-config-${name}`, () => {}, { moduleEnv, longTranscript: true });
  add("transcript-config-remains-module-scoped", () => {}, { longTranscript: true,
    afterLoadEnv: { CONVERSATION_INTELLIGENCE_MAX_MESSAGES: "1", CONVERSATION_INTELLIGENCE_MAX_CHARACTERS: "1" } });
  for (const mode of ["missing-key", "missing-business", "missing-conversation", "missing-messages", "empty-transcript",
    "empty-output", "invalid-json", "blank-summary", "provider-error", "database-error", "guardrail-error", "valuation-error",
    "invalid-date", "non-string-output", "guardrail-invalid-result"]) add(`error-${mode}`, () => {}, { errorMode: mode });
  return cases;
}
