import Alert from "../models/alert.js";
import SocketService from "./socket.service.js";

const EXTERNAL_NOTIFICATION_TYPES = new Set([
  "safety_emergency",
  "human_requested",
  "angry_customer",
  "high_value_lead",
]);

const PRIORITY_RANK = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const MINIMUM_PRIORITY_BY_TYPE = {
  safety_emergency: "critical",
  human_requested: "high",
  angry_customer: "high",
  high_value_lead: "high",
  low_ai_confidence: "medium",
  booking_conflict: "high",
  integration_failure: "high",
  message_delivery_failure: "high",
  unanswered_hot_lead: "high",
  appointment_canceled: "medium",
};

const normalizePriorityName = (value) => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (normalized === "normal") return "medium";
  if (normalized === "urgent" || normalized === "emergency") {
    return "critical";
  }
  if (Object.prototype.hasOwnProperty.call(PRIORITY_RANK, normalized)) {
    return normalized;
  }
  return "high";
};

const normalizeInterventionPriority = (type, requestedPriority) => {
  const requested = normalizePriorityName(requestedPriority);
  const minimum = MINIMUM_PRIORITY_BY_TYPE[type] || "low";
  return PRIORITY_RANK[requested] >= PRIORITY_RANK[minimum]
    ? requested
    : minimum;
};

class InterventionService {
  static async create({
    businessId,
    leadId = null,
    conversationId = null,
    appointmentId = null,
    type,
    title,
    message,
    priority = "high",
    reason = "",
    recommendedAction = "",
    aiSummary = "",
    lastCustomerMessage = "",
    dueAt = null,
    metadata = {},
    dedupeKey = null,
  }) {
    const normalizedPriority = normalizeInterventionPriority(type, priority);
    const payload = {
      business: businessId,
      lead: leadId,
      conversation: conversationId,
      appointment: appointmentId,
      type,
      title,
      message,
      priority: normalizedPriority,
      status: "sent",
      channel: "in_app",
      actionRequired: true,
      reason,
      recommendedAction,
      aiSummary,
      lastCustomerMessage,
      dueAt,
      metadata: {
        ...metadata,
        externalNotificationEligible:
          normalizedPriority === "critical" ||
          EXTERNAL_NOTIFICATION_TYPES.has(type),
      },
      dedupeKey,
      sentAt: new Date(),
    };

    try {
      const alert = await Alert.create(payload);
      const populated = await Alert.findById(alert._id)
        .populate(
          "lead",
          "customerName phone serviceNeeded urgency estimatedValue status",
        )
        .populate(
          "conversation",
          "customerName customerPhone lastMessage status humanTakeover",
        )
        .populate(
          "appointment",
          "startAt endAt timezone status provider",
        )
        .populate("assignedTo", "userName email")
        .lean();

      SocketService.emitAlertCreated(businessId, populated);
      SocketService.emitDashboardRefresh(
        businessId,
        `intervention:${type}`,
      );
      return populated;
    } catch (error) {
      if (error?.code === 11000 && dedupeKey) {
        return Alert.findOne({ business: businessId, dedupeKey }).lean();
      }
      throw error;
    }
  }

  static async integrationFailure({
    businessId,
    leadId,
    conversationId,
    appointmentId,
    provider,
    error,
  }) {
    return this.create({
      businessId,
      leadId,
      conversationId,
      appointmentId,
      type: "integration_failure",
      title: `${provider || "Scheduling"} confirmation failed`,
      message:
        "The customer requested an appointment, but the external provider did not confirm it.",
      priority: "high",
      reason: error?.message || "The scheduling provider returned an error.",
      recommendedAction:
        "Open the conversation and confirm the requested time directly with the customer.",
      metadata: { provider, errorCode: error?.code || null },
      dedupeKey: appointmentId
        ? `integration_failure:${appointmentId}`
        : null,
    });
  }
}

export {
  EXTERNAL_NOTIFICATION_TYPES,
  MINIMUM_PRIORITY_BY_TYPE,
  PRIORITY_RANK,
  normalizeInterventionPriority,
};
export default InterventionService;
