import {
  SAFE_REPLIES,
  cleanText,
  evaluateDeterministicInboundGuardrails,
  normalizeSmsReply,
} from "../helpers/ai/aiGuardrails.js";
import {
  getOpenAIClient,
  resetFollowUpOpenAIClient,
  runFollowUpAgent,
} from "../helpers/ai/followUpAgent.js";
import {
  qualifyLeadWithAI,
  resetQualificationOpenAIClient,
} from "../helpers/ai/qualifyLeadWithAI.js";
import { buildAIConfigurationContext } from "./businessConfiguration.service.js";
import BookingStateMachineService from "./booking/bookingStateMachine.service.js";

const fallbackReply = SAFE_REPLIES.fallback;

const getLatestInboundMessage = (messages) => {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.direction !== "inbound") continue;
    const body = cleanText(message?.body || message?.content || message?.message);
    if (body) return body;
  }
  return "";
};


const deterministicResult = (assessment) => ({
  decision: assessment.decision,
  actionType: assessment.actionType,
  messageCategory: assessment.category,
  reply: assessment.reply,
  serviceNeeded: "",
  urgency: assessment.category === "emergency" ? "emergency" : "medium",
  address: "",
  preferredAppointmentTime: "",
  leadQualityScore: 0,
  estimatedValue: 0,
  summary: assessment.reason
    ? `Deterministic inbound safeguard: ${assessment.reason}.`
    : "A deterministic inbound safeguard handled this message.",
  shouldAlertOwner: Boolean(assessment.shouldAlertOwner),
  alertPriority: assessment.alertPriority || "low",
  alertTitle:
    assessment.category === "emergency"
      ? "Safety emergency detected"
      : assessment.shouldAlertOwner
        ? "Customer message needs review"
        : "",
  alertMessage: assessment.shouldAlertOwner
    ? `The inbound message triggered ${assessment.reason || assessment.category}.`
    : "",
  riskFlags: assessment.riskFlags || [],
  confidence: 1,
  hazardType: assessment.hazardType || "",
  guardrail: {
    skipAI: true,
    reason: assessment.reason || "deterministic_guardrail",
    usedFallback: false,
    violations: [],
  },
});

const buildFallbackResult = (error) => ({
  decision: "send_fixed_response",
  actionType: "send_fixed_response",
  messageCategory: "unknown",
  reply: fallbackReply,
  serviceNeeded: "",
  urgency: "medium",
  address: "",
  preferredAppointmentTime: "",
  leadQualityScore: 0,
  estimatedValue: 0,
  summary: "The guarded AI reply pipeline could not complete.",
  shouldAlertOwner: true,
  alertPriority: "high",
  alertTitle: "AI reply fallback used",
  alertMessage: "The AI reply pipeline failed and a safe fallback response was selected.",
  riskFlags: ["other"],
  confidence: 0,
  guardrail: {
    skipAI: false,
    reason: "ai_pipeline_error",
    usedFallback: true,
    violations: [],
    errorMessage: cleanText(error?.message, "Unknown AI error"),
  },
});

export const generateAIReplyResult = async ({
  business,
  lead,
  conversation = null,
  messages = [],
  customerMessage,
}) => {
  const latestCustomerMessage = cleanText(customerMessage) || getLatestInboundMessage(messages);
  if (!latestCustomerMessage) {
    return {
      ...buildFallbackResult(new Error("No inbound customer message found")),
      decision: "no_reply",
      actionType: "no_reply",
      reply: "",
      shouldAlertOwner: false,
      alertPriority: "low",
      alertTitle: "",
      alertMessage: "",
      guardrail: {
        skipAI: true,
        reason: "missing_inbound_message",
        usedFallback: false,
        violations: [],
      },
    };
  }

  try {
    /*
     * Re-run deterministic safeguards here because booking is an earlier
     * decision branch than the ordinary AI agents. This guarantees that a
     * safety, hazardous-DIY, sensitive-data, abuse, STOP, or HELP message can
     * never execute a booking tool, including midway through an active flow.
     */
    const deterministicAssessment = evaluateDeterministicInboundGuardrails({
      customerMessage: latestCustomerMessage,
      recentMessages: messages,
    });
    if (deterministicAssessment.handled) {
      return deterministicResult(deterministicAssessment);
    }

    /*
     * The booking state machine is deterministic and may only call approved
     * application tools; it never calls Google or Mongo models directly.
     */
    const booking = await BookingStateMachineService.handle({
      business,
      lead,
      conversation,
      customerMessage: latestCustomerMessage,
    });
    if (booking.handled) return booking.result;

    const [inboundAssessment, businessConfiguration] = await Promise.all([
      qualifyLeadWithAI({
        messageBody: latestCustomerMessage,
        business,
        businessType: business?.businessType || "other",
        recentMessages: messages,
      }),
      buildAIConfigurationContext(business),
    ]);
    return await runFollowUpAgent({
      business,
      businessName: business?.businessName,
      businessType: business?.businessType || "other",
      customerMessage: latestCustomerMessage,
      lead,
      recentMessages: messages,
      inboundAssessment,
      businessConfiguration,
    });
  } catch (error) {
    console.error("Guarded AI reply generation error:", {
      message: error?.message || "Unknown OpenAI error",
      status: error?.status || null,
      requestId: error?.request_id || null,
    });
    return buildFallbackResult(error);
  }
};

export const generateAIReply = async (parameters) => {
  const result = await generateAIReplyResult(parameters);
  if (result.decision === "no_reply") return "";
  return normalizeSmsReply(result.reply, fallbackReply);
};

export const resetOpenAIReplyClient = () => {
  resetFollowUpOpenAIClient();
  resetQualificationOpenAIClient();
};

export { fallbackReply, getOpenAIClient };
