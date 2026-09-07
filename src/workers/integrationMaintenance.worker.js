import { safeConsole } from "../helpers/logging/safeLogger.js";
import IntegrationConnection from "../models/integrationConnection.js";
import { getJobberSettings } from "../services/integrations/integrationSettings.service.js";
import { renewExpiringGoogleWatches } from "../services/integrations/googleCalendarSync.service.js";
import { syncPendingQualifiedLeadsToJobber } from "../services/integrations/jobberWorkflow.service.js";
import { processQueuedIntegrationWebhooks } from "./integrationWebhook.worker.js";

const intervalMs = Math.max(
  Number(process.env.INTEGRATION_WORKER_INTERVAL_MS) || 5 * 60_000,
  60_000,
);
let timer = null;
let running = false;
let lastWatchRenewalAt = 0;

export const runIntegrationMaintenance = async () => {
  if (running) return { skipped: true };
  running = true;
  const summary = { webhooks: 0, jobberBusinesses: 0, jobberLeads: 0, watches: 0 };
  try {
    const events = await processQueuedIntegrationWebhooks(50);
    summary.webhooks = events.filter(Boolean).length;

    const connections = await IntegrationConnection.find({
      provider: "jobber",
      status: "connected",
    });
    for (const connection of connections) {
      const settings = getJobberSettings(connection);
      if (!settings.syncQualifiedLeads) continue;
      const results = await syncPendingQualifiedLeadsToJobber({
        businessId: connection.business,
        limit: 25,
      });
      summary.jobberBusinesses += 1;
      summary.jobberLeads += results.filter((item) => !item.error).length;
    }

    if (Date.now() - lastWatchRenewalAt > 60 * 60_000) {
      const watches = await renewExpiringGoogleWatches();
      summary.watches = watches.filter((item) => item.renewed).length;
      lastWatchRenewalAt = Date.now();
    }
    return summary;
  } finally {
    running = false;
  }
};

export const startIntegrationMaintenanceWorker = async () => {
  if (process.env.INTEGRATION_WORKER_ENABLED === "false" || timer) return;
  await runIntegrationMaintenance().catch((error) => {
    safeConsole.error("Integration maintenance startup failed:", error.message);
  });
  timer = setInterval(() => {
    void runIntegrationMaintenance().catch((error) => {
      safeConsole.error("Integration maintenance failed:", error.message);
    });
  }, intervalMs);
  timer.unref?.();
};

export const stopIntegrationMaintenanceWorker = () => {
  if (timer) clearInterval(timer);
  timer = null;
};
