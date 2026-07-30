import twilio from "twilio";

import Business from "../models/business.js";
import normalizePhone from "../helpers/normalizePhone.js";
import { isSmsSuppressed } from "./messaging/contactPreference.service.js";
import { reserveSmsUsage } from "./communicationUsage.service.js";
import { recordOutboundSmsAudit } from "./outboundSmsAudit.service.js";

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
  if (
    !twilioClient ||
    accountSid !== cachedAccountSid ||
    authToken !== cachedAuthToken
  ) {
    twilioClient = twilio(accountSid, authToken);
    cachedAccountSid = accountSid;
    cachedAuthToken = authToken;
  }
  return twilioClient;
};

const normalizeRequiredText = (value, fieldName) => {
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
  if (
    suppliedBusinessId &&
    businessId &&
    String(suppliedBusinessId) !== String(businessId)
  ) {
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

const audit = (payload) => recordOutboundSmsAudit(payload);

export const sendSms = async ({
  to,
  from = "",
  body,
  businessId = null,
  business = null,
  allowOptedOut = false,
  bypassUsageLimits = false,
  actorId = null,
  actorType = "system",
  source = "system",
  usageCategory = "sms",
  conversationId = null,
  leadId = null,
  metadata = {},
  messagingServiceSid = "",
}) => {
  const normalizedTo = normalizeRequiredText(to, "to");
  const normalizedBody = normalizeRequiredText(body, "body");
  const resolvedBusiness = await resolveBusiness({ business, businessId, from });
  const resolvedBusinessId = resolvedBusiness._id || resolvedBusiness.id;
  const configuredFrom = normalizeRequiredText(
    resolvedBusiness.phone,
    "business SMS phone",
  );

  if (from && normalizePhone(from) !== normalizePhone(configuredFrom)) {
    const error = new Error(
      "The requested SMS sender is not assigned to the authenticated business.",
    );
    error.code = "SMS_SENDER_NOT_OWNED";
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
        metadata,
      });
      return result;
    }
  }

  const usage = await reserveSmsUsage({
    business: resolvedBusiness,
    customerPhone: normalizedTo,
    bypass: bypassUsageLimits || allowOptedOut || usageCategory === "safety",
  });

  if (!usage.allowed) {
    const result = {
      sid: "",
      status: "blocked",
      suppressed: true,
      policyBlocked: true,
      reason: usage.reason || "communication_usage_limit",
      to: normalizedTo,
      from: configuredFrom,
      usage,
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
      metadata,
    });
    return result;
  }

  try {
    const client = getTwilioClient();
    const configuredMessagingServiceSid = String(messagingServiceSid || "").trim();
    const sent = await client.messages.create({
      to: normalizedTo,
      body: normalizedBody,
      ...(configuredMessagingServiceSid
        ? { messagingServiceSid: configuredMessagingServiceSid }
        : { from: configuredFrom }),
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
      metadata,
    });

    return {
      ...sent,
      sid: sent?.sid || "",
      status: sent?.status || "sent",
      suppressed: false,
      to: sent?.to || normalizedTo,
      from: sent?.from || configuredFrom,
      usage,
    };
  } catch (error) {
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
      metadata,
    });
    throw error;
  }
};

export const resetTwilioClient = () => {
  twilioClient = null;
  cachedAccountSid = "";
  cachedAuthToken = "";
};
