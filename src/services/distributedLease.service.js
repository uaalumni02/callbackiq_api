import { safeConsole } from "../helpers/logging/safeLogger.js";
// CALLBACKIQ_PRODUCTION_HARDENING_V1
import crypto from "crypto";
import ProductionOperationLease from "../models/productionOperationLease.js";

const toPositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const acquireDistributedLease = async (
  key,
  { ttlMs = 300000, metadata = null } = {},
) => {
  const leaseKey = String(key || "").trim();
  if (!leaseKey) throw new Error("Distributed lease key is required");

  const ownerToken = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + toPositiveInteger(ttlMs, 300000));

  try {
    const lease = await ProductionOperationLease.findOneAndUpdate(
      {
        _id: leaseKey,
        $or: [{ expiresAt: { $lte: now } }, { ownerToken }],
      },
      {
        $set: { ownerToken, expiresAt, metadata },
        $setOnInsert: { _id: leaseKey },
      },
      {
        upsert: true,
        returnDocument: "after",
        runValidators: true,
      },
    ).lean();

    return lease?.ownerToken === ownerToken
      ? { acquired: true, key: leaseKey, ownerToken, expiresAt }
      : { acquired: false, key: leaseKey };
  } catch (error) {
    if (Number(error?.code) === 11000) {
      return { acquired: false, key: leaseKey };
    }
    throw error;
  }
};

export const renewDistributedLease = async (
  key,
  ownerToken,
  { ttlMs = 300000 } = {},
) => {
  const expiresAt = new Date(
    Date.now() + toPositiveInteger(ttlMs, 300000),
  );
  const result = await ProductionOperationLease.updateOne(
    { _id: String(key), ownerToken },
    { $set: { expiresAt } },
  );
  return result.matchedCount === 1;
};

export const releaseDistributedLease = async (key, ownerToken) => {
  if (!key || !ownerToken) return false;
  const result = await ProductionOperationLease.deleteOne({
    _id: String(key),
    ownerToken,
  });
  return result.deletedCount === 1;
};

export const withDistributedLease = async (
  key,
  operation,
  { ttlMs = 300000, metadata = null, heartbeat = true } = {},
) => {
  if (typeof operation !== "function") {
    throw new TypeError("Distributed lease operation must be a function");
  }

  const lease = await acquireDistributedLease(key, { ttlMs, metadata });
  if (!lease.acquired) {
    return { acquired: false, skipped: true, value: undefined };
  }

  let heartbeatTimer = null;
  if (heartbeat) {
    const intervalMs = Math.max(1000, Math.floor(ttlMs / 3));
    heartbeatTimer = setInterval(() => {
      void renewDistributedLease(key, lease.ownerToken, { ttlMs }).catch(
        (error) => {
          safeConsole.error("Distributed lease heartbeat failed:", {
            key,
            error: error?.message || String(error),
          });
        },
      );
    }, intervalMs);
    heartbeatTimer.unref?.();
  }

  try {
    return {
      acquired: true,
      skipped: false,
      value: await operation(),
    };
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await releaseDistributedLease(key, lease.ownerToken).catch((error) => {
      safeConsole.error("Distributed lease release failed:", {
        key,
        error: error?.message || String(error),
      });
    });
  }
};

export default {
  acquireDistributedLease,
  renewDistributedLease,
  releaseDistributedLease,
  withDistributedLease,
};
