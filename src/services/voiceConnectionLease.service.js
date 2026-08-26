import crypto from "crypto";

import VoiceConnectionBucket from "../models/voiceConnectionBucket.js";

const MINUTE_MS = 60 * 1000;
const normalizeIp = (value) => String(value || "unknown").trim().slice(0, 100);
const hashIp = (value) =>
  crypto.createHash("sha256").update(normalizeIp(value)).digest("hex");

export const acquireVoiceConnectionLease = async ({
  remoteAddress,
  maximum = 5,
  limit = null,
  ttlMs = Number(process.env.VOICE_WS_PENDING_LEASE_MS) || 30_000,
  now = new Date(),
}) => {
  const max = Math.max(1, Math.min(50, Number(limit ?? maximum) || 5));
  const leaseId = crypto.randomUUID();
  const ipHash = hashIp(remoteAddress);
  const expiresAt = new Date(now.getTime() + Math.max(5_000, Number(ttlMs) || 30_000));
  const purgeAt = new Date(now.getTime() + 10 * MINUTE_MS);
  const filterExpired = {
    $filter: {
      input: { $ifNull: ["$leases", []] },
      as: "lease",
      cond: { $gt: ["$$lease.expiresAt", now] },
    },
  };

  /*
   * MongoDB does not permit $expr in the predicate of an upsert.
   *
   * Ensure the per-IP bucket exists first using a simple equality
   * predicate. Concurrent creators may race on the unique ipHash
   * index; a duplicate-key result is harmless because another caller
   * successfully created the same bucket.
   */
  try {
    await VoiceConnectionBucket.updateOne(
      { ipHash },
      {
        $setOnInsert: {
          ipHash,
          leases: [],
          purgeAt,
        },
      },
      { upsert: true },
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }

  /*
   * The actual reservation remains a single atomic document update.
   * MongoDB re-evaluates this predicate while applying concurrent
   * writes, so no lease is appended once the active count reaches max.
   */
  const bucket = await VoiceConnectionBucket.findOneAndUpdate(
    {
      ipHash,
      $expr: { $lt: [{ $size: filterExpired }, max] },
    },
    [
      {
        $set: {
          ipHash,
          leases: {
            $concatArrays: [filterExpired, [{ leaseId, expiresAt }]],
          },
          purgeAt,
        },
      },
    ],
    {
      upsert: false,
      returnDocument: "after",
      updatePipeline: true,
    },
  );

  if (!bucket) {
    return {
      allowed: false,
      reason: "voice_ws_pending_limit",
      ipHash,
    };
  }

  return {
    allowed: true,
    leaseId,
    ipHash,
    lease: { leaseId, ipHash },
    pending: bucket.leases.length,
  };
};

export const releaseVoiceConnectionLease = async (lease = {}) => {
  const { ipHash, leaseId } = lease || {};
  if (!ipHash || !leaseId) return;
  await VoiceConnectionBucket.updateOne(
    { ipHash },
    { $pull: { leases: { leaseId } }, $set: { purgeAt: new Date(Date.now() + 10 * MINUTE_MS) } },
  );
};

export const sweepVoiceConnectionLeases = async ({ now = new Date() } = {}) => {
  const result = await VoiceConnectionBucket.updateMany(
    { "leases.expiresAt": { $lte: now } },
    [
      {
        $set: {
          leases: {
            $filter: {
              input: { $ifNull: ["$leases", []] },
              as: "lease",
              cond: { $gt: ["$$lease.expiresAt", now] },
            },
          },
          purgeAt: new Date(now.getTime() + 10 * MINUTE_MS),
        },
      },
    ],
    { updatePipeline: true },
  );
  return { modified: result.modifiedCount || 0 };
};

export const sweepExpiredVoiceConnectionLeases = sweepVoiceConnectionLeases;

export default {
  acquireVoiceConnectionLease,
  releaseVoiceConnectionLease,
  sweepVoiceConnectionLeases,
  sweepExpiredVoiceConnectionLeases,
};
