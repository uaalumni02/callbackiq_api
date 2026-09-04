import {
  reconcileOrphanedInboundSmsJobs,
} from "../services/messaging/smsProcessingQueue.service.js";
import {
  logOperationalEvent,
  logOperationalError,
} from "../helpers/logging/safeLogger.js";

const DEFAULT_INTERVAL_MS = 30000;
let timer = null;

const intervalMs = () => {
  const configured = Number(
    process.env.SMS_INGRESS_RECONCILIATION_INTERVAL_MS,
  );
  return Number.isFinite(configured) && configured >= 5000
    ? Math.min(300000, configured)
    : DEFAULT_INTERVAL_MS;
};

export const reconcileSmsIngressOnce = async () => {
  const result = await reconcileOrphanedInboundSmsJobs();
  if (result.repaired > 0) {
    logOperationalEvent("sms.ingress_orphans_repaired", result);
  }
  return result;
};

const scheduleNext = () => {
  timer = setTimeout(async () => {
    try {
      await reconcileSmsIngressOnce();
    } catch (error) {
      logOperationalError(
        "sms.ingress_reconciliation_failed",
        error,
      );
    } finally {
      if (timer) scheduleNext();
    }
  }, intervalMs());
  timer.unref?.();
};

export const startSmsIngressReconciliationWorker = async () => {
  if (
    timer ||
    String(
      process.env.SMS_INGRESS_RECONCILIATION_ENABLED || "true",
    ).toLowerCase() === "false"
  ) {
    return;
  }

  await reconcileSmsIngressOnce();
  scheduleNext();
};

export const stopSmsIngressReconciliationWorker = () => {
  if (timer) clearTimeout(timer);
  timer = null;
};

export default {
  reconcileSmsIngressOnce,
  startSmsIngressReconciliationWorker,
  stopSmsIngressReconciliationWorker,
};
