import { withSmsTenantSlot, recordSmsProcessingDuration, recordSmsTenantDeferral } from "../services/scale/smsTenantFairness.service.js";
import { withDeadline } from "../services/boundedRedis.service.js";
import { withDistributedLease, assertDistributedLeaseActive, invalidateDistributedLease, registerDistributedLeaseGuard } from "../services/distributedLease.service.js";
// CALLBACKIQ_SCALE_HARDENING_V1
import {
  claimNextInboundSmsJob,
  completeInboundSmsJob,
  failInboundSmsJob,
  heartbeatInboundSmsJob,
  deferInboundSmsJob,
} from "../services/messaging/smsProcessingQueue.service.js";
import { safelyProcessInboundSmsJob } from "../services/messaging/inboundSmsJobProcessor.service.js";
import AlertService from "../services/alert.service.js";
import {
  logOperationalEvent,
  logOperationalError,
} from "../helpers/logging/safeLogger.js";

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_CONCURRENCY = 5;

let timer = null;
let running = false;
let stopGeneration = 0;

const intervalMs = () => {
  const value = Number(process.env.SMS_PROCESSING_INTERVAL_MS);
  return Number.isFinite(value) && value >= 100 ? value : DEFAULT_INTERVAL_MS;
};

const busyDelayMs = () => {
  const value = Number(process.env.SMS_PROCESSING_BUSY_DELAY_MS);
  return Number.isFinite(value) && value >= 0 ? Math.min(1000, value) : 25;
};

const batchSize = () => {
  const value = Number(process.env.SMS_PROCESSING_BATCH_SIZE);
  return Number.isFinite(value) && value >= 1
    ? Math.min(200, Math.floor(value))
    : DEFAULT_BATCH_SIZE;
};

const concurrency = () => {
  if (process.env.NODE_ENV === "test") return 1;
  const value = Number(process.env.SMS_PROCESSING_CONCURRENCY);
  return Number.isFinite(value) && value >= 1
    ? Math.min(50, Math.floor(value))
    : DEFAULT_CONCURRENCY;
};

const processWithHeartbeat = async (job) => {
  const heartbeatEveryMs = Math.max(
    5_000,
    Math.floor(Number(process.env.SMS_PROCESSING_LEASE_MS || 60_000) / 3),
  );
  const configuredJobTtl = Number(process.env.SMS_PROCESSING_LEASE_MS);
  const jobTtlMs = Number.isFinite(configuredJobTtl) && configuredJobTtl >= 10_000 ? configuredJobTtl : 60_000;
  let jobExpiresAt = job.leaseExpiresAt ? new Date(job.leaseExpiresAt).getTime() : Date.now() + jobTtlMs;
  let heartbeatError = null;
  registerDistributedLeaseGuard(() => {
    if (!Number.isFinite(jobExpiresAt) || Date.now() >= jobExpiresAt) throw Object.assign(new Error("SMS job lease expired"), { code: "DISTRIBUTED_LEASE_LOST" });
    if (heartbeatError) throw heartbeatError;
  });
  let heartbeatPending = null;
  const heartbeat = setInterval(() => {
    if (heartbeatPending || heartbeatError) return;
    const startedAt = Date.now();
    heartbeatPending = heartbeatInboundSmsJob({
      jobId: job._id,
      leaseToken: job.leaseToken,
    }).then((result) => {
      if (Date.now() >= jobExpiresAt || (result !== true && result?.matchedCount !== 1)) throw Object.assign(new Error("SMS job lease lost"), { code: "DISTRIBUTED_LEASE_LOST" });
      jobExpiresAt = startedAt + jobTtlMs;
    }).catch((error) => {
      heartbeatError = Object.assign(new Error("SMS job lease could not be renewed"), { code: "DISTRIBUTED_LEASE_LOST", cause: error });
      invalidateDistributedLease("SMS job lease could not be renewed");
      logOperationalError("sms.processing_worker.heartbeat_failed", error, {
        jobId: job._id,
        businessId: job.business,
      });
    }).finally(() => { heartbeatPending = null; });
  }, heartbeatEveryMs);
  heartbeat.unref?.();

  try {
    assertDistributedLeaseActive();
    const result = await safelyProcessInboundSmsJob(job);
    await heartbeatPending;
    if (heartbeatError) throw heartbeatError;
    assertDistributedLeaseActive();
    return result;
  } finally {
    clearInterval(heartbeat);
  }
};

const processConversationJob = async (job) => {
  try {
    const lease = await withDistributedLease(
      `sms-conversation:${job.conversation}`,
      async () => {
        const result = await processWithHeartbeat(job);
        assertDistributedLeaseActive();
        const completed = await completeInboundSmsJob({ jobId: job._id, leaseToken: job.leaseToken, result });
        if (!completed) throw Object.assign(new Error("SMS job completion lost its lease"), { code: "DISTRIBUTED_LEASE_LOST" });
        return result;
      },
      {
        ttlMs: Math.max(
          15_000,
          Number(process.env.SMS_CONVERSATION_LEASE_MS || process.env.SMS_PROCESSING_LEASE_MS || 60_000),
        ),
        metadata: {
          worker: "sms_processing",
          jobId: String(job._id),
          businessId: String(job.business),
        },
      },
    );

    if (!lease.acquired) {
      await deferInboundSmsJob({
        jobId: job._id,
        leaseToken: job.leaseToken,
        delayMs: 500,
        reason: "conversation_lease_busy",
      });
      return;
    }


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
};

const processClaimedJob = async (job) => {
  const admitted = await withSmsTenantSlot(job.business, async () => {
    const started = performance.now();
    try { return await processConversationJob(job); }
    finally { recordSmsProcessingDuration(performance.now() - started); }
  });
  if (!admitted.acquired) {
    recordSmsTenantDeferral();
    await deferInboundSmsJob({ jobId: job._id, leaseToken: job.leaseToken,
      delayMs: 500 + Math.floor(Math.random() * 1000), reason: "tenant_concurrency_limit" });
  }
};

export const drainSmsProcessingQueueOnce = async () => {
  if (running) return { processed: 0, skipped: true };
  running = true;

  const generation = stopGeneration;
  const maxJobs = batchSize();
  const laneCount = Math.min(concurrency(), maxJobs);
  let nextSlot = 0;
  let processed = 0;
  const servedBusinesses = new Set();

  const runLane = async () => {
    while (true) {
      const slot = nextSlot;
      nextSlot += 1;
      if (slot >= maxJobs || generation !== stopGeneration) return;

      let job = await claimNextInboundSmsJob({ excludeBusinesses: [...servedBusinesses] });
      if (!job && servedBusinesses.size) {
        servedBusinesses.clear();
        job = await claimNextInboundSmsJob();
      }
      if (!job) return;
      servedBusinesses.add(String(job.business));

      processed += 1;
      await processClaimedJob(job);
    }
  };

  try {
    const outcomes = await Promise.allSettled(Array.from({ length: laneCount }, () => runLane()));
    const failure = outcomes.find(item => item.status === "rejected");
    if (failure) throw failure.reason;
  } finally {
    running = false;
  }

  return {
    processed,
    skipped: false,
  };
};

const scheduleNext = (delayMs = intervalMs()) => {
  timer = setTimeout(async () => {
    try {
      const result = await drainSmsProcessingQueueOnce();
      const saturated = result.processed >= batchSize();
      if (result.processed > 0) {
        logOperationalEvent("sms.processing_worker.batch", {
          ...result,
          saturated,
          concurrency: concurrency(),
        });
      }
      if (timer) {
        scheduleNext(saturated ? busyDelayMs() : intervalMs());
      }
    } catch (error) {
      logOperationalError("sms.processing_worker.failed", error);
      if (timer) scheduleNext(intervalMs());
    }
  }, delayMs);
  timer.unref?.();
};

export const startSmsProcessingWorker = async () => {
  if (
    timer ||
    String(process.env.SMS_PROCESSING_WORKER_ENABLED || "true").toLowerCase() ===
      "false"
  ) {
    return;
  }

  logOperationalEvent("sms.processing_worker.started", {
    intervalMs: intervalMs(),
    busyDelayMs: busyDelayMs(),
    batchSize: batchSize(),
    concurrency: concurrency(),
  });

  const generation = stopGeneration;
  const initial = await drainSmsProcessingQueueOnce();
  if (generation !== stopGeneration) return;
  scheduleNext(
    initial.processed >= batchSize() ? busyDelayMs() : intervalMs(),
  );
};

export const stopSmsProcessingWorker = async () => {
  stopGeneration++;
  if (timer) clearTimeout(timer);
  timer = null;
  await withDeadline((async () => {
    while (running) await new Promise(resolve => setTimeout(resolve, 25));
  })(), Number(process.env.WORKER_DRAIN_TIMEOUT_MS) || 120000, "SMS_WORKER_DRAIN_TIMEOUT");
  logOperationalEvent("sms.processing_worker.stopped");
};

export default {
  startSmsProcessingWorker,
  stopSmsProcessingWorker,
  drainSmsProcessingQueueOnce,
};
