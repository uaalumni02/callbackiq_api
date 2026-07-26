import crypto from "crypto";
import mongoose from "mongoose";

import SafetyEvent from "../models/safetyEvent.js";
import { redactSensitiveData } from "../helpers/ai/aiGuardrails.js";
import MonitoringService from "./monitoring.service.js";

const id = (value) => value?._id || value || null;

const hashText = (value) =>
  crypto.createHash("sha256").update(String(value || "")).digest("hex");

const databaseAvailable = () => mongoose.connection.readyState === 1;

const normalizeConfidence = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  if (number > 1) return Math.min(1, number / 100);
  return Math.max(0, number);
};

class SafetyAuditService {
  static async recordDetection({
    business,
    conversation,
    lead,
    inboundMessage,
    providerMessageId,
    customerMessage,
    assessment,
  }) {
    if (!databaseAvailable()) return null;

    try {
      return await SafetyEvent.findOneAndUpdate(
        {
          business: id(business),
          providerMessageId,
        },
        {
          $setOnInsert: {
            business: id(business),
            conversation: id(conversation),
            lead: id(lead),
            inboundMessage: id(inboundMessage),
            providerMessageId,
            hazardType: assessment.hazardType || "other",
            hazardTypes:
              assessment.hazardTypes?.length > 0
                ? assessment.hazardTypes
                : [assessment.hazardType || "other"],
            source: assessment.source || "deterministic",
            confidence: normalizeConfidence(assessment.confidence),
            triggeringMessageHash: hashText(customerMessage),
            triggeringMessagePreview: redactSensitiveData(customerMessage).slice(
              0,
              500,
            ),
            replyText: assessment.reply || "",
            aiBypassed: true,
            humanTakeoverActivated: true,
            status: "detected",
            detectedAt: new Date(),
            metadata: {
              reason: assessment.reason || "",
              riskFlags: assessment.riskFlags || ["safety_hazard"],
            },
          },
        },
        {
          upsert: true,
          returnDocument: "after",
          setDefaultsOnInsert: true,
        },
      );
    } catch (error) {
      MonitoringService.captureError("safety_escalation_audit_failed", error, {
        businessId: id(business),
        providerMessageId,
      });
      return null;
    }
  }

  static async recordAlert({ business, providerMessageId, alert }) {
    if (!databaseAvailable() || !providerMessageId) return null;

    try {
      return await SafetyEvent.findOneAndUpdate(
      {
        business: id(business),
        providerMessageId,
      },
      {
        $set: {
          alert: id(alert),
        },
      },
      {
        returnDocument: "after",
      },
    );
    } catch (error) {
      MonitoringService.captureError("safety_alert_audit_failed", error, {
        businessId: id(business),
        providerMessageId,
      });
      return null;
    }
  }

  static async recordReply({
    business,
    providerMessageId,
    outboundMessage,
    outboundProviderMessageId,
    sent,
  }) {
    if (!databaseAvailable() || !providerMessageId) return null;

    try {
      return await SafetyEvent.findOneAndUpdate(
      {
        business: id(business),
        providerMessageId,
      },
      {
        $set: {
          outboundMessage: id(outboundMessage),
          outboundProviderMessageId: outboundProviderMessageId || "",
          status: sent ? "reply_sent" : "reply_reserved",
          replySentAt: sent ? new Date() : null,
        },
      },
      {
        returnDocument: "after",
      },
    );
    } catch (error) {
      MonitoringService.captureError("safety_reply_audit_failed", error, {
        businessId: id(business),
        providerMessageId,
      });
      return null;
    }
  }

  static async recordDelivery({
    outboundProviderMessageId,
    status,
    errorCode = "",
  }) {
    if (!databaseAvailable() || !outboundProviderMessageId) return null;

    const normalizedStatus = String(status || "").toLowerCase();
    const failed = ["failed", "undelivered"].includes(normalizedStatus);
    const delivered = normalizedStatus === "delivered";

    try {
      return await SafetyEvent.findOneAndUpdate(
      {
        outboundProviderMessageId,
      },
      {
        $set: {
          deliveryStatus: normalizedStatus,
          deliveryErrorCode: String(errorCode || ""),
          status: failed
            ? "delivery_failed"
            : delivered
              ? "delivered"
              : "reply_sent",
          deliveredAt: delivered ? new Date() : null,
        },
      },
      {
        returnDocument: "after",
      },
    );
    } catch (error) {
      MonitoringService.captureError("safety_delivery_audit_failed", error, {
        outboundProviderMessageId,
        status: normalizedStatus,
      });
      return null;
    }
  }
}

export default SafetyAuditService;
