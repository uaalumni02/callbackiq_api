import { safeConsole } from "../helpers/logging/safeLogger.js";
import { moneyAmount } from "./valuation/opportunityValue.js";
// CALLBACKIQ_SMS_PRODUCTION_HANDOFF_V1: alerts
import Alert from "../models/alert.js";
import SocketService from "./socket.service.js";

const ALERT_PRIORITIES = new Set(["low", "medium", "high", "critical"]);

const truncate = (value, maximumLength = 220) => {
  const text = String(value || "").trim();

  if (text.length <= maximumLength) {
    return text;
  }

  return `${text.slice(0, maximumLength - 1)}…`;
};

const normalizePriority = (value, fallback = "medium") => {
  return ALERT_PRIORITIES.has(value) ? value : fallback;
};

const getCustomerLabel = ({ customerName, customerPhone }) => {
  const normalizedName = String(customerName || "").trim();

  if (
    normalizedName &&
    !["Missed Call Lead", "New SMS Lead"].includes(normalizedName)
  ) {
    return normalizedName;
  }

  return String(customerPhone || "").trim() || "A customer";
};

const populateAlert = async (alertId) => {
  return Alert.findById(alertId)
    .populate("business", "businessName businessType phone")
    .populate("lead", "customerName phone serviceNeeded urgency status")
    .lean();
};

const findExistingAlert = async (businessId, dedupeKey) => {
  if (!dedupeKey) {
    return null;
  }

  return Alert.findOne({
    business: businessId,
    dedupeKey,
  })
    .select("_id")
    .lean();
};

class AlertService {
  /**
   * Strict creation method.
   *
   * Use this from request/response controllers where a database failure should
   * be returned to the caller. Automatic operational alerts use
   * createAutomatic() so an alert failure never breaks a Twilio, AI, or lead
   * workflow that has already succeeded.
   */
  static async create({
    businessId,
    leadId = null,
    conversationId = null,
    type,
    channel = "in_app",
    title,
    message,
    priority = "medium",
    status,
    metadata = {},
    dedupeKey = null,
    actionRequired = false,
    dueAt = null,
    reason = "",
    recommendedAction = "",
    aiSummary = "",
    lastCustomerMessage = "",
  }) {
    if (!businessId) {
      throw new Error("businessId is required to create an alert");
    }

    const now = new Date();
    const normalizedStatus =
      status || (channel === "in_app" ? "sent" : "pending");

    const payload = {
      business: businessId,
      lead: leadId || null,
      conversation: conversationId || null,
      type,
      channel,
      title,
      message,
      priority: normalizePriority(priority),
      status: normalizedStatus,
      metadata,
      dedupeKey: dedupeKey || null,
      actionRequired: Boolean(actionRequired),
      dueAt: dueAt || null,
      reason: truncate(reason, 1000),
      recommendedAction: truncate(recommendedAction, 1000),
      aiSummary: truncate(aiSummary, 2000),
      lastCustomerMessage: truncate(lastCustomerMessage, 1600),
      sentAt:
        normalizedStatus === "sent" || normalizedStatus === "read" ? now : null,
      readAt: normalizedStatus === "read" ? now : null,
    };

    /*
     * The compound unique index on business + dedupeKey is the
     * concurrency-safe source of truth.
     */
    try {
      const createdAlert = await Alert.create(payload);
      const populatedAlert = await populateAlert(createdAlert._id);

      SocketService.emitAlertCreated(businessId, populatedAlert);

      return {
        alert: populatedAlert,
        created: true,
      };
    } catch (error) {
      if (error?.code === 11000 && dedupeKey) {
        const existing = await findExistingAlert(businessId, dedupeKey);

        return {
          alert: existing ? await populateAlert(existing._id) : null,
          created: false,
        };
      }

      throw error;
    }
  }

  static async createAutomatic(payload) {
    try {
      return await this.create(payload);
    } catch (error) {
      safeConsole.error("Automatic alert creation failed:", {
        type: payload?.type,
        businessId: String(payload?.businessId || ""),
        dedupeKey: payload?.dedupeKey || null,
        error,
      });

      return {
        alert: null,
        created: false,
      };
    }
  }

  static async createMissedCallAlert({
    businessId,
    leadId,
    customerName,
    customerPhone,
    callLogId,
    providerCallId,
  }) {
    const customer = getCustomerLabel({
      customerName,
      customerPhone,
    });

    return this.createAutomatic({
      businessId,
      leadId,
      type: "missed_call",
      title: "New missed call",
      message: `${customer} called and did not reach your business. CallBackIQ started the missed-call recovery workflow.`,
      priority: "high",
      metadata: {
        callLogId: callLogId ? String(callLogId) : null,
        providerCallId: providerCallId || null,
        customerPhone: customerPhone || null,
      },
      dedupeKey: `missed_call:${providerCallId || callLogId}`,
    });
  }

  static async createCustomerReplyAlert({
    businessId,
    leadId,
    conversationId,
    messageId,
    providerMessageId,
    customerName,
    customerPhone,
    messageBody,
    priority = "medium",
  }) {
    const customer = getCustomerLabel({
      customerName,
      customerPhone,
    });

    return this.createAutomatic({
      businessId,
      leadId,
      type: "customer_reply",
      title: "New customer reply",
      message: `${customer}: ${truncate(messageBody)}`,
      priority: normalizePriority(priority),
      metadata: {
        conversationId: conversationId ? String(conversationId) : null,
        messageId: messageId ? String(messageId) : null,
        providerMessageId: providerMessageId || null,
        customerPhone: customerPhone || null,
      },
      dedupeKey: `customer_reply:${providerMessageId || messageId}`,
    });
  }

  /**
   * Creates one deduplicated operational alert for a guarded AI decision.
   *
   * Phase 0 uses the existing "system" alert type. A dedicated safety or
   * intervention alert type can be introduced in the later Alerts phase.
   */
  static async createAIReviewAlert({
    businessId,
    leadId,
    conversationId,
    messageId,
    providerMessageId,
    customerName,
    customerPhone,
    result,
  }) {
    const customer = getCustomerLabel({
      customerName,
      customerPhone,
    });

    const messageCategory = String(result?.messageCategory || "unknown");
    const riskFlags = Array.isArray(result?.riskFlags)
      ? result.riskFlags
      : [];

    const isEmergency =
      messageCategory === "emergency" ||
      riskFlags.includes("safety_hazard") ||
      riskFlags.includes("hazardous_diy_request");

    const title =
      String(result?.alertTitle || "").trim() ||
      (isEmergency
        ? "Emergency safety concern detected"
        : "Customer message needs review");

    const message =
      String(result?.alertMessage || "").trim() ||
      `${customer}'s latest message requires human review.`;

    return this.createAutomatic({
      businessId,
      leadId,
      type: "system",
      title: truncate(title, 120),
      message: truncate(message, 1000),
      priority: normalizePriority(
        result?.alertPriority,
        isEmergency ? "critical" : "high",
      ),
      metadata: {
        conversationId: conversationId ? String(conversationId) : null,
        messageId: messageId ? String(messageId) : null,
        providerMessageId: providerMessageId || null,
        customerPhone: customerPhone || null,
        messageCategory,
        decision: result?.decision || null,
        actionType: result?.actionType || null,
        riskFlags,
        confidence: Number(result?.confidence) || 0,
        guardrail: result?.guardrail || {},
      },
      dedupeKey: `ai_review:${providerMessageId || messageId}`,
    });
  }
  static async createHumanHandoffAlert({
    businessId,
    leadId,
    conversationId,
    messageId,
    providerMessageId,
    customerName,
    customerPhone,
    customerMessage = "",
    result = {},
    lead = {},
  }) {
    const customer = getCustomerLabel({ customerName, customerPhone });
    const category = String(result?.messageCategory || "human_requested");
    const intake = ["intake_complete", "intake_follow_up"].includes(result?.handoff?.reason);
    const riskFlags = Array.isArray(result?.riskFlags) ? result.riskFlags : [];
    const urgency = String(result?.urgency || lead?.urgency || "")
      .trim()
      .toLowerCase();
    const isEmergency =
      category === "emergency" ||
      category === "hazardous_diy_request" ||
      urgency === "emergency" ||
      riskFlags.includes("safety_hazard") ||
      riskFlags.includes("hazardous_diy_request");
    const isUrgent = isEmergency || urgency === "high";
    const parseSla = (value, fallback) => {
      const parsed = Number.parseInt(String(value || ""), 10);
      return Number.isFinite(parsed) && parsed >= 1
        ? Math.min(240, parsed)
        : fallback;
    };
    const slaMinutes = isEmergency
      ? parseSla(process.env.SMS_EMERGENCY_CALLBACK_SLA_MINUTES, 5)
      : isUrgent
        ? parseSla(process.env.SMS_URGENT_CALLBACK_SLA_MINUTES, 10)
        : parseSla(process.env.SMS_HUMAN_CALLBACK_SLA_MINUTES, 15);
    const dueAt = new Date(Date.now() + slaMinutes * 60 * 1000);
    const serviceNeeded = String(
      result?.serviceNeeded || lead?.serviceNeeded || "",
    ).trim();
    const address = String(result?.address || lead?.address || "").trim();
    const preferredAppointmentTime = String(
      result?.preferredAppointmentTime || lead?.preferredAppointmentTime || "",
    ).trim();
    const detailParts = [
      serviceNeeded && serviceNeeded !== "Unknown"
        ? `service: ${serviceNeeded}`
        : "",
      urgency ? `urgency: ${urgency}` : "",
      address ? `address: ${address}` : "",
    ].filter(Boolean);

    /*
     * Use strict creation here. The customer acknowledgement promises that a
     * person has been asked to follow up, so the queue must not send that
     * promise unless the action-required staff alert is durably stored. The
     * unique dedupe key makes retries safe.
     */
    return this.create({
      businessId,
      leadId,
      conversationId,
      type: isEmergency ? "safety_emergency" : "human_requested",
      title: intake
        ? "Service request ready for team review"
        : isUrgent
        ? "Urgent customer callback required"
        : "Customer requested a callback",
      message: `${customer} ${intake ? "has a service request awaiting review" : `requested human follow-up at ${customerPhone || "the texting number"}`}.${
        detailParts.length ? ` ${detailParts.join("; ")}.` : ""
      }`,
      priority: isEmergency ? "critical" : "high",
      actionRequired: true,
      dueAt,
      reason: category,
      recommendedAction: intake
        ? "Review the service, urgency, address, preferred time, and latest customer questions. Confirm availability with the customer before a visit."
        : `Call ${customerPhone || "the customer"} and review the full SMS conversation before responding.`,
      aiSummary: String(result?.summary || lead?.summary || ""),
      lastCustomerMessage: customerMessage,
      metadata: {
        conversationId: conversationId ? String(conversationId) : null,
        messageId: messageId ? String(messageId) : null,
        providerMessageId: providerMessageId || null,
        customerPhone: customerPhone || null,
        callbackPhone: result?.handoff?.callbackPhone || customerPhone || null,
        callbackRequested: result?.handoff?.callbackRequested === true,
        messageCategory: category,
        riskFlags,
        serviceNeeded: serviceNeeded || null,
        urgency: urgency || null,
        urgent: isUrgent,
        address: address || null,
        preferredAppointmentTime: preferredAppointmentTime || null,
        callbackSlaMinutes: slaMinutes,
      },
      dedupeKey: `human_handoff:${providerMessageId || messageId}`,
    });
  }
  static async createHotLeadAlert({
    businessId,
    leadId,
    customerName,
    customerPhone,
    score,
    urgency,
    serviceNeeded,
    estimatedValue,
  }) {
    const customer = getCustomerLabel({
      customerName,
      customerPhone,
    });

    const details = [];

    if (Number.isFinite(Number(score))) {
      details.push(`lead score ${Number(score)}`);
    }

    if (urgency) {
      details.push(`${urgency} urgency`);
    }

    if (serviceNeeded && serviceNeeded !== "Unknown") {
      details.push(serviceNeeded);
    }

    return this.createAutomatic({
      businessId,
      leadId,
      type: "hot_lead",
      title:
        urgency === "emergency"
          ? "Emergency lead detected"
          : "Hot lead detected",
      message: `${customer} requires attention${
        details.length ? `: ${details.join(", ")}` : ""
      }.`,
      priority: urgency === "emergency" ? "critical" : "high",
      metadata: {
        leadScore: Number(score) || 0,
        urgency: urgency || null,
        serviceNeeded: serviceNeeded || null,
        estimatedValue: moneyAmount(estimatedValue),
      },
      dedupeKey: `hot_lead:${leadId}`,
    });
  }

  static async createBookedJobAlert({
    businessId,
    leadId,
    customerName,
    customerPhone,
    serviceNeeded,
    estimatedValue,
  }) {
    const customer = getCustomerLabel({
      customerName,
      customerPhone,
    });

    const amount = Number(estimatedValue);
    const valueText =
      Number.isFinite(amount) && amount > 0
        ? ` Estimated value: $${amount.toLocaleString("en-US")}.`
        : "";

    const serviceText =
      serviceNeeded && serviceNeeded !== "Unknown"
        ? ` for ${serviceNeeded}`
        : "";

    return this.createAutomatic({
      businessId,
      leadId,
      type: "booked_job",
      title: "Job booked",
      message: `${customer} has been marked as booked${serviceText}.${valueText}`,
      priority: "medium",
      metadata: {
        serviceNeeded: serviceNeeded || null,
        estimatedValue: moneyAmount(estimatedValue),
      },
      dedupeKey: `booked_job:${leadId}`,
    });
  }

  static async createSystemAlert({
    businessId,
    title,
    message,
    priority = "medium",
    metadata = {},
    dedupeKey = null,
  }) {
    return this.createAutomatic({
      businessId,
      type: "system",
      title,
      message,
      priority: normalizePriority(priority),
      metadata,
      dedupeKey,
    });
  }
}

export default AlertService;
