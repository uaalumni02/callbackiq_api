import crypto from "crypto";
import SmsProcessingJob from "../../models/smsProcessingJob.js";

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;

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
        availableAt: new Date(),
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
    { _id: jobId, status: "processing", leaseToken },
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
    { _id: job._id, status: "processing", leaseToken },
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

export const heartbeatInboundSmsJob = async ({ jobId, leaseToken }) => {
  return SmsProcessingJob.updateOne(
    { _id: jobId, status: "processing", leaseToken },
    { $set: { leaseExpiresAt: new Date(Date.now() + leaseMs()) } },
  );
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
  getInboundSmsQueueHealth,
};
