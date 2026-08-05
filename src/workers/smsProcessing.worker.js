import {
  claimNextInboundSmsJob,
  completeInboundSmsJob,
  failInboundSmsJob,
  heartbeatInboundSmsJob,
} from "../services/messaging/smsProcessingQueue.service.js";
import { safelyProcessInboundSmsJob } from "../services/messaging/inboundSmsJobProcessor.service.js";
import AlertService from "../services/alert.service.js";
import { logOperationalEvent, logOperationalError } from "../helpers/logging/safeLogger.js";

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_BATCH_SIZE = 10;
let timer = null;
let running = false;

const intervalMs = () => {
  const value = Number(process.env.SMS_PROCESSING_INTERVAL_MS);
  return Number.isFinite(value) && value >= 250 ? value : DEFAULT_INTERVAL_MS;
};

const batchSize = () => {
  const value = Number(process.env.SMS_PROCESSING_BATCH_SIZE);
  return Number.isFinite(value) && value >= 1
    ? Math.min(50, Math.floor(value))
    : DEFAULT_BATCH_SIZE;
};

const processWithHeartbeat = async (job) => {
  const heartbeatEveryMs = Math.max(5_000, Math.floor(Number(process.env.SMS_PROCESSING_LEASE_MS || 60_000) / 3));
  const heartbeat = setInterval(() => {
    void heartbeatInboundSmsJob({ jobId: job._id, leaseToken: job.leaseToken }).catch((error) =>
      logOperationalError("sms.processing_worker.heartbeat_failed", error, {
        jobId: job._id,
        businessId: job.business,
      }),
    );
  }, heartbeatEveryMs);
  heartbeat.unref?.();
  try {
    return await safelyProcessInboundSmsJob(job);
  } finally {
    clearInterval(heartbeat);
  }
};

export const drainSmsProcessingQueueOnce = async () => {
  if (running) return { processed: 0, skipped: true };
  running = true;
  let processed = 0;
  try {
    for (let index = 0; index < batchSize(); index += 1) {
      const job = await claimNextInboundSmsJob();
      if (!job) break;
      processed += 1;
      try {
        const result = await processWithHeartbeat(job);
        await completeInboundSmsJob({
          jobId: job._id,
          leaseToken: job.leaseToken,
          result,
        });
      } catch (error) {
        const failed = await failInboundSmsJob({
          job,
          leaseToken: job.leaseToken,
          error,
        });
        if (failed?.status === "dead") {
          await AlertService.createSystemAlert({
            businessId: job.business,
            title: "SMS response failed permanently",
            message:
              "CallBackIQ could not process a customer SMS after multiple attempts. Review the conversation and respond manually.",
            priority: "critical",
            metadata: {
              jobId: String(job._id),
              conversationId: String(job.conversation),
              inboundMessageId: String(job.inboundMessage),
              attempts: failed.attemptCount,
            },
            dedupeKey: `sms_processing_dead:${job._id}`,
          });
        }
      }
    }
  } finally {
    running = false;
  }
  return { processed, skipped: false };
};

const scheduleNext = () => {
  timer = setTimeout(async () => {
    try {
      const result = await drainSmsProcessingQueueOnce();
      if (result.processed > 0) {
        logOperationalEvent("sms.processing_worker.batch", result);
      }
    } catch (error) {
      logOperationalError("sms.processing_worker.failed", error);
    } finally {
      if (timer) scheduleNext();
    }
  }, intervalMs());
  timer.unref?.();
};

export const startSmsProcessingWorker = async () => {
  if (timer || String(process.env.SMS_PROCESSING_WORKER_ENABLED || "true").toLowerCase() === "false") {
    return;
  }
  logOperationalEvent("sms.processing_worker.started", {
    intervalMs: intervalMs(),
    batchSize: batchSize(),
  });
  await drainSmsProcessingQueueOnce();
  scheduleNext();
};

export const stopSmsProcessingWorker = () => {
  if (timer) clearTimeout(timer);
  timer = null;
  logOperationalEvent("sms.processing_worker.stopped");
};

export default {
  startSmsProcessingWorker,
  stopSmsProcessingWorker,
  drainSmsProcessingQueueOnce,
};
