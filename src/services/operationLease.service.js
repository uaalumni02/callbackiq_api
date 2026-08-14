import crypto from "node:crypto";

import OperationLease from "../models/operationLease.js";

const asPositiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

export const acquireOperationLease = async ({
  key,
  ttlMs = 120_000,
  busyCode = "OPERATION_IN_PROGRESS",
  busyMessage = "This operation is already in progress.",
  busyStatusCode = 409,
  waitMs = 0,
  retryDelayMs = 100,
}) => {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) {
    const error = new Error("Operation lease key is required.");
    error.code = "OPERATION_LEASE_KEY_REQUIRED";
    error.statusCode = 500;
    throw error;
  }

  const ttl = asPositiveInteger(ttlMs, 120_000);
  const wait = Math.max(0, Number(waitMs) || 0);
  const retryDelay = asPositiveInteger(retryDelayMs, 100);
  const deadline = Date.now() + wait;
  const token = crypto.randomUUID();

  while (true) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl);

    try {
      await OperationLease.create({
        _id: normalizedKey,
        token,
        expiresAt,
      });
      return { key: normalizedKey, token, expiresAt };
    } catch (error) {
      if (Number(error?.code) !== 11000) throw error;

      const stale = await OperationLease.deleteOne({
        _id: normalizedKey,
        expiresAt: { $lte: now },
      });

      if (stale?.deletedCount) continue;

      if (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        continue;
      }

      const busy = new Error(busyMessage);
      busy.code = busyCode;
      busy.statusCode = busyStatusCode;
      throw busy;
    }
  }
};

export const releaseOperationLease = async (lease) => {
  if (!lease?.key || !lease?.token) return;
  await OperationLease.deleteOne({
    _id: lease.key,
    token: lease.token,
  }).catch(() => {});
};
