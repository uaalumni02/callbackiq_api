import crypto from "node:crypto";
import twilio from "twilio";

import Business from "../models/business.js";
import normalizePhone from "../helpers/normalizePhone.js";
import { isSmsSuppressed, optOutSms } from "./messaging/contactPreference.service.js";
import { recordOutboundSmsAudit } from "./outboundSmsAudit.service.js";
import {
  reserveCommunicationUsageOperation,
  commitCommunicationUsageReservation,
  findCommunicationOperation,
  isUncertainProviderFailure,
  markCommunicationUsageUncertain,
  releaseCommunicationUsageReservation,
} from "./communicationUsageReservation.service.js";
import {
  claimSmsContactDisclosure,
  commitSmsContactDisclosure,
  releaseSmsContactDisclosure,
} from "./smsContactDisclosure.service.js";
import { logOperationalError } from "../helpers/logging/safeLogger.js";
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
    const error = new Error("The requested SMS sender is not assigned to the authenticated business.");
    error.code = "SMS_SENDER_NOT_OWNED";
    throw error;
  }
  let normalizedBody = requiredText(body, "body");
  const explicitKey = String(metadata?.idempotencyKey || "").trim();
  const operationKey = explicitKey
    ? explicitKey.slice(0, 240)
    : `sms:${resolvedBusinessId}:${crypto.randomUUID()}`;
  const replay = await findCommunicationOperation(operationKey);
  if (replay?.state === "committed") {
    return {
      sid: replay.providerOperationId || "",
      status: replay.providerStatus || "sent",
      suppressed: false,
      replayed: true,
      to: normalizedTo,
      from: configuredFrom,
      body: normalizedBody,
      segmentCount: replay.amount || 1,
    };
  }
  if (replay && ["pending", "uncertain"].includes(replay.state)) {
    const error = new Error("The provider outcome for this SMS is still being reconciled. Do not resend with a new idempotency key.");
    error.code = "SMS_DELIVERY_RECONCILIATION_REQUIRED";
    error.statusCode = 409;
    error.operationKey = operationKey;
    throw error;
  }
  const disclosure = await claimSmsContactDisclosure({
    businessId: resolvedBusinessId,
    phone: normalizedTo,
    source,
    requireOptOutDisclosure,
    operationKey,
  });
  if (disclosure.append) normalizedBody = ensureOptOutDisclosure(normalizedBody);
  const segment = estimateSmsSegments(normalizedBody);
  const maximumSegments = Math.max(1, Number(process.env.SMS_MAX_SEGMENTS_PER_MESSAGE || 10));
  if (segment.segmentCount > maximumSegments) {
    await releaseSmsContactDisclosure({ claim: disclosure.claim });
    const error = new Error(`SMS exceeds the configured ${maximumSegments}-segment maximum.`);
    error.code = "SMS_SEGMENT_LIMIT_EXCEEDED";
    throw error;
  }
  const safeAudit = async (payload) => {
    try { await audit(payload); }
    catch (error) {
      logOperationalError("sms.outbound_audit_failed", error, {
        businessId: resolvedBusinessId,
        providerMessageId: payload?.providerMessageId || "",
        operationKey,
      });
    }
  };
  if (!allowOptedOut) {
    const suppressed = await isSmsSuppressed({ businessId: resolvedBusinessId, phone: normalizedTo });
    if (suppressed) {
      const result = { sid: "", status: "suppressed", suppressed: true, reason: "customer_opted_out", to: normalizedTo, from: configuredFrom, body: normalizedBody, ...segment };
      await releaseSmsContactDisclosure({ claim: disclosure.claim });
      await safeAudit({ businessId: resolvedBusinessId, actorId, actorType, source, usageCategory, conversationId, leadId, from: configuredFrom, to: normalizedTo, body: normalizedBody, status: "suppressed", reason: result.reason, metadata: { ...metadata, segment, operationKey } });
      return result;
    }
  }
  const sendWindow = evaluateSmsSendWindow({ business: resolvedBusiness, category: usageCategory, directResponse, bypassQuietHours });
  if (!sendWindow.allowed) {
    const result = { sid: "", status: "blocked", suppressed: true, policyBlocked: true, reason: sendWindow.reason, to: normalizedTo, from: configuredFrom, body: normalizedBody, sendWindow, ...segment };
    await releaseSmsContactDisclosure({ claim: disclosure.claim });
    await safeAudit({ businessId: resolvedBusinessId, actorId, actorType, source, usageCategory, conversationId, leadId, from: configuredFrom, to: normalizedTo, body: normalizedBody, status: "blocked", reason: result.reason, metadata: { ...metadata, segment, sendWindow, operationKey } });
    return result;
  }
  const lifecycle = await reserveCommunicationUsageOperation({
    business: resolvedBusiness,
    customerPhone: normalizedTo,
    metric: "sms_outbound",
    bypass: bypassUsageLimits || allowOptedOut || usageCategory === "safety",
    amount: segment.segmentCount,
    key: operationKey,
    source,
    metadata: { conversationId, leadId, to: normalizedTo },
  });
  const usage = lifecycle?.usage || {
    allowed: true,
    replayed: Boolean(lifecycle?.replayed),
    amount: lifecycle?.reservation?.amount || segment.segmentCount,
    reservations: [],
  };
  if (!lifecycle?.allowed) {
    const result = { sid: "", status: "blocked", suppressed: true, policyBlocked: true, reason: usage.reason || "communication_usage_limit", to: normalizedTo, from: configuredFrom, body: normalizedBody, usage, ...segment };
    await releaseSmsContactDisclosure({ claim: disclosure.claim });
    await safeAudit({ businessId: resolvedBusinessId, actorId, actorType, source, usageCategory, conversationId, leadId, from: configuredFrom, to: normalizedTo, body: normalizedBody, status: "blocked", reason: result.reason, metadata: { ...metadata, segment, sendWindow, operationKey } });
    return result;
  }
  if (lifecycle?.replayed) {
    const state = lifecycle.reservation?.state;
    if (state === "committed") {
      return { sid: lifecycle.reservation.providerOperationId || "", status: lifecycle.reservation.providerStatus || "sent", suppressed: false, replayed: true, to: normalizedTo, from: configuredFrom, body: normalizedBody, ...segment };
    }
    const error = new Error("This SMS operation is already in progress or awaiting provider reconciliation.");
    error.code = "SMS_DELIVERY_RECONCILIATION_REQUIRED";
    error.statusCode = 409;
    throw error;
  }
  try {
    const client = getTwilioClient();
    const configuredMessagingServiceSid = String(messagingServiceSid || "").trim();
    const statusCallback = getStatusCallback();
    const sent = await client.messages.create({
      to: normalizedTo,
      body: normalizedBody,
      ...(configuredMessagingServiceSid ? { messagingServiceSid: configuredMessagingServiceSid } : { from: configuredFrom }),
      ...(statusCallback ? { statusCallback } : {}),
    });
    await commitCommunicationUsageReservation({ reservation: lifecycle?.reservation, providerOperationId: sent?.sid || "", providerStatus: sent?.status || "sent" });
    await commitSmsContactDisclosure({
      claim: disclosure.claim,
      businessId: resolvedBusinessId,
      phone: normalizedTo,
      operationKey,
      providerMessageId: sent?.sid || "",
    });
    await safeAudit({ businessId: resolvedBusinessId, actorId, actorType, source, usageCategory, conversationId, leadId, from: configuredFrom, to: normalizedTo, body: normalizedBody, providerMessageId: sent?.sid || "", status: "sent", metadata: { ...metadata, segment, sendWindow, statusCallback, operationKey } });
    return { ...sent, sid: sent?.sid || "", status: sent?.status || "sent", suppressed: false, to: sent?.to || normalizedTo, from: sent?.from || configuredFrom, usage, sendWindow, ...segment, body: normalizedBody, operationKey };
  } catch (error) {
    const providerCode = Number(error?.code || 0);
    if (providerCode === 21610) {
      let preferenceSyncFailed = false;
      try { await optOutSms({ businessId: resolvedBusinessId, phone: normalizedTo, source: "twilio_provider_21610", keyword: "STOP" }); }
      catch { preferenceSyncFailed = true; }
      await releaseCommunicationUsageReservation({ reservation: lifecycle?.reservation, usage, reason: "provider_21610_opt_out" });
      await releaseSmsContactDisclosure({ claim: disclosure.claim });
      const result = { sid: "", status: "suppressed", suppressed: true, reason: "customer_opted_out", providerCode, to: normalizedTo, from: configuredFrom, body: normalizedBody, usage, ...segment };
      await safeAudit({ businessId: resolvedBusinessId, actorId, actorType, source, usageCategory, conversationId, leadId, from: configuredFrom, to: normalizedTo, body: normalizedBody, status: "suppressed", reason: result.reason, metadata: { ...metadata, segment, sendWindow, providerCode, preferenceSyncFailed, operationKey } });
      return result;
    }
    if (isUncertainProviderFailure(error)) {
      await markCommunicationUsageUncertain({ reservation: lifecycle?.reservation, error });
      error.code = error.code || "SMS_PROVIDER_OUTCOME_UNCERTAIN";
      error.statusCode = error.statusCode || 503;
      error.deliveryUncertain = true;
    } else {
      await releaseCommunicationUsageReservation({ reservation: lifecycle?.reservation, usage, reason: error?.code || "provider_rejected" });
      await releaseSmsContactDisclosure({ claim: disclosure.claim });
    }
    await safeAudit({ businessId: resolvedBusinessId, actorId, actorType, source, usageCategory, conversationId, leadId, from: configuredFrom, to: normalizedTo, body: normalizedBody, status: "failed", reason: error?.code || error?.message || "provider_error", metadata: { ...metadata, segment, sendWindow, operationKey, deliveryUncertain: Boolean(error.deliveryUncertain) } });
    throw error;
  }
};

export const resetTwilioClient = () => {
  twilioClient = null;
  cachedAccountSid = "";
  cachedAuthToken = "";
};
