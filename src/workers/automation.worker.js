import AutomationJob from "../models/automationJob.js";
import AppointmentService from "../services/scheduling/appointment.service.js";
import AutomationService from "../services/automation/automation.service.js";
import { renewExpiringGoogleWatches } from "../services/integrations/googleCalendarSync.service.js";
import { processQueuedIntegrationWebhooks } from "./integrationWebhook.worker.js";

const POLL_INTERVAL_MS = Math.max(
  Number(process.env.AUTOMATION_WORKER_INTERVAL_MS) || 30_000,
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
    console.error("Automation job execution failed:", {
      jobId: String(job._id),
      error: error.message,
    });
    return null;
  }
};

const maintainGoogleWatches = async () => {
  if (
    !process.env.GOOGLE_CALENDAR_WEBHOOK_URL ||
    Date.now() - lastWatchMaintenanceAt < WATCH_MAINTENANCE_INTERVAL_MS
  ) {
    return;
  }
  lastWatchMaintenanceAt = Date.now();
  try {
    const results = await renewExpiringGoogleWatches();
    const failures = results.filter((result) => !result.renewed);
    if (failures.length) {
      console.error("Google Calendar watch renewal failures:", failures);
    }
  } catch (error) {
    console.error("Google Calendar watch maintenance failed:", error);
  }
};

const tick = async ({ includeIntegrationMaintenance = true } = {}) => {
  if (running) return;
  running = true;
  try {
    await AppointmentService.releaseExpiredHolds();
    if (includeIntegrationMaintenance) {
      await processQueuedIntegrationWebhooks(25);
      await maintainGoogleWatches();
    }

    let processed = 0;
    while (processed < 25) {
      const job = await processNextAutomationJob();
      if (!job) break;
      processed += 1;
    }
  } catch (error) {
    console.error("Automation worker tick failed:", error);
  } finally {
    running = false;
  }
};

export const startAutomationWorker = async () => {
  if (timer || process.env.AUTOMATION_WORKER_ENABLED !== "true") return;
  await recoverStaleLocks();
  // Run core scheduling work immediately. Optional integration maintenance starts
  // on the normal polling interval so worker startup is deterministic and does
  // not block on webhook/watch infrastructure.
  await tick({ includeIntegrationMaintenance: false });
  timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  timer.unref?.();
  console.log(`Automation worker started as ${instanceId}.`);
};

export const stopAutomationWorker = () => {
  if (timer) clearInterval(timer);
  timer = null;
};
