import { safeConsole } from "../helpers/logging/safeLogger.js";
// CALLBACKIQ_PRODUCTION_HARDENING_V1
import crypto from "crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import ProductionOperationLease from "../models/productionOperationLease.js";

const leaseScope = new AsyncLocalStorage();

const leaseLostError = (reason) => Object.assign(new Error(`Distributed lease lost: ${reason}`), { code: "DISTRIBUTED_LEASE_LOST" });

export const invalidateDistributedLease = (reason = "ownership could not be verified") => {
  const scope = leaseScope.getStore();
  if (scope && !scope.error) scope.error = leaseLostError(reason);
};

export const registerDistributedLeaseGuard = (guard) => {
  const scope = leaseScope.getStore();
  if (scope && typeof guard === "function") scope.guards.push(guard);
};

export const assertDistributedLeaseActive = () => {
  for (let scope = leaseScope.getStore(); scope; scope = scope.parent) {
    if (!scope.error && Date.now() >= scope.expiresAt) scope.error = leaseLostError("lease expired");
    if (scope.error) throw scope.error;
    for (const guard of scope.guards) guard();
  }
};

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
  const now = new Date();
  const expiresAt = new Date(now.getTime() + toPositiveInteger(ttlMs, 300000));
  const result = await ProductionOperationLease.updateOne(
    { _id: String(key), ownerToken, expiresAt: { $gt: now } },
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

  const duration = toPositiveInteger(ttlMs, 300000);
  const scope = { guards: [], expiresAt: lease.expiresAt.getTime(), error: null, parent: leaseScope.getStore() };
  return leaseScope.run(scope, async () => {
    let heartbeatTimer = null;
    let renewing = false;
    let finished = false;
    let heartbeatInFlight = Promise.resolve();
    if (heartbeat) {
      heartbeatTimer = setInterval(() => {
        if (renewing || finished || scope.error) return;
        renewing = true;
        heartbeatInFlight = leaseScope.run(scope, async () => {
          const startedAt = Date.now();
          try {
            assertDistributedLeaseActive();
            const renewed = await renewDistributedLease(key, lease.ownerToken, { ttlMs: duration });
            // A late response must not restore permission to a stalled worker.
            assertDistributedLeaseActive();
            if (!renewed) invalidateDistributedLease("renewal no longer owns the lease");
            else scope.expiresAt = startedAt + duration;
          } catch (error) {
            invalidateDistributedLease("renewal failed");
            safeConsole.error("Distributed lease heartbeat failed:", { key, error: error?.message || String(error) });
          } finally {
            renewing = false;
          }
        });
      }, Math.max(25, Math.floor(duration / 3)));
      heartbeatTimer.unref?.();
    }
    try {
      assertDistributedLeaseActive();
      const value = await operation();
      await heartbeatInFlight;
      assertDistributedLeaseActive();
      return { acquired: true, skipped: false, value };
    } finally {
      finished = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      // Detached continuations must also fail their next assertion.
      if (!scope.error) scope.error = leaseLostError("operation finished");
      await releaseDistributedLease(key, lease.ownerToken).catch((error) => {
        safeConsole.error("Distributed lease release failed:", { key, error: error?.message || String(error) });
      });
    }
  });
};

export default {
  assertDistributedLeaseActive,
  invalidateDistributedLease,
  registerDistributedLeaseGuard,
  acquireDistributedLease,
  renewDistributedLease,
  releaseDistributedLease,
  withDistributedLease,
};
