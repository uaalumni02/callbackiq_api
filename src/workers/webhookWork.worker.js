import WebhookWork from "../models/webhookWork.js";
import { claimWebhookWork } from "../services/webhooks/webhookWork.service.js";
import { withDeadline } from "../services/boundedRedis.service.js";
import AlertService from "../services/alert.service.js";
import { logOperationalError } from "../helpers/logging/safeLogger.js";
let timer = null;
let stopping = false;
let current = null;

export const processWebhookWork = async (job) => {
  const identity = { _id: job._id, status: "processing", leaseToken: job.leaseToken };
  const heartbeat = setInterval(() => {
    void WebhookWork.updateOne(identity, { $set: { leaseUntil: new Date(Date.now() + 120000) } })
      .catch(error => logOperationalError("webhook_work.heartbeat_failed", error, { jobId: job._id }));
  }, 30000);
  heartbeat.unref?.();
  try {
    if (job.attempts > 8) throw Object.assign(new Error("Retry budget exhausted after an interrupted attempt"), { code: "RETRY_EXHAUSTED" });
    if (job.kind === "recovery_sms") {
      const { processRecoveryIntroductionJob } = await import("../services/twilioSmsWebhook.service.js");
      await processRecoveryIntroductionJob(job.payload);
    } else if (job.kind === "missed_followup") {
      const { scheduleMissedCallFollowUp } = await import("../middleware/missed-call-automation-lifecycle.js");
      await scheduleMissedCallFollowUp({ body: job.payload, businessId: job.business, retryMissingConversation: true });
    } else throw new Error("Unsupported webhook job type");
    await WebhookWork.updateOne(identity, { $set: { status: "completed", completedAt: new Date() }, $unset: { leaseToken: 1, leaseUntil: 1 } });
  } catch (error) {
    const dead = job.attempts >= 8 || error.deliveryUncertain === true;
    const outcome = await WebhookWork.updateOne(identity, { $set: {
      status: dead ? "dead" : "queued", lastErrorCode: String(error.code || "PROCESSING_FAILED").slice(0, 120),
      availableAt: new Date(Date.now() + Math.min(300000, 1000 * 2 ** job.attempts)),
    }, $unset: { leaseToken: 1, leaseUntil: 1 } });
    if (dead && outcome.matchedCount > 0) await AlertService.createSystemAlert({ businessId: job.business, title: "Customer follow-up needs review",
      message: "A background customer recovery operation could not complete. Review the conversation before sending again.",
      priority: "high", metadata: { jobId: job._id, kind: job.kind }, dedupeKey: `webhook-work:${job._id}` });
    logOperationalError("webhook_work.failed", error, { jobId: job._id });
  } finally { clearInterval(heartbeat); }
};

export const drainWebhookWorkOnce = async () => {
  if (current) return current;
  const concurrency = Math.max(1, Math.min(25, Number(process.env.WEBHOOK_WORK_CONCURRENCY) || 5));
  current = Promise.all(Array.from({ length: concurrency }, async () => {
    for (let n = 0; n < 5 && !stopping; n++) {
      const job = await claimWebhookWork();
      if (!job) break;
      await processWebhookWork(job);
    }
  })).finally(() => { current = null; });
  return current;
};
export const startWebhookWorkWorker = async () => {
  if (timer) return;
  stopping = false;
  const tick = async () => {
    try { await drainWebhookWorkOnce(); } catch (error) { logOperationalError("webhook_work.poll_failed", error); }
    if (!stopping) { timer = setTimeout(tick, 250); timer.unref?.(); }
  };
  timer = setTimeout(tick, 0); timer.unref?.();
};
export const stopWebhookWorkWorker = async () => {
  stopping = true; clearTimeout(timer); timer = null;
  if (current) await withDeadline(current, Number(process.env.WORKER_DRAIN_TIMEOUT_MS) || 120000, "WORKER_DRAIN_TIMEOUT");
};
