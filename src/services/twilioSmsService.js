import twilio from "twilio";

import Business from "../models/business.js";
import Message from "../models/message.js";
import normalizePhone from "../helpers/normalizePhone.js";
import { isSmsSuppressed, optOutSms } from "./messaging/contactPreference.service.js";
import { reserveSmsUsage } from "./communicationUsage.service.js";
import { recordOutboundSmsAudit } from "./outboundSmsAudit.service.js";
import {
  ensureOptOutDisclosure,
  estimateSmsSegments,
  evaluateSmsSendWindow,
  normalizeSmsPhone,
} from "./messaging/smsCompliance.service.js";

let twilioClient = null;
let cachedAccountSid = "";
let cachedAuthToken = "";

const getCredentials = () => ({
  accountSid: String(process.env.TWILIO_ACCOUNT_SID || "").trim(),
  authToken: String(process.env.TWILIO_AUTH_TOKEN || "").trim(),
});

export const getTwilioClient = () => {
  const { accountSid, authToken } = getCredentials();
  if (!accountSid || !authToken) {
    const error = new Error("Twilio credentials are not configured.");
    error.code = "TWILIO_NOT_CONFIGURED";
    throw error;
  }
  if (!twilioClient || accountSid !== cachedAccountSid || authToken !== cachedAuthToken) {
    twilioClient = twilio(accountSid, authToken);
    cachedAccountSid = accountSid;
    cachedAuthToken = authToken;
  }
  return twilioClient;
};

const requiredText = (value, fieldName) => {
  const normalized = String(value || "").trim();
  if (!normalized) {
    const error = new Error(`${fieldName} is required.`);
    error.code = "INVALID_SMS_PAYLOAD";
    throw error;
  }
  return normalized;
};

const resolveBusiness = async ({ business, businessId, from }) => {
  const suppliedBusinessId = business?._id || business?.id || null;
  if (suppliedBusinessId && businessId && String(suppliedBusinessId) !== String(businessId)) {
    const error = new Error("Outbound SMS business context does not match.");
    error.code = "SMS_BUSINESS_CONTEXT_MISMATCH";
    throw error;
  }
  const candidateId = suppliedBusinessId || businessId || null;
  const normalizedFrom = normalizePhone(from);
  const fromCandidates = [String(from || "").trim(), normalizedFrom].filter(
    (value, index, values) => value && values.indexOf(value) === index,
  );
  const resolved = business
    ? business
    : candidateId
      ? await Business.findById(candidateId)
      : fromCandidates.length
        ? await Business.findOne({ phone: { $in: fromCandidates } })
        : null;
  if (!resolved || resolved.isActive === false) {
    const error = new Error(
      candidateId || normalizedFrom
        ? "The business SMS sender could not be resolved."
        : "Business context is required for outbound SMS.",
    );
    error.code = candidateId || normalizedFrom
      ? "SMS_BUSINESS_NOT_FOUND"
      : "SMS_BUSINESS_CONTEXT_REQUIRED";
    throw error;
  }
  return resolved;
};

const getStatusCallback = () => {
  const explicit = String(process.env.TWILIO_SMS_STATUS_CALLBACK_URL || "").trim();
  if (explicit) return explicit;
  if (process.env.NODE_ENV === "test") return "";
  const base = String(
    process.env.TWILIO_WEBHOOK_BASE_URL || process.env.VOICE_HTTP_PUBLIC_URL || "",
  )
    .trim()
    .replace(/\/+$/, "");
  return base ? `${base}/api/twilio/status` : "";
};

const audit = (payload) => recordOutboundSmsAudit(payload);

const shouldAppendFirstContactFooter = async ({
  businessId,
  to,
  source,
  requireOptOutDisclosure,
}) => {
  if (requireOptOutDisclosure || source === "missed_call_recovery") return true;
  if (source === "compliance" || source === "inbound_sms_command") return false;
  if (process.env.NODE_ENV === "test") return false;
  if (
    String(process.env.SMS_ENFORCE_FIRST_CONTACT_DISCLOSURE || "true").toLowerCase() ===
    "false"
  ) {
    return false;
  }
  const priorOutbound = await Message.exists({
    business: businessId,
    direction: "outbound",
    to,
  });
  return !priorOutbound;
};

export const sendSms = async ({
  to,
  from = "",
  body,
  businessId = null,
  business = null,
  allowOptedOut = false,
  bypassUsageLimits = false,
  bypassQuietHours = false,
  directResponse = false,
  requireOptOutDisclosure = false,
  actorId = null,
  actorType = "system",
  source = "system",
  usageCategory = "sms",
  conversationId = null,
  leadId = null,
  metadata = {},
  messagingServiceSid = "",
}) => {
  const rawTo = requiredText(to, "to");
  const normalizedTo = normalizeSmsPhone(rawTo) || normalizePhone(rawTo);
  if (!normalizeSmsPhone(normalizedTo)) {
    const error = new Error("The SMS destination must be a valid U.S. E.164 number.");
    error.code = "INVALID_SMS_DESTINATION";
    throw error;
  }

  const resolvedBusiness = await resolveBusiness({ business, businessId, from });
  const resolvedBusinessId = resolvedBusiness._id || resolvedBusiness.id;
  const configuredFrom = requiredText(resolvedBusiness.phone, "business SMS phone");
  if (from && normalizePhone(from) !== normalizePhone(configuredFrom)) {
    const error = new Error(
      "The requested SMS sender is not assigned to the authenticated business.",
    );
    error.code = "SMS_SENDER_NOT_OWNED";
    throw error;
  }

  let normalizedBody = requiredText(body, "body");
  if (
    await shouldAppendFirstContactFooter({
      businessId: resolvedBusinessId,
      to: normalizedTo,
      source,
      requireOptOutDisclosure,
    })
  ) {
    normalizedBody = ensureOptOutDisclosure(normalizedBody);
  }

  const segment = estimateSmsSegments(normalizedBody);
  const maximumSegments = Math.max(
    1,
    Number(process.env.SMS_MAX_SEGMENTS_PER_MESSAGE || 10),
  );
  if (segment.segmentCount > maximumSegments) {
    const error = new Error(
      `SMS exceeds the configured ${maximumSegments}-segment maximum.`,
    );
    error.code = "SMS_SEGMENT_LIMIT_EXCEEDED";
    throw error;
  }

  if (!allowOptedOut) {
    const suppressed = await isSmsSuppressed({
      businessId: resolvedBusinessId,
      phone: normalizedTo,
    });
    if (suppressed) {
      const result = {
        sid: "",
        status: "suppressed",
        suppressed: true,
        reason: "customer_opted_out",
        to: normalizedTo,
        from: configuredFrom,
        body: normalizedBody,
        ...segment,
      };
      await audit({
        businessId: resolvedBusinessId,
        actorId,
        actorType,
        source,
        usageCategory,
        conversationId,
        leadId,
        from: configuredFrom,
        to: normalizedTo,
        body: normalizedBody,
        status: "suppressed",
        reason: result.reason,
        metadata: { ...metadata, segment },
      });
      return result;
    }
  }

  const sendWindow = evaluateSmsSendWindow({
    business: resolvedBusiness,
    category: usageCategory,
    directResponse,
    bypassQuietHours,
  });
  if (!sendWindow.allowed) {
    const result = {
      sid: "",
      status: "blocked",
      suppressed: true,
      policyBlocked: true,
      reason: sendWindow.reason,
      to: normalizedTo,
      from: configuredFrom,
      body: normalizedBody,
      sendWindow,
      ...segment,
    };
    await audit({
      businessId: resolvedBusinessId,
      actorId,
      actorType,
      source,
      usageCategory,
      conversationId,
      leadId,
      from: configuredFrom,
      to: normalizedTo,
      body: normalizedBody,
      status: "blocked",
      reason: result.reason,
      metadata: { ...metadata, segment, sendWindow },
    });
    return result;
  }

  const usageRequest = {
    business: resolvedBusiness,
    customerPhone: normalizedTo,
    bypass: bypassUsageLimits || allowOptedOut || usageCategory === "safety",
  };
  if (segment.segmentCount > 1) usageRequest.amount = segment.segmentCount;
  const usage = await reserveSmsUsage(usageRequest);
  if (!usage.allowed) {
    const result = {
      sid: "",
      status: "blocked",
      suppressed: true,
      policyBlocked: true,
      reason: usage.reason || "communication_usage_limit",
      to: normalizedTo,
      from: configuredFrom,
      body: normalizedBody,
      usage,
      ...segment,
    };
    await audit({
      businessId: resolvedBusinessId,
      actorId,
      actorType,
      source,
      usageCategory,
      conversationId,
      leadId,
      from: configuredFrom,
      to: normalizedTo,
      body: normalizedBody,
      status: "blocked",
      reason: result.reason,
      metadata: { ...metadata, segment, sendWindow },
    });
    return result;
  }

  try {
    const client = getTwilioClient();
    const configuredMessagingServiceSid = String(messagingServiceSid || "").trim();
    const statusCallback = getStatusCallback();
    const sent = await client.messages.create({
      to: normalizedTo,
      body: normalizedBody,
      ...(configuredMessagingServiceSid
        ? { messagingServiceSid: configuredMessagingServiceSid }
        : { from: configuredFrom }),
      ...(statusCallback ? { statusCallback } : {}),
    });
    await audit({
      businessId: resolvedBusinessId,
      actorId,
      actorType,
      source,
      usageCategory,
      conversationId,
      leadId,
      from: configuredFrom,
      to: normalizedTo,
      body: normalizedBody,
      providerMessageId: sent?.sid || "",
      status: "sent",
      metadata: { ...metadata, segment, sendWindow, statusCallback },
    });
    return {
      ...sent,
      sid: sent?.sid || "",
      status: sent?.status || "sent",
      suppressed: false,
      to: sent?.to || normalizedTo,
      from: sent?.from || configuredFrom,
      usage,
      sendWindow,
      ...segment,
      body: normalizedBody,
    };
  } catch (error) {
    const providerCode = Number(error?.code || 0);
    if (providerCode === 21610) {
      let preferenceSyncFailed = false;
      try {
        await optOutSms({
          businessId: resolvedBusinessId,
          phone: normalizedTo,
          source: "twilio_provider_21610",
          keyword: "STOP",
        });
      } catch {
        preferenceSyncFailed = true;
      }
      const result = {
        sid: "",
        status: "suppressed",
        suppressed: true,
        reason: "customer_opted_out",
        providerCode,
        to: normalizedTo,
        from: configuredFrom,
        body: normalizedBody,
        usage,
        ...segment,
      };
      await audit({
        businessId: resolvedBusinessId,
        actorId,
        actorType,
        source,
        usageCategory,
        conversationId,
        leadId,
        from: configuredFrom,
        to: normalizedTo,
        body: normalizedBody,
        status: "suppressed",
        reason: result.reason,
        metadata: {
          ...metadata,
          segment,
          sendWindow,
          providerCode,
          preferenceSyncFailed,
        },
      });
      return result;
    }

    await audit({
      businessId: resolvedBusinessId,
      actorId,
      actorType,
      source,
      usageCategory,
      conversationId,
      leadId,
      from: configuredFrom,
      to: normalizedTo,
      body: normalizedBody,
      status: "failed",
      reason: error?.code || error?.message || "provider_error",
      metadata: { ...metadata, segment, sendWindow },
    });
    throw error;
  }
};

export const resetTwilioClient = () => {
  twilioClient = null;
  cachedAccountSid = "";
  cachedAuthToken = "";
};
