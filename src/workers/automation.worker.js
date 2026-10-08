import { withDeadline } from '../services/boundedRedis.service.js';
import { markAutomationStarted, markAutomationStopped, markAutomationTick } from '../services/automationReadiness.service.js';
import { safeConsole } from "../helpers/logging/safeLogger.js";
import AutomationJob from "../models/automationJob.js";
import AppointmentService from "../services/scheduling/appointment.service.js";
import AutomationService from "../services/automation/automation.service.js";
import {
  processDueAppointmentNotifications,
  recoverStaleAppointmentNotificationLocks,
} from "../services/scheduling/appointmentNotification.service.js";
import {
  renewExpiringGoogleWatches,
  sweepOrphanedGoogleEvents,
} from "../services/integrations/googleCalendarSync.service.js";
import { processQueuedIntegrationWebhooks } from "./integrationWebhook.worker.js";

const POLL_INTERVAL_MS = Math.max(
  Number(process.env.AUTOMATION_WORKER_INTERVAL_MS) || 5_000,
  5_000,
);
const STALE_LOCK_MINUTES = Math.max(
  Number(process.env.AUTOMATION_STALE_LOCK_MINUTES) || 15,
  5,
);
const WATCH_MAINTENANCE_INTERVAL_MS = Math.max(
  Number(process.env.GOOGLE_WATCH_MAINTENANCE_INTERVAL_MS) ||
    12 * 60 * 60 * 1000,
  60 * 60 * 1000,
);
const instanceId =
  process.env.INSTANCE_ID ||
  `${process.pid}:${Math.random().toString(36).slice(2, 10)}`;

let timer = null;
let running = false;
let lastWatchMaintenanceAt = 0;
let maintenanceActive = null;
let activeTick = null;
let lastRecoveryAt = null;
let stopping = false;

const recoverAbandonedWork = async () => {
  if (lastRecoveryAt !== null && Date.now() - lastRecoveryAt < 60_000) return;
  // Each sweep is idempotent. Keep trying after a transient database failure.
  await recoverStaleLocks();
  await recoverStaleAppointmentNotificationLocks();
  lastRecoveryAt = Date.now();
};

const recoverStaleLocks = async () => {
  const staleBefore = new Date(Date.now() - STALE_LOCK_MINUTES * 60_000);
  await AutomationJob.updateMany(
    {
      status: "processing",
      lockedAt: { $lte: staleBefore },
    },
    {
      $set: {
        status: "scheduled",
        lockedAt: null,
        lockedBy: null,
        executeAt: new Date(),
        failureReason: "Recovered stale worker lock.",
      },
    },
  );
};

export const processNextAutomationJob = async () => {
  const job = await AutomationJob.findOneAndUpdate(
    {
      status: "scheduled",
      executeAt: { $lte: new Date() },
      lockedAt: null,
    },
    {
      $set: {
        status: "processing",
        lockedAt: new Date(),
        lockedBy: instanceId,
      },
    },
    { sort: { executeAt: 1 }, new: true },
  );

  if (!job) return null;
  try {
    return await AutomationService.execute(job);
  } catch (error) {
    safeConsole.error("Automation job execution failed:", {
      jobId: String(job._id),
      error: error.message,
    });
    return null;
  }
};

const maintainGoogleWatches = async () => {
  if (Date.now() - lastWatchMaintenanceAt < WATCH_MAINTENANCE_INTERVAL_MS) {
    return;
  }
  lastWatchMaintenanceAt = Date.now();
  if (process.env.GOOGLE_CALENDAR_WEBHOOK_URL) {
    try {
      const results = await renewExpiringGoogleWatches();
      const failures = results.filter((result) => !result.renewed);
      if (failures.length) {
        safeConsole.error("Google Calendar watch renewal failures:", failures);
      }
    } catch (error) {
      safeConsole.error("Google Calendar watch maintenance failed:", error);
    }
  }
  try {
    const results = await sweepOrphanedGoogleEvents();
    const failures = results.filter((result) => result.error);
    if (failures.length) {
      safeConsole.error("Google Calendar orphan sweep failures:", failures);
    }
  } catch (error) {
    safeConsole.error("Google Calendar orphan sweep failed:", error);
  }
};

const performTick = async ({ includeIntegrationMaintenance = true } = {}) => {
  if (running) return;
  running = true;
  try {
    try { await recoverAbandonedWork(); }
    catch (error) { safeConsole.error("Automation lock recovery failed:", error); }
    // A maintenance failure must not prevent already-queued confirmations.
    try { await AppointmentService.releaseExpiredHolds(); }
    catch (error) { safeConsole.error('Appointment maintenance failed:', error); }
    await processDueAppointmentNotifications(
      Math.max(1, Math.min(500, Number(process.env.APPOINTMENT_NOTIFICATION_BATCH_SIZE) || 100)),
      { concurrency: Math.max(1, Math.min(10, Number(process.env.APPOINTMENT_NOTIFICATION_CONCURRENCY) || 3)) },
    );
    markAutomationTick(true);
    if (!stopping && includeIntegrationMaintenance && !maintenanceActive) {
      maintenanceActive = (async () => {
        await processQueuedIntegrationWebhooks(25);
        await maintainGoogleWatches();
      })().catch(error => safeConsole.error('Integration maintenance failed:', error))
        .finally(() => { maintenanceActive = null; });
    }

    let processed = 0;
    while (!stopping && processed < 25) {
      const job = await processNextAutomationJob();
      if (!job) break;
      processed += 1;
    }
  } catch (error) {
    markAutomationTick(false);
    safeConsole.error("Automation worker tick failed:", error);
  } finally {
    running = false;
  }
};

export const runAutomationTick = options => {
  if (activeTick) return activeTick;
  activeTick = performTick(options).finally(() => { activeTick = null; });
  return activeTick;
};

export const startAutomationWorker = async () => {
  if (timer) return;
  if (process.env.AUTOMATION_WORKER_ENABLED === "false") {
    if (process.env.PROCESS_ROLE === 'worker-automation') throw new Error('The automation worker role cannot run with automation disabled.');
    return;
  }
  stopping = false;
  lastRecoveryAt = null;
  await recoverAbandonedWork();
  // Run core scheduling work immediately. Optional integration maintenance starts
  // on the normal polling interval so worker startup is deterministic and does
  // not block on webhook/watch infrastructure.
  markAutomationStarted();
  await runAutomationTick({ includeIntegrationMaintenance: false });
  timer = setInterval(() => void runAutomationTick(), POLL_INTERVAL_MS);
  timer.unref?.();
  safeConsole.log(`Automation worker started as ${instanceId}.`);
};

export const stopAutomationWorker = async () => {
  stopping = true;
  markAutomationStopped();
  if (timer) clearInterval(timer);
  timer = null;
  if (activeTick) await withDeadline(activeTick, 120000, "AUTOMATION_DRAIN_TIMEOUT");
  if (maintenanceActive) await withDeadline(maintenanceActive, 120000, "INTEGRATION_MAINTENANCE_DRAIN_TIMEOUT");
};
