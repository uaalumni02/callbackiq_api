import mongoose from 'mongoose';
import AppointmentNotice from '../../models/appointmentNotificationJob.js';
import CallLog from "../../models/callLog.js";
import {
  enqueueSmsDeliveryReconciliationEvent,
  markSmsDeliveryReconciliationApplied,
} from "./smsDeliveryReconciliation.service.js";
import Message from "../../models/message.js";
import AlertService from "../alert.service.js";
import SocketService from "../socket.service.js";
import { logOperationalEvent } from "../../helpers/logging/safeLogger.js";

const MESSAGE_STATUS_MAP = {
  accepted: "queued",
  scheduled: "queued",
  queued: "queued",
  sending: "queued",
  sent: "sent",
  delivered: "delivered",
  read: "delivered",
  undelivered: "undelivered",
  failed: "failed",
  canceled: "failed",
};
const FINAL_FAILURES = new Set(["failed", "undelivered", "canceled"]);
const ALLOWED_CURRENT_STATUSES = {
  queued: ["queued"],
  sent: ["queued", "sent"],
  delivered: ["queued", "sent", "delivered"],
  undelivered: ["queued", "sent", "undelivered"],
  failed: ["queued", "sent", "failed"],
};

const normalizeStatus = (value) => String(value || "").trim().toLowerCase();
const appendEvent = (event) => ({
  $each: [event],
  $slice: -50,
});

const detectFailureSpike = async ({ businessId, now = new Date() }) => {
  const since = new Date(now.getTime() - 60 * 60 * 1000);
  const [attempted, failed] = await Promise.all([
    Message.countDocuments({
      business: businessId,
      direction: "outbound",
      provider: "twilio",
      createdAt: { $gte: since },
      providerMessageId: { $gt: "" },
    }),
    Message.countDocuments({
      business: businessId,
      direction: "outbound",
      provider: "twilio",
      createdAt: { $gte: since },
      status: { $in: ["failed", "undelivered"] },
    }),
  ]);
  const minimumFailures = Number(process.env.SMS_DELIVERY_SPIKE_MIN_FAILURES || 5);
  const failureRate = attempted > 0 ? failed / attempted : 0;
  const threshold = Number(process.env.SMS_DELIVERY_SPIKE_RATE || 0.2);
  if (failed < minimumFailures || failureRate < threshold) return;

  const bucket = now.toISOString().slice(0, 13);
  await AlertService.createSystemAlert({
    businessId,
    title: "SMS delivery failures are elevated",
    message: `${failed} of ${attempted} outbound messages failed or were undelivered in the last hour. Review carrier filtering and Twilio delivery errors.`,
    priority: "critical",
    metadata: { failed, attempted, failureRate, windowMinutes: 60 },
    dedupeKey: `sms_delivery_spike:${bucket}`,
  });
};

const updateMessageMonotonically = async ({
  businessId,
  providerMessageId,
  providerStatus,
  canonicalStatus,
  errorCode,
  errorMessage,
  now,
}) => {
  const eventBase = {
    providerStatus,
    canonicalStatus: canonicalStatus || "",
    errorCode,
    errorMessage,
    receivedAt: now,
  };
  if (!canonicalStatus) {
    return Message.findOneAndUpdate(
      { business: businessId, providerMessageId },
      { $push: { deliveryEvents: appendEvent({ ...eventBase, applied: false, conflict: false }) } },
      { returnDocument: "after" },
    );
  }

  const update = {
    $set: {
      status: canonicalStatus,
      deliveryStatus: providerStatus,
      deliveryErrorCode: errorCode,
      deliveryErrorMessage: errorMessage,
      ...(canonicalStatus === "delivered" ? { deliveredAt: now } : {}),
      ...(canonicalStatus === "failed" || canonicalStatus === "undelivered"
        ? { failedAt: now }
        : {}),
    },
    $push: {
      deliveryEvents: appendEvent({ ...eventBase, applied: true, conflict: false }),
    },
  };
  const applied = await Message.findOneAndUpdate(
    {
      business: businessId,
      providerMessageId,
      status: { $in: ALLOWED_CURRENT_STATUSES[canonicalStatus] || [] },
    },
    update,
    { returnDocument: "after" },
  );
  if (applied) return applied;

  return Message.findOneAndUpdate(
    { business: businessId, providerMessageId },
    {
      $push: {
        deliveryEvents: appendEvent({ ...eventBase, applied: false, conflict: true }),
      },
    },
    { returnDocument: "after" },
  );
};

const updateCallLogSmsMonotonically = async ({
  businessId,
  providerMessageId,
  providerStatus,
  canonicalStatus,
  errorCode,
  errorMessage,
  now,
}) => {
  const eventBase = {
    providerStatus,
    canonicalStatus: canonicalStatus || "",
    errorCode,
    receivedAt: now,
  };
  if (!canonicalStatus) {
    return CallLog.findOneAndUpdate(
      { business: businessId, smsProviderMessageId: providerMessageId },
      { $push: { smsDeliveryEvents: appendEvent({ ...eventBase, applied: false, conflict: false }) } },
      { returnDocument: "after" },
    );
  }

  const allowedRawStatuses = {
    queued: ["", "accepted", "scheduled", "queued", "sending"],
    sent: ["", "accepted", "scheduled", "queued", "sending", "sent"],
    delivered: ["", "accepted", "scheduled", "queued", "sending", "sent", "delivered", "read"],
    undelivered: ["", "accepted", "scheduled", "queued", "sending", "sent", "undelivered"],
    failed: ["", "accepted", "scheduled", "queued", "sending", "sent", "failed", "canceled"],
  };
  const applied = await CallLog.findOneAndUpdate(
    {
      business: businessId,
      smsProviderMessageId: providerMessageId,
      smsDeliveryStatus: { $in: allowedRawStatuses[canonicalStatus] || [] },
    },
    {
      $set: {
        smsDeliveryStatus: providerStatus,
        missedCallTextDelivered: canonicalStatus === "delivered",
        smsDeliveryErrorCode: errorCode,
        smsDeliveryErrorMessage: errorMessage,
        ...(canonicalStatus === "delivered" ? { smsDeliveredAt: now } : {}),
        ...(canonicalStatus === "failed" || canonicalStatus === "undelivered"
          ? { smsFailedAt: now }
          : {}),
      },
      $push: {
        smsDeliveryEvents: appendEvent({ ...eventBase, applied: true, conflict: false }),
      },
    },
    { returnDocument: "after" },
  );
  if (applied) return applied;
  return CallLog.findOneAndUpdate(
    { business: businessId, smsProviderMessageId: providerMessageId },
    {
      $push: {
        smsDeliveryEvents: appendEvent({ ...eventBase, applied: false, conflict: true }),
      },
    },
    { returnDocument: "after" },
  );
};

export const processTwilioMessageStatus = async ({
  businessId,
  payload = {},
  skipReconciliationPersistence = false,
}) => {
  const providerMessageId = String(payload.MessageSid || payload.SmsSid || "").trim();
  const providerStatus = normalizeStatus(payload.MessageStatus || payload.SmsStatus);
  if (!businessId || !providerMessageId || !providerStatus) return null;

  const canonicalStatus = MESSAGE_STATUS_MAP[providerStatus] || "";
  const errorCode = String(payload.ErrorCode || "").trim();
  const errorMessage = String(payload.ErrorMessage || "").trim().slice(0, 1000);
  const now = new Date();
  const reconciliationEvent = skipReconciliationPersistence
    ? null
    : await enqueueSmsDeliveryReconciliationEvent({
        businessId,
        payload,
      });

  const [message, callLog] = await Promise.all([
    updateMessageMonotonically({
      businessId,
      providerMessageId,
      providerStatus,
      canonicalStatus,
      errorCode,
      errorMessage,
      now,
    }),
    updateCallLogSmsMonotonically({
      businessId,
      providerMessageId,
      providerStatus,
      canonicalStatus,
      errorCode,
      errorMessage,
      now,
    }),
  ]);

  let appointmentNotice = null;
  if (!message && !callLog && canonicalStatus && mongoose.isValidObjectId(businessId)) {
    appointmentNotice = await AppointmentNotice.findOneAndUpdate({ business: businessId, providerMessageId,
      $or: [{ deliveryStatus: { $in: ['', ...(ALLOWED_CURRENT_STATUSES[canonicalStatus] || [])] } }, { deliveryStatus: { $exists: false } }],
    }, { $set: { deliveryStatus: canonicalStatus, deliveryErrorMessage: errorMessage } }, { returnDocument: 'after' });
    // An out-of-order callback is still matched; do not downgrade final delivery.
    if (!appointmentNotice) appointmentNotice = await AppointmentNotice.findOne({ business: businessId, providerMessageId });
  }

  if (reconciliationEvent && (message || callLog || appointmentNotice)) {
    await markSmsDeliveryReconciliationApplied(reconciliationEvent._id);
  } else if (reconciliationEvent && !message && !callLog && !appointmentNotice) {
    logOperationalEvent("twilio.sms.delivery_status_pending_reconciliation", {
      businessId,
      providerMessageId,
      deliveryStatus: providerStatus,
      reconciliationEventId: reconciliationEvent._id,
    });
  }

  if (message) SocketService.emitMessageUpdated(businessId, message);
  if (callLog) SocketService.emitCallUpdated(businessId, callLog);
  if (message || callLog || appointmentNotice) {
    SocketService.emitDashboardRefresh(businessId, `sms_status_${providerStatus}`);
  }
  if (FINAL_FAILURES.has(providerStatus)) {
    logOperationalEvent("twilio.sms.delivery_failed", {
      businessId,
      providerMessageId,
      deliveryStatus: providerStatus,
      errorCode,
    });
    await detectFailureSpike({ businessId, now });
  }
  return {
    message,
    callLog,
    appointmentNotice,
    deliveryStatus: providerStatus,
    canonicalStatus,
    reconciliationPending: Boolean(
      reconciliationEvent && !message && !callLog && !appointmentNotice,
    ),
    reconciliationEventId: reconciliationEvent?._id || null,
  };
};

export default { processTwilioMessageStatus };
