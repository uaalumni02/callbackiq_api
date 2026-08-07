import Conversation from "../models/conversation.js";
import Message from "../models/message.js";
import AlertService from "./alert.service.js";
import { generateAIReplyResult } from "./aiReplyService.js";
import { logOperationalError, logOperationalEvent } from "../helpers/logging/safeLogger.js";

const FALLBACK_REPLY = "Thanks — I have your message. I’m alerting the team so your request doesn’t get missed.";

const bookingReady = (conversation) => ["offering_slots", "awaiting_confirmation", "booking", "booked"].includes(
  String(conversation?.bookingState?.status || ""),
);

const buildOutcome = ({ result, conversation }) => ({
  intent: String(result?.messageCategory || result?.actionType || "unknown"),
  serviceNeeded: String(result?.serviceNeeded || ""),
  urgency: String(result?.urgency || ""),
  address: String(result?.address || ""),
  preferredAppointmentTime: String(result?.preferredAppointmentTime || conversation?.bookingState?.lastCustomerPreference || ""),
  bookingState: String(conversation?.bookingState?.status || "not_started"),
  bookingReady: bookingReady(conversation),
  confidence: Number.isFinite(Number(result?.confidence)) ? Number(result.confidence) : 0,
  outcome: result?.decision === "no_reply" ? "silent_candidate" : "reply_ready",
});

class ConversationOrchestratorService {
  static async process({ business, lead, conversation, messages, inboundMessage }) {
    let result;
    try {
      result = await generateAIReplyResult({
        business, lead, conversation, messages, customerMessage: inboundMessage.body,
      });
    } catch (error) {
      logOperationalError("conversation_orchestrator.reply_failed", error, {
        businessId: business?._id, conversationId: conversation?._id,
      });
      result = null;
    }

    const latestConversation = await Conversation.findById(conversation._id);
    let escalated = latestConversation?.humanTakeover === true || latestConversation?.bookingState?.status === "human_takeover";
    const reply = String(result?.reply || "").trim();

    // Prevent accidental silence, but preserve intentional guardrail no_reply decisions.
    const unexpectedSilence =
      !result || (result.decision !== "no_reply" && !reply);

    if (unexpectedSilence && !escalated) {
      await AlertService.createSystemAlert({
        businessId: business._id,
        title: "Customer message needs follow-up",
        message: "CallbackIQ prevented a silent SMS failure and queued a safe fallback response.",
        priority: "high",
        metadata: { conversationId: String(conversation._id), inboundMessageId: String(inboundMessage._id) },
        dedupeKey: `silent_sms_guard:${inboundMessage._id}`,
      });
      result = {
        decision: "send_fixed_response", actionType: "send_fixed_response",
        messageCategory: "unknown", reply: FALLBACK_REPLY,
        serviceNeeded: "", urgency: "medium", address: "", preferredAppointmentTime: "",
        leadQualityScore: 0, estimatedValue: 0,
        summary: "Silent-failure guard produced a customer-safe fallback.",
        shouldAlertOwner: true, alertPriority: "high", alertTitle: "Customer follow-up required",
        alertMessage: "Review the conversation because the primary reply pipeline produced no customer response.",
        riskFlags: ["other"], confidence: 0,
        guardrail: { skipAI: true, reason: "silent_failure_guard", usedFallback: true, violations: [] },
      };
      escalated = true;
      await Conversation.findByIdAndUpdate(conversation._id, {
        $inc: { "orchestration.silentFailureCount": 1 },
        $set: { "orchestration.lastEscalatedAt": new Date() },
      });
      logOperationalEvent("conversation_orchestrator.silent_failure_prevented", {
        businessId: business._id, conversationId: conversation._id,
      });
    }

    const refreshed = await Conversation.findById(conversation._id);
    const outcome = buildOutcome({ result, conversation: refreshed || latestConversation || conversation });
    await Promise.all([
      Message.findByIdAndUpdate(inboundMessage._id, {
        $set: { aiOutcome: outcome, actorType: "customer", generatedBy: "customer" },
      }),
      Conversation.findByIdAndUpdate(conversation._id, {
        $set: {
          "conversationMemory.summary": String(result?.summary || "").slice(0, 2000),
          "conversationMemory.serviceNeeded": outcome.serviceNeeded,
          "conversationMemory.urgency": outcome.urgency,
          "conversationMemory.address": outcome.address,
          "conversationMemory.preferredAppointmentTime": outcome.preferredAppointmentTime,
          "conversationMemory.lastIntent": outcome.intent,
          "conversationMemory.confidence": outcome.confidence,
          "conversationMemory.lastUpdatedAt": new Date(),
          "orchestration.lastOutcome": outcome.outcome,
          "orchestration.lastInboundMessage": inboundMessage._id,
        },
      }),
    ]);
    return { result, outcome, escalated };
  }
}

export default ConversationOrchestratorService;
