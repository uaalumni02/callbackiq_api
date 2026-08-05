import CallLog from "../../models/callLog.js";
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
  undelivered: "undelivered",
  failed: "failed",
  canceled: "failed",
  read: "delivered",
};
const FINAL_FAILURES = new Set(["failed", "undelivered", "canceled"]);

const normalizeStatus = (value) => String(value || "").trim().toLowerCase();

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

export const processTwilioMessageStatus = async ({ businessId, payload = {} }) => {
  const providerMessageId = String(payload.MessageSid || payload.SmsSid || "").trim();
  const deliveryStatus = normalizeStatus(payload.MessageStatus || payload.SmsStatus);
  if (!businessId || !providerMessageId || !deliveryStatus) return null;

  const status = MESSAGE_STATUS_MAP[deliveryStatus] || "sent";
  const errorCode = String(payload.ErrorCode || "").trim();
  const errorMessage = String(payload.ErrorMessage || "").trim().slice(0, 1000);
  const now = new Date();
  const update = {
    status,
    deliveryStatus,
    deliveryErrorCode: errorCode,
    deliveryErrorMessage: errorMessage,
    ...(deliveryStatus === "delivered" || deliveryStatus === "read"
      ? { deliveredAt: now }
      : {}),
    ...(FINAL_FAILURES.has(deliveryStatus) ? { failedAt: now } : {}),
  };

  const message = await Message.findOneAndUpdate(
    { business: businessId, providerMessageId },
    { $set: update },
    { returnDocument: "after" },
  );

  const callLog = await CallLog.findOneAndUpdate(
    { business: businessId, smsProviderMessageId: providerMessageId },
    {
      $set: {
        smsDeliveryStatus: deliveryStatus,
        missedCallTextDelivered:
          deliveryStatus === "delivered" || deliveryStatus === "read",
        smsDeliveryErrorCode: errorCode,
        smsDeliveryErrorMessage: errorMessage,
        ...(deliveryStatus === "delivered" || deliveryStatus === "read"
          ? { smsDeliveredAt: now }
          : {}),
        ...(FINAL_FAILURES.has(deliveryStatus) ? { smsFailedAt: now } : {}),
      },
    },
    { returnDocument: "after" },
  );

  if (message) SocketService.emitMessageUpdated(businessId, message);
  if (callLog) SocketService.emitCallUpdated(businessId, callLog);
  if (message || callLog) {
    SocketService.emitDashboardRefresh(businessId, `sms_status_${deliveryStatus}`);
  }
  if (FINAL_FAILURES.has(deliveryStatus)) {
    logOperationalEvent("twilio.sms.delivery_failed", {
      businessId,
      providerMessageId,
      deliveryStatus,
      errorCode,
    });
    await detectFailureSpike({ businessId, now });
  }
  return { message, callLog, deliveryStatus };
};

export default { processTwilioMessageStatus };
