import {
  claimNextSmsDeliveryReconciliationEvent,
  completeSmsDeliveryReconciliationEvent,
  failSmsDeliveryReconciliationEvent,
} from "../services/messaging/smsDeliveryReconciliation.service.js";
import {
  processTwilioMessageStatus,
} from "../services/messaging/smsDeliveryStatus.service.js";
import AlertService from "../services/alert.service.js";
import {
  logOperationalEvent,
  logOperationalError,
} from "../helpers/logging/safeLogger.js";

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 50;

let timer = null;
let running = false;

const intervalMs = () => {
  const configured = Number(
    process.env.SMS_DELIVERY_RECONCILIATION_INTERVAL_MS,
  );
  return Number.isFinite(configured) && configured >= 500
    ? Math.min(60_000, configured)
    : DEFAULT_INTERVAL_MS;
};

const batchSize = () => {
  const configured = Number(process.env.SMS_DELIVERY_RECONCILIATION_BATCH_SIZE);
  return Number.isFinite(configured) && configured >= 1
    ? Math.min(500, Math.floor(configured))
    : DEFAULT_BATCH_SIZE;
};

export const drainSmsDeliveryReconciliationOnce = async () => {
  if (running) return { processed: 0, applied: 0, skipped: true };
  running = true;

  let processed = 0;
  let applied = 0;

  try {
    for (let index = 0; index < batchSize(); index += 1) {
      const event = await claimNextSmsDeliveryReconciliationEvent();
      if (!event) break;
      processed += 1;

      try {
        const result = await processTwilioMessageStatus({
          businessId: event.business,
          payload: event.payload,
          skipReconciliationPersistence: true,
        });

        if (result?.message || result?.callLog || result?.appointmentNotice) {
          await completeSmsDeliveryReconciliationEvent({
            eventId: event._id,
            leaseToken: event.leaseToken,
          });
          applied += 1;
          continue;
        }

        const error = new Error(
          "The outbound SMS record is not available yet.",
        );
        error.code = "SMS_DELIVERY_TARGET_NOT_AVAILABLE";
        throw error;
      } catch (error) {
        const failed = await failSmsDeliveryReconciliationEvent({
          event,
          leaseToken: event.leaseToken,
          error,
        });

        if (failed?.status === "dead") {
          await AlertService.createSystemAlert({
            businessId: event.business,
            title: "SMS delivery status could not be reconciled",
            message:
              "CallBackIQ received a Twilio delivery update but could not match it to an outbound message after repeated attempts.",
            priority: "critical",
            metadata: {
              reconciliationEventId: String(event._id),
              providerMessageId: event.providerMessageId,
              providerStatus: event.providerStatus,
              attempts: failed.attemptCount,
            },
            dedupeKey: `sms_delivery_reconciliation_dead:${event._id}`,
          });
        }
      }
    }
  } finally {
    running = false;
  }

  return { processed, applied, skipped: false };
};

const scheduleNext = () => {
  timer = setTimeout(async () => {
    try {
      const result = await drainSmsDeliveryReconciliationOnce();
      if (result.processed > 0) {
        logOperationalEvent("sms.delivery_reconciliation.batch", result);
      }
    } catch (error) {
      logOperationalError("sms.delivery_reconciliation.failed", error);
    } finally {
      if (timer) scheduleNext();
    }
  }, intervalMs());
  timer.unref?.();
};

export const startSmsDeliveryReconciliationWorker = async () => {
  if (
    timer ||
    String(
      process.env.SMS_DELIVERY_RECONCILIATION_ENABLED || "true",
    ).toLowerCase() === "false"
  ) {
    return;
  }

  await drainSmsDeliveryReconciliationOnce();
  scheduleNext();
};

export const stopSmsDeliveryReconciliationWorker = () => {
  if (timer) clearTimeout(timer);
  timer = null;
};

export default {
  drainSmsDeliveryReconciliationOnce,
  startSmsDeliveryReconciliationWorker,
  stopSmsDeliveryReconciliationWorker,
};
