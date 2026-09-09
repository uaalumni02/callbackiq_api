import {
  SAFE_REPLIES,
  cleanText,
  evaluateDeterministicInboundGuardrails,
  normalizeSmsReply,
} from "../../src/helpers/ai/aiGuardrails.js";
import {
  getOpenAIClient,
  resetFollowUpOpenAIClient,
  runFollowUpAgent,
} from "../../src/helpers/ai/followUpAgent.js";
import {
  qualifyLeadWithAI,
  resetQualificationOpenAIClient,
} from "../../src/helpers/ai/qualifyLeadWithAI.js";
import {
  fallbackReply,
  generateAIReply,
  generateAIReplyResult,
  resetOpenAIReplyClient,
} from "../../src/services/aiReplyService.js";
import { buildAIConfigurationContext } from "../../src/services/businessConfiguration.service.js";
import BookingStateMachineService from "../../src/services/booking/bookingStateMachine.service.js";
import { reserveAiUsage } from "../../src/services/communicationUsage.service.js";
import { logOperationalError } from "../../src/helpers/logging/safeLogger.js";

jest.mock("../../src/helpers/ai/aiGuardrails.js", () => ({
  ...jest.requireActual("../../src/helpers/ai/aiGuardrails.js"),
  __esModule: true,
  SAFE_REPLIES: { fallback: "Safe fallback reply." },
  cleanText: jest.fn((value, fallback = "") => {
    const text = String(value ?? "").trim();
    return text || fallback;
  }),
  evaluateDeterministicInboundGuardrails: jest.fn(),
  normalizeSmsReply: jest.fn((reply, fallback) => String(reply || fallback).trim()),
}));
jest.mock("../../src/helpers/ai/followUpAgent.js", () => ({
  __esModule: true,
  getOpenAIClient: jest.fn(),
  resetFollowUpOpenAIClient: jest.fn(),
  runFollowUpAgent: jest.fn(),
}));
jest.mock("../../src/helpers/ai/qualifyLeadWithAI.js", () => ({
  __esModule: true,
  qualifyLeadWithAI: jest.fn(),
  resetQualificationOpenAIClient: jest.fn(),
}));
jest.mock("../../src/services/businessConfiguration.service.js", () => ({
  __esModule: true,
  buildAIConfigurationContext: jest.fn(),
}));
jest.mock("../../src/services/booking/bookingStateMachine.service.js", () => ({
  __esModule: true,
  default: { handle: jest.fn() },
}));

jest.mock("../../src/services/communicationUsage.service.js", () => ({
  __esModule: true,
  reserveAiUsage: jest.fn(),
}));
jest.mock("../../src/helpers/logging/safeLogger.js", () => ({
  __esModule: true,
  logOperationalError: jest.fn(),
}));
const business = {
  _id: "b1",
  businessName: "Peachtree Plumbing",
  businessType: "plumbing",
};
const lead = { _id: "l1" };

describe("aiReplyService complete behavior", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    evaluateDeterministicInboundGuardrails.mockReturnValue({ handled: false });
    BookingStateMachineService.handle.mockResolvedValue({ handled: false });
    qualifyLeadWithAI.mockResolvedValue({ urgency: "medium" });
    buildAIConfigurationContext.mockResolvedValue({ scheduling: { enabled: true } });
    reserveAiUsage.mockResolvedValue({ allowed: true, reservations: [] });
    runFollowUpAgent.mockResolvedValue({
      decision: "send_ai_response",
      reply: "How can we help?",
    });
  });

  test("exports the configured fallback and OpenAI client", () => {
    expect(fallbackReply).toBe(SAFE_REPLIES.fallback);
    expect(getOpenAIClient).toEqual(expect.any(Function));
  });

  test("returns no_reply when no inbound message exists", async () => {
    const result = await generateAIReplyResult({ business, lead, messages: [] });
    expect(result).toMatchObject({
      decision: "no_reply",
      actionType: "no_reply",
      reply: "",
      shouldAlertOwner: false,
      alertPriority: "low",
      guardrail: {
        skipAI: true,
        reason: "missing_inbound_message",
        usedFallback: false,
        violations: [],
      },
    });
    expect(BookingStateMachineService.handle).not.toHaveBeenCalled();
  });

  test("finds the latest usable inbound body, content, or message", async () => {
    const messages = [
      { direction: "inbound", body: "old" },
      { direction: "outbound", body: "ignore" },
      { direction: "inbound", body: "", content: "latest content" },
    ];
    await generateAIReplyResult({ business, lead, messages });
    expect(evaluateDeterministicInboundGuardrails).toHaveBeenCalledWith({
      customerMessage: "latest content",
      recentMessages: messages,
    });

    const messageFallback = [{ direction: "inbound", message: "message field" }];
    await generateAIReplyResult({ business, lead, messages: messageFallback });
    expect(evaluateDeterministicInboundGuardrails).toHaveBeenLastCalledWith({
      customerMessage: "message field",
      recentMessages: messageFallback,
    });
  });

  test("ignores non-array and empty inbound histories", async () => {
    await expect(generateAIReplyResult({ business, lead, messages: null })).resolves.toMatchObject({ decision: "no_reply" });
    await expect(generateAIReplyResult({ business, lead, messages: [{ direction: "outbound", body: "hello" }, { direction: "inbound", body: "" }] })).resolves.toMatchObject({ decision: "no_reply" });
  });

  test("customerMessage takes precedence over history", async () => {
    await generateAIReplyResult({
      business,
      lead,
      customerMessage: "current",
      messages: [{ direction: "inbound", body: "old" }],
    });
    expect(evaluateDeterministicInboundGuardrails).toHaveBeenCalledWith(expect.objectContaining({ customerMessage: "current" }));
  });

  test.each([
    [{ category: "emergency", decision: "send_fixed_response", actionType: "send_fixed_response", reply: "Call 911", reason: "fire", shouldAlertOwner: true, alertPriority: "critical", riskFlags: ["fire"], hazardType: "fire" }, "emergency", "Safety emergency detected", "emergency"],
    [{ category: "sensitive_data", decision: "no_reply", actionType: "no_reply", reply: "", reason: "sensitive", shouldAlertOwner: true }, "sensitive_data", "Customer message needs review", "medium"],
    [{ category: "help", decision: "send_fixed_response", actionType: "send_fixed_response", reply: "Help text", shouldAlertOwner: false }, "help", "", "medium"],
  ])("returns deterministic guardrail result %#", async (assessment, category, alertTitle, urgency) => {
    evaluateDeterministicInboundGuardrails.mockReturnValue({ handled: true, ...assessment });
    const result = await generateAIReplyResult({ business, lead, customerMessage: "message" });
    expect(result).toMatchObject({
      decision: assessment.decision,
      actionType: assessment.actionType,
      messageCategory: category,
      reply: assessment.reply,
      urgency,
      shouldAlertOwner: Boolean(assessment.shouldAlertOwner),
      alertPriority: assessment.alertPriority || "low",
      alertTitle,
      confidence: 1,
      hazardType: assessment.hazardType || "",
      guardrail: {
        skipAI: true,
        reason: assessment.reason || "deterministic_guardrail",
        usedFallback: false,
        violations: [],
      },
    });
    expect(BookingStateMachineService.handle).not.toHaveBeenCalled();
  });

  test("uses category fallback in deterministic alert messages", async () => {
    evaluateDeterministicInboundGuardrails.mockReturnValue({
      handled: true,
      category: "abuse",
      decision: "send_fixed_response",
      actionType: "send_fixed_response",
      reply: "We can only help with service requests.",
      shouldAlertOwner: true,
    });
    const result = await generateAIReplyResult({ business, lead, customerMessage: "message" });
    expect(result.summary).toBe("A deterministic inbound safeguard handled this message.");
    expect(result.alertMessage).toContain("abuse");
    expect(result.riskFlags).toEqual([]);
  });

  test("returns a handled booking-state result before AI", async () => {
    const bookingResult = { decision: "send_fixed_response", reply: "What day?" };
    BookingStateMachineService.handle.mockResolvedValue({ handled: true, result: bookingResult });
    const result = await generateAIReplyResult({ business, lead, conversation: { _id: "c1" }, customerMessage: "book" });
    expect(result).toBe(bookingResult);
    expect(BookingStateMachineService.handle).toHaveBeenCalledWith({
      business,
      lead,
      conversation: { _id: "c1" },
      customerMessage: "book",
    });
    expect(qualifyLeadWithAI).not.toHaveBeenCalled();
  });

  test("runs qualification and follow-up in the normal pipeline", async () => {
    const inboundAssessment = { serviceNeeded: "Drain repair" };
    const configuration = { verified: true };
    const agentResult = { decision: "send_ai_response", reply: "Tell me your ZIP." };
    qualifyLeadWithAI.mockResolvedValue(inboundAssessment);
    buildAIConfigurationContext.mockResolvedValue(configuration);
    runFollowUpAgent.mockResolvedValue(agentResult);
    const messages = [{ direction: "inbound", body: "My drain is clogged" }];
    await expect(generateAIReplyResult({ business, lead, messages })).resolves.toMatchObject(agentResult);
    expect(qualifyLeadWithAI).toHaveBeenCalledWith({
      messageBody: "My drain is clogged",
      business,
      businessType: "plumbing",
      recentMessages: messages,
    });
    expect(buildAIConfigurationContext).toHaveBeenCalledWith(business);
    expect(runFollowUpAgent).toHaveBeenCalledWith({
      business,
      businessName: "Peachtree Plumbing",
      businessType: "plumbing",
      customerMessage: "My drain is clogged",
      lead,
      recentMessages: messages,
      inboundAssessment,
      businessConfiguration: configuration,
    });
  });

  test("uses business fallbacks for missing names and types", async () => {
    const minimalBusiness = {};
    await generateAIReplyResult({ business: minimalBusiness, lead, customerMessage: "Need service" });
    expect(qualifyLeadWithAI).toHaveBeenCalledWith(expect.objectContaining({ businessType: "other" }));
    expect(runFollowUpAgent).toHaveBeenCalledWith(expect.objectContaining({ businessName: undefined, businessType: "other" }));
  });

  test.each([
    [new Error("OpenAI down"), "OpenAI down"],
    [{}, "Unknown AI error"],
  ])("returns a safe fallback on pipeline failure %#", async (error, expectedMessage) => {
    qualifyLeadWithAI.mockRejectedValue(error);

    const result = await generateAIReplyResult({ business, lead, customerMessage: "Need help" });
    expect(result).toMatchObject({
      decision: "send_fixed_response",
      actionType: "send_fixed_response",
      messageCategory: "unknown",
      reply: "Safe fallback reply.",
      shouldAlertOwner: true,
      alertPriority: "high",
      riskFlags: ["other"],
      confidence: 0,
      guardrail: {
        skipAI: false,
        reason: "ai_pipeline_error",
        usedFallback: true,
        violations: [],
        errorMessage: expectedMessage,
      },
    });
    expect(logOperationalError).toHaveBeenCalledWith(
      "ai_reply.generation_failed",
      error,
      {
        businessId: business._id,
        requestId: error.request_id || null,
      },
    );
  });

  test("generateAIReply suppresses no_reply decisions", async () => {
    await expect(generateAIReply({ business, lead, messages: [] })).resolves.toBe("");
    expect(normalizeSmsReply).not.toHaveBeenCalled();
  });

  test("generateAIReply normalizes a reply with the safe fallback", async () => {
    runFollowUpAgent.mockResolvedValue({ decision: "send_ai_response", reply: "  Reply  " });
    await expect(generateAIReply({ business, lead, customerMessage: "Need help" })).resolves.toBe("Reply");
    expect(normalizeSmsReply).toHaveBeenCalledWith("  Reply  ", "Safe fallback reply.");
  });

  test("resetOpenAIReplyClient resets both lazy clients", () => {
    resetOpenAIReplyClient();
    expect(resetFollowUpOpenAIClient).toHaveBeenCalledTimes(1);
    expect(resetQualificationOpenAIClient).toHaveBeenCalledTimes(1);
  });

  test("cleanText is used for inbound and error normalization", async () => {
    const error = new Error("failure");
    qualifyLeadWithAI.mockRejectedValue(error);
    jest.spyOn(console, "error").mockImplementation(() => {});
    await generateAIReplyResult({ business, lead, customerMessage: " message " });
    expect(cleanText).toHaveBeenCalledWith(" message ");
    expect(cleanText).toHaveBeenCalledWith("failure", "Unknown AI error");
  });
  test("V4 threads recovery boundary through every AI guardrail layer", async () => {
    const recoveryJourneyStartedAt = new Date("2026-09-05T13:48:10.583Z");
    const conversation = {
      _id: "c-recovery",
      bookingState: { status: "not_started" },
      orchestration: { recoveryJourneyStartedAt },
    };
    const messages = [
      {
        direction: "inbound",
        body: "My sink is clogged",
        createdAt: new Date("2026-09-05T13:48:30.471Z"),
      },
    ];

    await generateAIReplyResult({
      business,
      lead,
      conversation,
      messages,
      customerMessage: "My sink is clogged",
    });

    expect(evaluateDeterministicInboundGuardrails).toHaveBeenCalledWith(
      expect.objectContaining({
        activityWindowStartAt: recoveryJourneyStartedAt,
      }),
    );
    expect(qualifyLeadWithAI).toHaveBeenCalledWith(
      expect.objectContaining({
        activityWindowStartAt: recoveryJourneyStartedAt,
      }),
    );
    expect(runFollowUpAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        activityWindowStartAt: recoveryJourneyStartedAt,
      }),
    );
  });

});
