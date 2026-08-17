import A2pCustomerRegistration from "../models/a2pCustomerRegistration.js";
import { syncA2pCustomerRegistration } from "../services/a2pCustomerOnboarding.service.js";
import {
  logOperationalEvent,
  logOperationalError,
} from "../helpers/logging/safeLogger.js";

export const A2P_RECONCILABLE_STATUSES = Object.freeze([
  "brand_pending",
  "brand_approved",
  "campaign_pending",
  "number_pending",
  "otp_required",
]);

const intervalMs = Math.max(
  Number(process.env.A2P_RECONCILIATION_INTERVAL_MS) || 15 * 60_000,
  60_000,
);
const initialDelayMs = Math.max(
  Number(process.env.A2P_RECONCILIATION_INITIAL_DELAY_MS) || 15_000,
  1_000,
);
const batchLimit = Math.min(
  Math.max(Number(process.env.A2P_RECONCILIATION_BATCH_LIMIT) || 50, 1),
  250,
);

let intervalTimer = null;
let startupTimer = null;
let running = false;

export const runA2pReconciliationCycle = async () => {
  if (running) return { skipped: true, processed: 0, advanced: 0, failed: 0 };
  running = true;

  const summary = {
    skipped: false,
    processed: 0,
    advanced: 0,
    failed: 0,
  };

  try {
    const registrations = await A2pCustomerRegistration.find({
      status: { $in: A2P_RECONCILABLE_STATUSES },
    })
      .sort({ lastSyncedAt: 1, _id: 1 })
      .limit(batchLimit)
      .select("_id business status lastSyncedAt")
      .lean();

    for (const registration of registrations) {
      summary.processed += 1;
      try {
        const before = String(registration.status || "");
        const result = await syncA2pCustomerRegistration({
          businessId: registration.business,
        });
        if (String(result?.status || "") !== before) summary.advanced += 1;
      } catch (error) {
        summary.failed += 1;
        logOperationalError("a2p.reconciliation.business_failed", error, {
          businessId: registration.business,
          registrationId: registration._id,
          registrationStatus: registration.status,
        });
      }
    }

    logOperationalEvent("a2p.reconciliation.completed", summary);
    return summary;
  } finally {
    running = false;
  }
};

const queueCycle = () => {
  void runA2pReconciliationCycle().catch((error) => {
    logOperationalError("a2p.reconciliation.cycle_failed", error, {});
  });
};

export const startA2pReconciliationWorker = () => {
  if (
    process.env.A2P_RECONCILIATION_WORKER_ENABLED === "false" ||
    intervalTimer ||
    startupTimer
  ) {
    return;
  }

  startupTimer = setTimeout(() => {
    startupTimer = null;
    queueCycle();
  }, initialDelayMs);
  startupTimer.unref?.();

  intervalTimer = setInterval(queueCycle, intervalMs);
  intervalTimer.unref?.();
};

export const stopA2pReconciliationWorker = () => {
  if (startupTimer) clearTimeout(startupTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  startupTimer = null;
  intervalTimer = null;
};

export default {
  runA2pReconciliationCycle,
  startA2pReconciliationWorker,
  stopA2pReconciliationWorker,
};
