import {
  listVoiceUsageReconciliationCandidates,
  reconcileVoiceUsage,
} from "../services/voiceUsage.service.js";
import {
  logOperationalEvent,
  logOperationalError,
} from "../helpers/logging/safeLogger.js";

const DEFAULT_INTERVAL_MS = 500;
const DEFAULT_BUSY_DELAY_MS = 50;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_CONCURRENCY = 2;

let timer = null;
let running = false;

const boundedInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

const intervalMs = () =>
  boundedInteger(
    process.env.VOICE_USAGE_RECONCILIATION_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
    100,
    60_000,
  );

const busyDelayMs = () =>
  boundedInteger(
    process.env.VOICE_USAGE_RECONCILIATION_BUSY_DELAY_MS,
    DEFAULT_BUSY_DELAY_MS,
    10,
    5_000,
  );

const batchSize = () =>
  boundedInteger(
    process.env.VOICE_USAGE_RECONCILIATION_BATCH_SIZE,
    DEFAULT_BATCH_SIZE,
    1,
    200,
  );

const concurrency = () => {
  if (process.env.NODE_ENV === "test") return 1;

  return boundedInteger(
    process.env.VOICE_USAGE_RECONCILIATION_CONCURRENCY,
    DEFAULT_CONCURRENCY,
    1,
    10,
  );
};

const processCandidate = async (job) => {
  try {
    return await reconcileVoiceUsage({
      businessId: job.business,
      sessionId: job.session,
      actualSeconds: job.actualSeconds,
      openAiInputTokens: job.openAiInputTokens,
      openAiOutputTokens: job.openAiOutputTokens,
      twilioEstimatedCostCents: job.twilioEstimatedCostCents,
      openAiEstimatedCostCents: job.openAiEstimatedCostCents,
      transferAttempts: job.transferAttempts,
    });
  } catch (error) {
    logOperationalError(
      "voice_usage.reconciliation_worker.job_failed",
      error,
      {
        reconciliationId: job._id,
        businessId: job.business,
        sessionId: job.session,
      },
    );

    return null;
  }
};

export const drainVoiceUsageReconciliationQueueOnce = async () => {
  if (running) {
    return {
      processed: 0,
      businesses: 0,
      skipped: true,
    };
  }

  running = true;

  try {
    const candidates =
      await listVoiceUsageReconciliationCandidates({
        limit: batchSize(),
      });

    if (!candidates.length) {
      return {
        processed: 0,
        businesses: 0,
        skipped: false,
      };
    }

    /*
     * Jobs for one business update the same daily/monthly usage ledgers.
     * Keep those jobs sequential while allowing independent businesses to
     * reconcile concurrently.
     */
    const grouped = new Map();

    for (const candidate of candidates) {
      const businessKey = String(candidate.business);

      if (!grouped.has(businessKey)) {
        grouped.set(businessKey, []);
      }

      grouped.get(businessKey).push(candidate);
    }

    const businessGroups = [...grouped.values()];
    const laneCount = Math.min(concurrency(), businessGroups.length);

    let nextGroup = 0;
    let processed = 0;

    const runLane = async () => {
      while (true) {
        const index = nextGroup;
        nextGroup += 1;

        if (index >= businessGroups.length) return;

        for (const job of businessGroups[index]) {
          await processCandidate(job);
          processed += 1;
        }
      }
    };

    await Promise.all(
      Array.from({ length: laneCount }, () => runLane()),
    );

    return {
      processed,
      businesses: businessGroups.length,
      skipped: false,
    };
  } finally {
    running = false;
  }
};

const scheduleNext = (delayMs = intervalMs()) => {
  timer = setTimeout(async () => {
    try {
      const result = await drainVoiceUsageReconciliationQueueOnce();

      if (result.processed > 0) {
        logOperationalEvent(
          "voice_usage.reconciliation_worker.batch",
          {
            ...result,
            concurrency: concurrency(),
          },
        );
      }

      if (timer) {
        scheduleNext(
          result.processed >= batchSize()
            ? busyDelayMs()
            : intervalMs(),
        );
      }
    } catch (error) {
      logOperationalError(
        "voice_usage.reconciliation_worker.failed",
        error,
      );

      if (timer) scheduleNext(intervalMs());
    }
  }, delayMs);

  timer.unref?.();
};

export const startVoiceUsageReconciliationWorker = () => {
  if (
    timer ||
    String(
      process.env.VOICE_USAGE_RECONCILIATION_WORKER_ENABLED || "true",
    ).toLowerCase() === "false"
  ) {
    return;
  }

  logOperationalEvent(
    "voice_usage.reconciliation_worker.started",
    {
      intervalMs: intervalMs(),
      busyDelayMs: busyDelayMs(),
      batchSize: batchSize(),
      concurrency: concurrency(),
    },
  );

  scheduleNext(0);
};

export const stopVoiceUsageReconciliationWorker = () => {
  if (timer) clearTimeout(timer);
  timer = null;

  logOperationalEvent(
    "voice_usage.reconciliation_worker.stopped",
  );
};

export default {
  startVoiceUsageReconciliationWorker,
  stopVoiceUsageReconciliationWorker,
  drainVoiceUsageReconciliationQueueOnce,
};
