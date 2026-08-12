import crypto from "crypto";

import CommunicationUsage from "../models/communicationUsage.js";
import AlertService from "./alert.service.js";
import normalizePhone from "../helpers/normalizePhone.js";
import { logOperationalError } from "../helpers/logging/safeLogger.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const positiveInteger = (value, fallback, minimum = 1, maximum = 1_000_000) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

const percent = (value, fallback = 80) =>
  positiveInteger(value, fallback, 50, 100);

const toPlainObject = (value) => {
  if (!value) return {};
  return typeof value.toObject === "function" ? value.toObject() : value;
};

const customerScopeKey = (phone) => {
  const normalized = normalizePhone(phone);
  if (!normalized) return "";
  return crypto.createHash("sha256").update(normalized).digest("hex");
};

export const TRIAL_COMMUNICATION_LIMITS = Object.freeze({
  smsBusinessHourly: positiveInteger(
    process.env.TRIAL_SMS_BUSINESS_HOURLY_LIMIT,
    25,
  ),
  smsBusinessDaily: positiveInteger(
    process.env.TRIAL_SMS_BUSINESS_DAILY_LIMIT,
    100,
  ),
  smsCustomerHourly: positiveInteger(
    process.env.TRIAL_SMS_CUSTOMER_HOURLY_LIMIT,
    8,
  ),
  smsCustomerDaily: positiveInteger(
    process.env.TRIAL_SMS_CUSTOMER_DAILY_LIMIT,
    20,
  ),
  aiBusinessHourly: positiveInteger(
    process.env.TRIAL_AI_BUSINESS_HOURLY_LIMIT,
    25,
  ),
  aiBusinessDaily: positiveInteger(
    process.env.TRIAL_AI_BUSINESS_DAILY_LIMIT,
    100,
  ),
  aiCustomerHourly: positiveInteger(
    process.env.TRIAL_AI_CUSTOMER_HOURLY_LIMIT,
    8,
  ),
  aiCustomerDaily: positiveInteger(
    process.env.TRIAL_AI_CUSTOMER_DAILY_LIMIT,
    20,
  ),
});

export const DEFAULT_COMMUNICATION_LIMITS = Object.freeze({
  smsBusinessHourly: positiveInteger(process.env.DEFAULT_SMS_BUSINESS_HOURLY_LIMIT, 300),
  smsBusinessDaily: positiveInteger(process.env.DEFAULT_SMS_BUSINESS_DAILY_LIMIT, 3000),
  smsCustomerHourly: positiveInteger(process.env.DEFAULT_SMS_CUSTOMER_HOURLY_LIMIT, 30),
  smsCustomerDaily: positiveInteger(process.env.DEFAULT_SMS_CUSTOMER_DAILY_LIMIT, 120),
  aiBusinessHourly: positiveInteger(process.env.DEFAULT_AI_BUSINESS_HOURLY_LIMIT, 150),
  aiBusinessDaily: positiveInteger(process.env.DEFAULT_AI_BUSINESS_DAILY_LIMIT, 1000),
  aiCustomerHourly: positiveInteger(process.env.DEFAULT_AI_CUSTOMER_HOURLY_LIMIT, 20),
  aiCustomerDaily: positiveInteger(process.env.DEFAULT_AI_CUSTOMER_DAILY_LIMIT, 60),
  alertThresholdPercent: percent(process.env.DEFAULT_COMMUNICATION_ALERT_THRESHOLD_PERCENT, 80),
});

export const getCommunicationLimits = (business) => {
  const plainBusiness = toPlainObject(business);
  const configured = toPlainObject(plainBusiness.communicationLimits);

  const limits = {
    smsBusinessHourly: positiveInteger(
      configured.smsBusinessHourly,
      DEFAULT_COMMUNICATION_LIMITS.smsBusinessHourly,
    ),
    smsBusinessDaily: positiveInteger(
      configured.smsBusinessDaily,
      DEFAULT_COMMUNICATION_LIMITS.smsBusinessDaily,
    ),
    smsCustomerHourly: positiveInteger(
      configured.smsCustomerHourly,
      DEFAULT_COMMUNICATION_LIMITS.smsCustomerHourly,
    ),
    smsCustomerDaily: positiveInteger(
      configured.smsCustomerDaily,
      DEFAULT_COMMUNICATION_LIMITS.smsCustomerDaily,
    ),
    aiBusinessHourly: positiveInteger(
      configured.aiBusinessHourly,
      DEFAULT_COMMUNICATION_LIMITS.aiBusinessHourly,
    ),
    aiBusinessDaily: positiveInteger(
      configured.aiBusinessDaily,
      DEFAULT_COMMUNICATION_LIMITS.aiBusinessDaily,
    ),
    aiCustomerHourly: positiveInteger(
      configured.aiCustomerHourly,
      DEFAULT_COMMUNICATION_LIMITS.aiCustomerHourly,
    ),
    aiCustomerDaily: positiveInteger(
      configured.aiCustomerDaily,
      DEFAULT_COMMUNICATION_LIMITS.aiCustomerDaily,
    ),
    alertThresholdPercent: percent(
      configured.alertThresholdPercent,
      DEFAULT_COMMUNICATION_LIMITS.alertThresholdPercent,
    ),
  };

  /*
   * Trial accounts get the real CallBackIQ workflow, but expensive provider
   * usage is capped below normal paid-account allowances.
   */
  if (plainBusiness?.trialCostControls?.enabled === true) {
    for (const key of Object.keys(TRIAL_COMMUNICATION_LIMITS)) {
      limits[key] = Math.min(
        limits[key],
        TRIAL_COMMUNICATION_LIMITS[key],
      );
    }
  }

  return limits;
};

const getWindowStart = (window, now) => {
  const date = new Date(now);
  if (window === "hour") {
    date.setUTCMinutes(0, 0, 0);
  } else {
    date.setUTCHours(0, 0, 0, 0);
  }
  return date;
};

const getExpiry = (windowStart, window) =>
  new Date(windowStart.getTime() + (window === "hour" ? 3 * HOUR_MS : 3 * DAY_MS));

const buildSpecs = ({ business, customerPhone, metric, now }) => {
  const businessId = business?._id || business?.id || business;
  const normalizedCustomer = customerScopeKey(customerPhone);
  const limits = getCommunicationLimits(business);
  const isSms = metric === "sms_outbound";
  const prefix = isSms ? "sms" : "ai";
  const specs = [
    {
      businessId,
      scope: "business",
      scopeKey: String(businessId),
      metric,
      window: "hour",
      windowStart: getWindowStart("hour", now),
      limit: limits[`${prefix}BusinessHourly`],
    },
    {
      businessId,
      scope: "business",
      scopeKey: String(businessId),
      metric,
      window: "day",
      windowStart: getWindowStart("day", now),
      limit: limits[`${prefix}BusinessDaily`],
    },
  ];

  if (normalizedCustomer) {
    specs.push(
      {
        businessId,
        scope: "customer",
        scopeKey: normalizedCustomer,
        metric,
        window: "hour",
        windowStart: getWindowStart("hour", now),
        limit: limits[`${prefix}CustomerHourly`],
      },
      {
        businessId,
        scope: "customer",
        scopeKey: normalizedCustomer,
        metric,
        window: "day",
        windowStart: getWindowStart("day", now),
        limit: limits[`${prefix}CustomerDaily`],
      },
    );
  }

  return { specs, limits };
};

const reserveCounter = async (spec, amount = 1, mongoSession = null) => {
  const identity = {
    business: spec.businessId,
    scope: spec.scope,
    scopeKey: spec.scopeKey,
    metric: spec.metric,
    window: spec.window,
    windowStart: spec.windowStart,
  };

  try {
    return await CommunicationUsage.findOneAndUpdate(
      {
        ...identity,
        $or: [{ count: { $lte: spec.limit - amount } }, { count: { $exists: false } }],
      },
      {
        $setOnInsert: {
          ...identity,
          expiresAt: getExpiry(spec.windowStart, spec.window),
        },
        $inc: { count: amount },
      },
      {
        upsert: true,
        returnDocument: "after",
        ...(mongoSession ? { session: mongoSession } : {}),
      },
    );
  } catch (error) {
    // When the row exists at its limit, the attempted upsert collides with the
    // unique identity index. Treat that as an ordinary denied reservation.
    if (error?.code === 11000) return null;
    throw error;
  }
};

const rollback = async (documents, amount = 1, mongoSession = null) => {
  const releaseAmount = Math.max(1, Math.floor(Number(amount) || 1));
  const results = await Promise.allSettled(
    documents
      .filter(Boolean)
      .map((document) =>
        CommunicationUsage.updateOne(
          { _id: document._id },
          [
            {
              $set: {
                count: {
                  $max: [
                    0,
                    {
                      $subtract: [
                        { $ifNull: ["$count", 0] },
                        releaseAmount,
                      ],
                    },
                  ],
                },
              },
            },
          ],
          mongoSession ? { session: mongoSession } : undefined,
        ),
      ),
  );
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected) throw rejected.reason;
};

// CALLBACKIQ_PRODUCTION_READINESS: reversible provider reservations.
export const releaseCommunicationUsage = async ({
  reservations = [],
  amount = 1,
  mongoSession = null,
} = {}) => {
  const documents = reservations
    .map((item) => (item?._id ? item : item ? { _id: item } : null))
    .filter(Boolean);
  const releaseAmount = Math.max(1, Math.floor(Number(amount) || 1));
  await rollback(documents, releaseAmount, mongoSession);
  return { released: documents.length, amount: releaseAmount };
};

const createThresholdAlert = async ({ businessId, spec, document, thresholdPercent }) => {
  const ratio = document.count / spec.limit;
  if (ratio * 100 < thresholdPercent) return;

  const percentage = Math.min(100, Math.round(ratio * 100));
  const audience = spec.scope === "business" ? "business" : "customer";
  const metricLabel = spec.metric === "sms_outbound" ? "outbound SMS" : "AI reply";
  const windowLabel = spec.window === "hour" ? "hourly" : "daily";

  try {
    await AlertService.createSystemAlert({
      businessId,
      title: `${metricLabel} usage is at ${percentage}%`,
      message: `The ${audience} ${windowLabel} ${metricLabel} allowance has used ${document.count} of ${spec.limit}. Review unusual traffic before the allowance is exhausted.`,
      priority: percentage >= 100 ? "high" : "medium",
      metadata: {
        source: "communication_usage_budget",
        metric: spec.metric,
        scope: spec.scope,
        window: spec.window,
        count: document.count,
        limit: spec.limit,
        percentage,
      },
      dedupeKey: `communication_usage:${spec.metric}:${spec.scope}:${spec.scopeKey}:${spec.window}:${spec.windowStart.toISOString()}`,
    });
  } catch (error) {
    // Alert persistence must never consume or reject an otherwise valid send.
    logOperationalError("communication_usage.threshold_alert_failed", error, {
      businessId,
      metric: spec.metric,
      scope: spec.scope,
      window: spec.window,
    });
  }
};

export const emitCommunicationUsageThresholdAlerts = async ({
  businessId,
  thresholdAlerts = [],
  thresholdPercent = DEFAULT_COMMUNICATION_LIMITS.alertThresholdPercent,
} = {}) => {
  for (const item of thresholdAlerts) {
    if (!item?.spec || !item?.document) continue;
    await createThresholdAlert({
      businessId,
      spec: item.spec,
      document: item.document,
      thresholdPercent,
    });
  }
};

const shouldFailClosed = () => {
  if (process.env.COMMUNICATION_USAGE_FAIL_CLOSED === "true") return true;
  if (process.env.COMMUNICATION_USAGE_FAIL_CLOSED === "false") return false;
  return String(process.env.NODE_ENV || "development").toLowerCase() === "production";
};

export const reserveCommunicationUsage = async ({
  business,
  customerPhone = "",
  metric,
  bypass = false,
  amount = 1,
  now = new Date(),
  mongoSession = null,
  suppressAlerts = false,
  throwOnInfrastructureError = false,
}) => {
  const reservationAmount = Math.max(1, Math.floor(Number(amount) || 1));
  if (bypass) return { allowed: true, bypassed: true, amount: reservationAmount, reservations: [] };
  if (!business?._id && !business?.id) {
    return { allowed: false, reason: "business_context_required", reservations: [] };
  }
  if (!["sms_outbound", "ai_operation"].includes(metric)) {
    throw new Error(`Unsupported communication usage metric: ${metric}`);
  }

  if (CommunicationUsage.db && CommunicationUsage.db.readyState !== 1) {
    if (throwOnInfrastructureError) {
      const error = new Error("Communication usage tracking is unavailable.");
      error.code = "COMMUNICATION_USAGE_UNAVAILABLE";
      throw error;
    }
    return shouldFailClosed()
      ? {
          allowed: false,
          reason: "usage_tracking_unavailable",
          reservations: [],
        }
      : {
          allowed: true,
          degraded: true,
          reason: "usage_tracking_unavailable",
          reservations: [],
        };
  }

  const { specs, limits } = buildSpecs({ business, customerPhone, metric, now });
  const reserved = [];
  const thresholdAlerts = [];

  try {
    for (const spec of specs) {
      const document = await reserveCounter(spec, reservationAmount, mongoSession);
      if (!document) {
        await rollback(reserved, reservationAmount, mongoSession);
        thresholdAlerts.push({ spec, document: { count: spec.limit } });
        if (!suppressAlerts) {
          await emitCommunicationUsageThresholdAlerts({
            businessId: business._id || business.id,
            thresholdAlerts,
            thresholdPercent: limits.alertThresholdPercent,
          });
        }
        return {
          allowed: false,
          reason: `${spec.scope}_${spec.window}_${metric}_limit`,
          limit: spec.limit,
          scope: spec.scope,
          window: spec.window,
          reservations: [],
          thresholdAlerts,
          thresholdPercent: limits.alertThresholdPercent,
        };
      }

      reserved.push(document);
      thresholdAlerts.push({ spec, document });
    }

    if (!suppressAlerts) {
      await emitCommunicationUsageThresholdAlerts({
        businessId: business._id || business.id,
        thresholdAlerts,
        thresholdPercent: limits.alertThresholdPercent,
      });
    }
    return {
      allowed: true,
      amount: reservationAmount,
      reservations: reserved,
      thresholdAlerts,
      thresholdPercent: limits.alertThresholdPercent,
    };
  } catch (error) {
    await rollback(reserved, reservationAmount, mongoSession);
    logOperationalError("communication_usage.reservation_failed", error, {
      businessId: business._id || business.id,
      metric,
    });

    if (throwOnInfrastructureError) throw error;
    if (shouldFailClosed()) {
      return {
        allowed: false,
        reason: "usage_tracking_unavailable",
        reservations: [],
      };
    }

    return {
      allowed: true,
      degraded: true,
      reason: "usage_tracking_unavailable",
      reservations: [],
    };
  }
};

export const reserveSmsUsage = (parameters) =>
  reserveCommunicationUsage({ ...parameters, metric: "sms_outbound" });

export const reserveAiUsage = (parameters) =>
  reserveCommunicationUsage({ ...parameters, metric: "ai_operation" });

export default {
  DEFAULT_COMMUNICATION_LIMITS,
  TRIAL_COMMUNICATION_LIMITS,
  getCommunicationLimits,
  emitCommunicationUsageThresholdAlerts,
  reserveCommunicationUsage,
  reserveSmsUsage,
  reserveAiUsage,
  releaseCommunicationUsage,
};
