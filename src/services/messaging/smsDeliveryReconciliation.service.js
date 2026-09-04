import mongoose from "mongoose";
import crypto from "node:crypto";
import SmsDeliveryReconciliationEvent from "../../models/smsDeliveryReconciliationEvent.js";

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 20;

const leaseMs = () => {
  const configured = Number(process.env.SMS_DELIVERY_RECONCILIATION_LEASE_MS);
  return Number.isFinite(configured) && configured >= 10_000
    ? Math.min(300_000, configured)
    : DEFAULT_LEASE_MS;
};

const maxAttempts = () => {
  const configured = Number(
    process.env.SMS_DELIVERY_RECONCILIATION_MAX_ATTEMPTS,
  );
  return Number.isFinite(configured) && configured >= 1
    ? Math.min(50, Math.floor(configured))
    : DEFAULT_MAX_ATTEMPTS;
};

const retryDelayMs = (attemptCount) =>
  Math.min(
    15 * 60_000,
    Math.max(1_000, 1_000 * 2 ** Math.max(0, attemptCount - 1)),
  );

export const buildSmsDeliveryEventKey = ({
  providerMessageId,
  providerStatus,
  errorCode = "",
}) =>
  [providerMessageId, providerStatus, String(errorCode || "")].join(":");

export const enqueueSmsDeliveryReconciliationEvent = async ({
  businessId,
  payload = {},
}) => {
  const providerMessageId = String(
    payload.MessageSid || payload.SmsSid || "",
  ).trim();
  const providerStatus = String(
    payload.MessageStatus || payload.SmsStatus || "",
  )
    .trim()
    .toLowerCase();
  const errorCode = String(payload.ErrorCode || "").trim();

  if (!businessId || !providerMessageId || !providerStatus) return null;
  if (!mongoose.isValidObjectId(businessId)) return null;

  const eventKey = buildSmsDeliveryEventKey({
    providerMessageId,
    providerStatus,
    errorCode,
  });

  return SmsDeliveryReconciliationEvent.findOneAndUpdate(
    { business: businessId, eventKey },
    {
      $setOnInsert: {
        business: businessId,
        eventKey,
        providerMessageId,
        providerStatus,
        status: "pending",
        attemptCount: 0,
        maxAttempts: maxAttempts(),
        availableAt: new Date(),
      },
      $set: {
        payload,
      },
    },
    {
      upsert: true,
      returnDocument: "after",
      setDefaultsOnInsert: true,
    },
  );
};

export const markSmsDeliveryReconciliationApplied = async (eventId) => {
  if (!eventId) return null;
  return SmsDeliveryReconciliationEvent.findOneAndUpdate(
    {
      _id: eventId,
      status: { $in: ["pending", "retry"] },
    },
    {
      $set: {
        status: "applied",
        appliedAt: new Date(),
        lastError: "",
        leaseToken: "",
        leaseExpiresAt: null,
      },
    },
    { returnDocument: "after" },
  );
};

export const claimNextSmsDeliveryReconciliationEvent = async ({
  now = new Date(),
} = {}) => {
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs());

  return SmsDeliveryReconciliationEvent.findOneAndUpdate(
    {
      $expr: { $lt: ["$attemptCount", "$maxAttempts"] },
      $or: [
        { status: "pending", availableAt: { $lte: now } },
        { status: "retry", availableAt: { $lte: now } },
        { status: "processing", leaseExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        status: "processing",
        leaseToken,
        leaseExpiresAt,
        processingStartedAt: now,
        lastError: "",
      },
      $inc: { attemptCount: 1 },
    },
    {
      sort: { availableAt: 1, createdAt: 1 },
      returnDocument: "after",
    },
  );
};

export const completeSmsDeliveryReconciliationEvent = async ({
  eventId,
  leaseToken,
}) =>
  SmsDeliveryReconciliationEvent.findOneAndUpdate(
    { _id: eventId, status: "processing", leaseToken },
    {
      $set: {
        status: "applied",
        appliedAt: new Date(),
        leaseToken: "",
        leaseExpiresAt: null,
        lastError: "",
      },
    },
    { returnDocument: "after" },
  );

export const failSmsDeliveryReconciliationEvent = async ({
  event,
  leaseToken,
  error,
}) => {
  if (!event?._id || !leaseToken) return null;
  const message = String(error?.message || error || "Target unavailable").slice(
    0,
    1000,
  );
  const dead = event.attemptCount >= event.maxAttempts;

  return SmsDeliveryReconciliationEvent.findOneAndUpdate(
    { _id: event._id, status: "processing", leaseToken },
    {
      $set: {
        status: dead ? "dead" : "retry",
        availableAt: dead
          ? new Date()
          : new Date(Date.now() + retryDelayMs(event.attemptCount)),
        leaseToken: "",
        leaseExpiresAt: null,
        lastError: message,
        ...(dead ? { deadAt: new Date() } : {}),
      },
    },
    { returnDocument: "after" },
  );
};

export default {
  buildSmsDeliveryEventKey,
  enqueueSmsDeliveryReconciliationEvent,
  markSmsDeliveryReconciliationApplied,
  claimNextSmsDeliveryReconciliationEvent,
  completeSmsDeliveryReconciliationEvent,
  failSmsDeliveryReconciliationEvent,
};
