import {
  reconcileOrphanedInboundSmsJobs,
} from "../services/messaging/smsProcessingQueue.service.js";
import {
  logOperationalEvent,
  logOperationalError,
} from "../helpers/logging/safeLogger.js";

const DEFAULT_INTERVAL_MS = 30000;
let timer = null;
let active = null;
let stopping = false;
import { withDeadline } from "../services/boundedRedis.service.js";

const intervalMs = () => {
  const configured = Number(
    process.env.SMS_INGRESS_RECONCILIATION_INTERVAL_MS,
  );
  return Number.isFinite(configured) && configured >= 5000
    ? Math.min(300000, configured)
    : DEFAULT_INTERVAL_MS;
};

const performReconciliation = async () => {
  const result = await reconcileOrphanedInboundSmsJobs();
  if (result.repaired > 0) {
    logOperationalEvent("sms.ingress_orphans_repaired", result);
  }
  return result;
};

export const reconcileSmsIngressOnce = () => {
  if (active) return active;
  active = performReconciliation().finally(() => { active = null; });
  return active;
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
      if (!stopping) scheduleNext();
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

  stopping = false;
  await reconcileSmsIngressOnce();
  if (!stopping) scheduleNext();
};

export const stopSmsIngressReconciliationWorker = async () => {
  stopping = true;
  if (timer) clearTimeout(timer);
  timer = null;
  if (active) await withDeadline(active, 120000, "SMS_INGRESS_DRAIN_TIMEOUT");
};

export default {
  reconcileSmsIngressOnce,
  startSmsIngressReconciliationWorker,
  stopSmsIngressReconciliationWorker,
};
