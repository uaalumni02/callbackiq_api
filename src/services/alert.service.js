import Alert from "../models/alert.js";
import SocketService from "./socket.service.js";

const truncate = (value, maximumLength = 220) => {
  const text = String(value || "").trim();

  if (text.length <= maximumLength) {
    return text;
  }

  return `${text.slice(0, maximumLength - 1)}…`;
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
    type,
    channel = "in_app",
    title,
    message,
    priority = "medium",
    status,
    metadata = {},
    dedupeKey = null,
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
      type,
      channel,
      title,
      message,
      priority,
      status: normalizedStatus,
      metadata,
      dedupeKey: dedupeKey || null,
      sentAt:
        normalizedStatus === "sent" || normalizedStatus === "read" ? now : null,
      readAt: normalizedStatus === "read" ? now : null,
    };

    /*
     * Do not perform a read before every automatic insert. The compound unique
     * index on business + dedupeKey is the concurrency-safe source of truth.
     * A duplicate webhook reaches the duplicate-key branch below.
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
      console.error("Automatic alert creation failed:", {
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
      priority,
      metadata: {
        conversationId: conversationId ? String(conversationId) : null,
        messageId: messageId ? String(messageId) : null,
        providerMessageId: providerMessageId || null,
        customerPhone: customerPhone || null,
      },
      dedupeKey: `customer_reply:${providerMessageId || messageId}`,
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
      priority: "high",
      metadata: {
        leadScore: Number(score) || 0,
        urgency: urgency || null,
        serviceNeeded: serviceNeeded || null,
        estimatedValue: Number(estimatedValue) || 0,
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
        estimatedValue: Number(estimatedValue) || 0,
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
      priority,
      metadata,
      dedupeKey,
    });
  }
}

export default AlertService;
