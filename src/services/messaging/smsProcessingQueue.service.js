import crypto from "crypto";
import SmsProcessingJob from "../../models/smsProcessingJob.js";
import Message from "../../models/message.js";
import AlertService from "../alert.service.js";
import { logOperationalEvent } from "../../helpers/logging/safeLogger.js";

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_TURN_COALESCE_MS = 3_000;

const turnCoalesceMs = () => {
  const configured = Number(process.env.SMS_TURN_COALESCE_MS);
  return Number.isFinite(configured) && configured >= 0
    ? Math.min(15_000, configured)
    : DEFAULT_TURN_COALESCE_MS;
};

const leaseMs = () => {
  const configured = Number(process.env.SMS_PROCESSING_LEASE_MS);
  return Number.isFinite(configured) && configured >= 10_000
    ? configured
    : DEFAULT_LEASE_MS;
};

const maxAttempts = () => {
  const configured = Number(process.env.SMS_PROCESSING_MAX_ATTEMPTS);
  return Number.isFinite(configured) && configured >= 1
    ? Math.min(20, configured)
    : DEFAULT_MAX_ATTEMPTS;
};

const retryDelayMs = (attemptCount) =>
  Math.min(15 * 60_000, Math.max(5_000, 5_000 * 2 ** Math.max(0, attemptCount - 1)));

export const enqueueInboundSmsJob = async ({
  businessId,
  inboundMessageId,
  conversationId,
  leadId,
  providerMessageId = "",
  priority = 50,
}) => {
  return SmsProcessingJob.findOneAndUpdate(
    { inboundMessage: inboundMessageId },
    {
      $setOnInsert: {
        business: businessId,
        inboundMessage: inboundMessageId,
        conversation: conversationId,
        lead: leadId,
        providerMessageId,
        status: "queued",
        priority,
        attemptCount: 0,
        maxAttempts: maxAttempts(),
        availableAt: new Date(Date.now() + turnCoalesceMs()),
      },
    },
    {
      upsert: true,
      returnDocument: "after",
      setDefaultsOnInsert: true,
    },
  );
};

export const claimNextInboundSmsJob = async ({ now = new Date() } = {}) => {
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs());
  return SmsProcessingJob.findOneAndUpdate(
    {
      $expr: { $lt: ["$attemptCount", "$maxAttempts"] },
      $or: [
        { status: "queued", availableAt: { $lte: now } },
        { status: "retry", availableAt: { $lte: now } },
        { status: "processing", leaseExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        status: "processing",
        leaseToken,
        leaseExpiresAt,
        processingStartedAt: now,
        lastError: "",
      },
      $inc: { attemptCount: 1 },
    },
    {
      sort: { priority: -1, availableAt: 1, createdAt: 1 },
      returnDocument: "after",
    },
  );
};

export const completeInboundSmsJob = async ({ jobId, leaseToken, result = {} }) => {
  return SmsProcessingJob.findOneAndUpdate(
    { _id: jobId, status: "processing", leaseToken, leaseExpiresAt: { $gt: new Date() } },
    {
      $set: {
        status: "completed",
        completedAt: new Date(),
        leaseToken: "",
        leaseExpiresAt: null,
        result,
        lastError: "",
      },
    },
    { returnDocument: "after" },
  );
};

export const failInboundSmsJob = async ({ job, error, leaseToken }) => {
  const failure = error instanceof Error ? error.message : String(error || "Unknown error");
  const isDead = job.attemptCount >= job.maxAttempts;
  return SmsProcessingJob.findOneAndUpdate(
    { _id: job._id, status: "processing", leaseToken, leaseExpiresAt: { $gt: new Date() } },
    {
      $set: {
        status: isDead ? "dead" : "retry",
        availableAt: isDead
          ? new Date()
          : new Date(Date.now() + retryDelayMs(job.attemptCount)),
        leaseToken: "",
        leaseExpiresAt: null,
        lastError: failure,
        ...(isDead ? { deadAt: new Date() } : {}),
      },
    },
    { returnDocument: "after" },
  );
};

export const deferInboundSmsJob = async ({
  jobId,
  leaseToken,
  delayMs = 500,
  reason = "conversation_busy",
}) => {
  const safeDelay = Math.max(100, Math.min(5_000, Number(delayMs) || 500));
  return SmsProcessingJob.findOneAndUpdate(
    { _id: jobId, status: "processing", leaseToken, leaseExpiresAt: { $gt: new Date() } },
    {
      $set: {
        status: "queued",
        availableAt: new Date(Date.now() + safeDelay),
        leaseToken: "",
        leaseExpiresAt: null,
        processingStartedAt: null,
        lastError: reason,
      },
      $inc: { attemptCount: -1 },
    },
    { returnDocument: "after" },
  );
};

export const heartbeatInboundSmsJob = async ({ jobId, leaseToken }) => {
  return SmsProcessingJob.updateOne(
    { _id: jobId, status: "processing", leaseToken, leaseExpiresAt: { $gt: new Date() } },
    { $set: { leaseExpiresAt: new Date(Date.now() + leaseMs()) } },
  );
};

export const reconcileOrphanedInboundSmsJobs = async ({
  limit = 100,
  horizonMs = 7 * 24 * 60 * 60 * 1000,
} = {}) => {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const cutoff = new Date(Date.now() - Math.max(60000, Number(horizonMs) || 0));

  const candidates = await Message.find({
    direction: "inbound",
    provider: "twilio",
    providerMessageId: { $ne: "" },
    "metadata.processingRequired": true,
    "metadata.processingEnqueuedAt": null,
    createdAt: { $gte: cutoff },
  })
    .sort({ createdAt: 1, _id: 1 })
    .limit(safeLimit)
    .select("_id business conversation lead providerMessageId")
    .lean();

  if (!candidates.length) {
    return { examined: 0, repaired: 0 };
  }

  const existingJobs = await SmsProcessingJob.find({
    inboundMessage: { $in: candidates.map((item) => item._id) },
  })
    .select("inboundMessage")
    .lean();
  const existing = new Set(
    existingJobs.map((job) => String(job.inboundMessage)),
  );

  let repaired = 0;
  for (const message of candidates) {
    if (existing.has(String(message._id))) {
      await Message.updateOne(
        { _id: message._id },
        {
          $set: {
            "metadata.processingEnqueuedAt": new Date(),
            "metadata.processingReconciled": true,
          },
        },
      );
      continue;
    }
    if (!message.business || !message.conversation || !message.lead) {
      const missingFields = [
        !message.business ? "business" : "",
        !message.conversation ? "conversation" : "",
        !message.lead ? "lead" : "",
      ].filter(Boolean);
      const failedAt = new Date();

      await Message.updateOne(
        { _id: message._id },
        {
          $set: {
            "metadata.processingRequired": false,
            "metadata.processingReconciliationState": "invalid_context",
            "metadata.processingReconciliationError":
              `missing_${missingFields.join("_")}`,
            "metadata.processingReconciliationFailedAt": failedAt,
          },
        },
      );

      logOperationalEvent("sms.ingress_reconciliation_invalid_context", {
        messageId: String(message._id),
        businessId: message.business ? String(message.business) : "",
        conversationId: message.conversation
          ? String(message.conversation)
          : "",
        leadId: message.lead ? String(message.lead) : "",
        providerMessageId: message.providerMessageId || "",
        missingFields,
      });

      if (message.business) {
        await AlertService.createSystemAlert({
          businessId: message.business,
          title: "Inbound SMS needs reconciliation",
          message:
            "A persisted customer SMS is missing required processing context and could not be queued automatically.",
          priority: "critical",
          metadata: {
            inboundMessageId: String(message._id),
            providerMessageId: message.providerMessageId || "",
            missingFields,
          },
          dedupeKey: `sms_ingress_invalid_context:${message._id}`,
        });
      }

      continue;
    }

    await enqueueInboundSmsJob({
      businessId: message.business,
      inboundMessageId: message._id,
      conversationId: message.conversation,
      leadId: message.lead,
      providerMessageId: message.providerMessageId,
    });
    await Message.updateOne(
      { _id: message._id },
      {
        $set: {
          "metadata.processingEnqueuedAt": new Date(),
          "metadata.processingReconciled": true,
        },
      },
    );
    repaired += 1;
  }

  return {
    examined: candidates.length,
    repaired,
  };
};

export const getInboundSmsQueueHealth = async () => {
  const now = new Date();
  const [queued, retry, processing, expired, dead] = await Promise.all([
    SmsProcessingJob.countDocuments({ status: "queued" }),
    SmsProcessingJob.countDocuments({ status: "retry" }),
    SmsProcessingJob.countDocuments({ status: "processing" }),
    SmsProcessingJob.countDocuments({
      status: "processing",
      leaseExpiresAt: { $lte: now },
    }),
    SmsProcessingJob.countDocuments({ status: "dead" }),
  ]);
  return { queued, retry, processing, expired, dead };
};

export default {
  enqueueInboundSmsJob,
  claimNextInboundSmsJob,
  completeInboundSmsJob,
  failInboundSmsJob,
  heartbeatInboundSmsJob,
  deferInboundSmsJob,
  reconcileOrphanedInboundSmsJobs,
  getInboundSmsQueueHealth,
};
