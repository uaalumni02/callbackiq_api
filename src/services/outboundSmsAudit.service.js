import crypto from "crypto";

import OutboundSmsAudit from "../models/outboundSmsAudit.js";
import { logOperationalError } from "../helpers/logging/safeLogger.js";

const hashBody = (body) =>
  crypto.createHash("sha256").update(String(body || "")).digest("hex");

export const recordOutboundSmsAudit = async ({
  businessId,
  actorId = null,
  actorType = "system",
  source = "system",
  usageCategory = "sms",
  conversationId = null,
  leadId = null,
  from,
  to,
  body,
  providerMessageId = "",
  status,
  reason = "",
  metadata = {},
}) => {
  if (!businessId) return null;
  if (OutboundSmsAudit.db && OutboundSmsAudit.db.readyState !== 1) return null;

  try {
    return await OutboundSmsAudit.create({
      business: businessId,
      actor: actorId || null,
      actorType,
      source,
      usageCategory,
      conversation: conversationId || null,
      lead: leadId || null,
      from,
      to,
      bodyHash: hashBody(body),
      bodyLength: String(body || "").length,
      providerMessageId,
      status,
      reason,
      metadata,
    });
  } catch (error) {
    // A provider-accepted SMS must never be retried because audit persistence
    // failed. Provider SID uniqueness makes later reconciliation possible.
    logOperationalError("outbound_sms.audit_failed", error, {
      businessId,
      providerMessageId,
      status,
      source,
    });
    return null;
  }
};

export default { recordOutboundSmsAudit };
