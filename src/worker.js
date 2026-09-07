import { safeConsole } from "./helpers/logging/safeLogger.js";
import { startWebhookWorkWorker, stopWebhookWorkWorker } from "./workers/webhookWork.worker.js";
import { Server } from "socket.io";
import SocketService from "./services/socket.service.js";
import { initializeSocketRedisAdapter, closeSocketRedisAdapter } from "./services/socketRedisAdapter.service.js";
import { closeScaleCache } from "./services/scaleCache.service.js";
import {
  startConversationLifecycleWorker,
  stopConversationLifecycleWorker,
} from "./workers/conversationLifecycle.worker.js";
// CALLBACKIQ_PRODUCTION_HARDENING_V1
import "dotenv/config";
import mongoose from "mongoose";
import connectDB from "./db/connection.js";
import { validateEnvironment } from "./config/env.js";
import {
  assertRealtimeScalingConfig,
  assertValidProcessRole,
  getProcessRole,
  normalizeRuntimeEnvironment,
} from "./config/runtime-environment.js";
import {
  startA2pReconciliationWorker,
  stopA2pReconciliationWorker,
} from "./workers/a2pReconciliation.worker.js";
import {
  startAppointmentMaintenanceWorker,
  stopAppointmentMaintenanceWorker,
} from "./workers/appointmentMaintenance.worker.js";
import {
  startAutomationWorker,
  stopAutomationWorker,
} from "./workers/automation.worker.js";
import {
  startSmsProcessingWorker,
  stopSmsProcessingWorker,
} from "./workers/smsProcessing.worker.js";
import {
  startSmsIngressReconciliationWorker,
  stopSmsIngressReconciliationWorker,
} from "./workers/smsIngressReconciliation.worker.js";
import {
  startSmsDeliveryReconciliationWorker,
  stopSmsDeliveryReconciliationWorker,
} from "./workers/smsDeliveryReconciliation.worker.js";
import {
  startTrialLifecycleWorker,
  stopTrialLifecycleWorker,
} from "./workers/trialLifecycle.worker.js";
import {
  startVoiceUsageReconciliationWorker,
  stopVoiceUsageReconciliationWorker,
} from "./workers/voiceUsageReconciliation.worker.js";

export const roleMap = {
  worker: [
    ["a2p", startA2pReconciliationWorker, stopA2pReconciliationWorker],
    [
      "maintenance",
      startAppointmentMaintenanceWorker,
      stopAppointmentMaintenanceWorker,
    ],
    ["automation", startAutomationWorker, stopAutomationWorker],
    ["lifecycle", startTrialLifecycleWorker, stopTrialLifecycleWorker],
    ["sms", startSmsProcessingWorker, stopSmsProcessingWorker],
    ["webhook-work", startWebhookWorkWorker, stopWebhookWorkWorker],
    ["sms-ingress", startSmsIngressReconciliationWorker, stopSmsIngressReconciliationWorker],
    ["sms-delivery", startSmsDeliveryReconciliationWorker, stopSmsDeliveryReconciliationWorker],
    ["sms-lifecycle", startConversationLifecycleWorker, stopConversationLifecycleWorker],
    [
      "voice-usage",
      startVoiceUsageReconciliationWorker,
      stopVoiceUsageReconciliationWorker,
    ],
  ],
  "worker-sms": [
    ["sms", startSmsProcessingWorker, stopSmsProcessingWorker],
    ["webhook-work", startWebhookWorkWorker, stopWebhookWorkWorker],
    ["sms-ingress", startSmsIngressReconciliationWorker, stopSmsIngressReconciliationWorker],
    ["sms-delivery", startSmsDeliveryReconciliationWorker, stopSmsDeliveryReconciliationWorker],
    ["sms-lifecycle", startConversationLifecycleWorker, stopConversationLifecycleWorker],
  ],
  "worker-automation": [
    ["automation", startAutomationWorker, stopAutomationWorker],
  ],
  "worker-lifecycle": [
    ["lifecycle", startTrialLifecycleWorker, stopTrialLifecycleWorker],
  ],
  "worker-a2p": [
    ["a2p", startA2pReconciliationWorker, stopA2pReconciliationWorker],
  ],
  "worker-voice-usage": [["voice-usage", startVoiceUsageReconciliationWorker, stopVoiceUsageReconciliationWorker]],
  "worker-maintenance": [
    [
      "maintenance",
      startAppointmentMaintenanceWorker,
      stopAppointmentMaintenanceWorker,
    ],
  ],
};

let workerIo = null;
let stopping = false;
let activeStops = [];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const shutdown = async (signal, exitCode = 0) => {
  if (stopping) return;
  stopping = true;
  safeConsole.log(`Worker shutdown requested (${signal})`);

  for (const [name, stop] of activeStops.reverse()) {
    try {
      await Promise.resolve(stop());
    } catch (error) {
      safeConsole.error(`Failed stopping ${name} worker:`, error);
      exitCode = 1;
    }
  }

  // Existing queue leases remain the source of truth. This grace period lets
  // any synchronous stop signal be observed before Mongo is closed.
  const graceMs = Math.min(
    10000,
    Math.max(
      0,
      Number.parseInt(process.env.WORKER_DRAIN_GRACE_MS || "3000", 10) || 0,
    ),
  );
  if (graceMs) await delay(graceMs);

  if (workerIo) await new Promise(resolve => workerIo.close(resolve));
  await closeSocketRedisAdapter();
  await closeScaleCache();
  await mongoose.connection.close().catch((error) => {
    safeConsole.error("MongoDB close failed:", error);
    exitCode = 1;
  });

  process.exitCode = exitCode;
};

export const startWorkerProcess = async ({
  connect = connectDB,
  workerRoles = roleMap,
  initializeRealtime = async () => {
    workerIo = new Server({ serveClient: false });
    await initializeSocketRedisAdapter(workerIo);
    SocketService.initialize(workerIo);
  },
} = {}) => {
  normalizeRuntimeEnvironment();
  validateEnvironment(process.env, { throwOnError: true });
  assertRealtimeScalingConfig();

  const role = assertValidProcessRole();
  if (!workerRoles[role]) {
    throw new Error(
      `PROCESS_ROLE=${role} is not a worker role. Use worker, worker-sms, worker-automation, worker-lifecycle, worker-a2p, or worker-maintenance.`,
    );
  }

  await connect();
  if (workerRoles === roleMap || process.env.SOCKET_REDIS_URL || process.env.REDIS_URL) await initializeRealtime();
  activeStops = [];
  for (const [name, start, stop] of workerRoles[role]) {
    activeStops.push([name, stop]);
    await start();
    safeConsole.log(`Started ${name} worker`);
  }

  safeConsole.log(`CallBackIQ worker process ready (${getProcessRole()})`);
};

const workerBootTestMode =
  String(process.env.CALLBACKIQ_WORKER_BOOT_TEST || "").toLowerCase() === "true";

if (!workerBootTestMode) {
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  process.on("unhandledRejection", (error) => {
    safeConsole.error("Unhandled worker rejection:", error);
    void shutdown("unhandledRejection", 1);
  });
  process.on("uncaughtException", (error) => {
    safeConsole.error("Uncaught worker exception:", error);
    void shutdown("uncaughtException", 1);
  });

  void startWorkerProcess().catch((error) => {
    safeConsole.error("Worker startup failed:", error);
    void shutdown("startupFailure", 1);
  });
}
