import crypto from "crypto";
import mongoose from "mongoose";

import CommunicationUsageReservation from "../models/communicationUsageReservation.js";
import {
  emitCommunicationUsageThresholdAlerts,
  releaseCommunicationUsage,
  reserveCommunicationUsage,
} from "./communicationUsage.service.js";
import { logOperationalError, logOperationalWarning } from "../helpers/logging/safeLogger.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RELEASE_LEASE_MS = 5 * 60_000;
const pendingLeaseMs = () =>
  Math.max(60_000, Number(process.env.COMMUNICATION_RESERVATION_LEASE_MS) || 15 * 60_000);

const operationKey = (value) =>
  String(value || crypto.randomUUID()).trim().slice(0, 240);

const isTransactionUnsupported = (error) =>
  error?.code === 20 ||
  error?.codeName === "IllegalOperation" ||
  /transaction numbers are only allowed|does not support transactions|replica set/i.test(
    String(error?.message || ""),
  );

export const isUncertainProviderFailure = (error) => {
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();
  const status = Number(error?.status || error?.statusCode || 0);
  if (status >= 500) return true;
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT", "ECONNRESET", "EPIPE", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) {
    return true;
  }
  return !status && /timeout|socket hang up|connection reset|network/i.test(
    String(error?.message || ""),
  );
};

export const findCommunicationOperation = (key) =>
  CommunicationUsageReservation.findOne({ operationKey: operationKey(key) }).lean();

export const reserveCommunicationUsageOperation = async ({
  business,
  customerPhone = "",
  metric = "sms_outbound",
  smsUsageClass = "proactive",
  bypass = false,
  amount = 1,
  key,
  source = "",
  metadata = {},
  now = new Date(),
}) => {
  const resolvedKey = operationKey(key);
  const ownerToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + pendingLeaseMs());
  const purgeAt = new Date(now.getTime() + 30 * DAY_MS);
  const businessId = business?._id || business?.id || business;
  if (!businessId) {
    return {
      allowed: false,
      usage: { allowed: false, reason: "business_context_required", reservations: [] },
      reservation: null,
      replayed: false,
    };
  }

  const execute = async (mongoSession = null) => {
    let existingQuery = CommunicationUsageReservation.findOne({ operationKey: resolvedKey });
    if (mongoSession) existingQuery = existingQuery.session(mongoSession);
    const existing = await existingQuery;
    if (existing && existing.state !== "released") {
      return { allowed: true, usage: null, reservation: existing, replayed: true };
    }

    const usage = await reserveCommunicationUsage({
      business,
      customerPhone,
      metric,
      smsUsageClass,
      bypass,
      amount,
      now,
      mongoSession,
      suppressAlerts: true,
      throwOnInfrastructureError: true,
    });
    if (!usage.allowed) {
      return { allowed: false, usage, reservation: null, replayed: false };
    }

    const pendingFields = {
      business: businessId,
      metric,
      ownerToken,
      amount: Math.max(1, Number(usage.amount || amount) || 1),
      counterIds: usage.reservations.map((item) => item?._id).filter(Boolean),
      state: "pending",
      source,
      metadata,
      providerOperationId: "",
      providerStatus: "",
      providerDispatchStartedAt: null,
      releaseReason: "",
      committedAt: null,
      releasedAt: null,
      leaseExpiresAt,
      purgeAt,
    };

    let reservation;
    if (existing?.state === "released") {
      reservation = await CommunicationUsageReservation.findOneAndUpdate(
        { _id: existing._id, state: "released" },
        { $set: pendingFields },
        {
          returnDocument: "after",
          ...(mongoSession ? { session: mongoSession } : {}),
        },
      );
      if (!reservation) {
        const error = new Error("The SMS operation was claimed concurrently.");
        error.code = "COMMUNICATION_OPERATION_CONFLICT";
        throw error;
      }
    } else {
      const created = await CommunicationUsageReservation.create(
        [{ operationKey: resolvedKey, ...pendingFields }],
        mongoSession ? { session: mongoSession } : undefined,
      );
      reservation = created[0];
    }
    return { allowed: true, usage, reservation, replayed: false };
  };

  const mongoSession = await mongoose.startSession();
  try {
    let result;
    try {
      await mongoSession.withTransaction(async () => {
        result = await execute(mongoSession);
      });
    } catch (error) {
      if (error?.code === 'COMMUNICATION_USAGE_LIMIT' && error.usage) {
        result = { allowed: false, usage: error.usage, reservation: null, replayed: false };
      } else {
        if (Number(error?.code) === 11000 || error?.code === "COMMUNICATION_OPERATION_CONFLICT") {
          const winner = await CommunicationUsageReservation.findOne({ operationKey: resolvedKey });
          return { allowed: true, usage: null, reservation: winner, replayed: true };
        }
        const production =
          String(process.env.NODE_ENV || "development").toLowerCase() === "production";
        if (!isTransactionUnsupported(error) || production) throw error;
        logOperationalWarning("communication_usage.non_transactional_reservation", {
          operationKey: resolvedKey,
          reason: "development_mongo_without_transactions",
        });
        try {
          result = await execute(null);
        } catch (fallbackError) {
          if (
            Number(fallbackError?.code) === 11000 ||
            fallbackError?.code === "COMMUNICATION_OPERATION_CONFLICT"
          ) {
            const winner = await CommunicationUsageReservation.findOne({
              operationKey: resolvedKey,
            });
            return { allowed: true, usage: null, reservation: winner, replayed: true };
          }
          throw fallbackError;
        }
      }
    }
    if (result?.usage?.thresholdAlerts?.length) {
      await emitCommunicationUsageThresholdAlerts({
        businessId,
        thresholdAlerts: result.usage.thresholdAlerts,
        thresholdPercent: result.usage.thresholdPercent,
      });
    }
    return result;
  } finally {
    await mongoSession.endSession();
  }
};

export const beginCommunicationUsageReservation = async ({
  businessId,
  usage,
  key,
  metric = "sms_outbound",
  source = "",
  metadata = {},
  now = new Date(),
}) => {
  if (usage?.bypassed || usage?.degraded || !usage?.reservations?.length) return null;
  const resolvedKey = operationKey(key);
  const ownerToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + pendingLeaseMs());
  const purgeAt = new Date(now.getTime() + 30 * DAY_MS);
  const pendingFields = {
    business: businessId,
    metric,
    ownerToken,
    amount: Math.max(1, Number(usage.amount) || 1),
    counterIds: usage.reservations.map((item) => item?._id).filter(Boolean),
    state: "pending",
    source,
    metadata,
    providerOperationId: "",
    providerStatus: "",
    providerDispatchStartedAt: null,
    releaseReason: "",
    committedAt: null,
    releasedAt: null,
    leaseExpiresAt,
    purgeAt,
  };
  const releaseNewReservation = () =>
    releaseCommunicationUsage({
      reservations: usage.reservations,
      amount: usage.amount,
    });
  try {
    const existing = await CommunicationUsageReservation.findOne({
      operationKey: resolvedKey,
    });
    if (existing) {
      if (existing.state === "released") {
        const reacquired = await CommunicationUsageReservation.findOneAndUpdate(
          { _id: existing._id, state: "released" },
          { $set: pendingFields },
          { returnDocument: "after" },
        );
        if (reacquired?.ownerToken === ownerToken) {
          return { reservation: reacquired, replayed: false, reacquired: true };
        }
      }
      await releaseNewReservation();
      const winner = await CommunicationUsageReservation.findOne({
        operationKey: resolvedKey,
      });
      return { reservation: winner || existing, replayed: true };
    }

    try {
      const reservation = await CommunicationUsageReservation.create({
        operationKey: resolvedKey,
        ...pendingFields,
      });
      return { reservation, replayed: false };
    } catch (error) {
      if (Number(error?.code) !== 11000) throw error;
      await releaseNewReservation();
      const winner = await CommunicationUsageReservation.findOne({
        operationKey: resolvedKey,
      });
      return { reservation: winner, replayed: true };
    }
  } catch (error) {
    if (Number(error?.code) !== 11000) {
      await releaseNewReservation().catch(() => {});
    }
    throw error;
  }
};

export const markCommunicationProviderDispatch = async ({ reservation, from, to, body, now = new Date() }) => {
  if (!reservation?._id || !reservation.ownerToken) {
    throw Object.assign(new Error("A persisted SMS reservation is required before provider dispatch."), {
      code: "SMS_DISPATCH_RESERVATION_REQUIRED", statusCode: 503,
    });
  }
  const claimed = await CommunicationUsageReservation.findOneAndUpdate(
    { _id: reservation._id, ownerToken: reservation.ownerToken, state: "pending",
      providerDispatchStartedAt: null, leaseExpiresAt: { $gt: now } },
    { $set: { providerDispatchStartedAt: now,
      "metadata.providerRequest": { from, to, body } } },
    { returnDocument: "after" },
  );
  if (!claimed) {
    throw Object.assign(new Error("The SMS dispatch reservation is no longer owned by this process."), {
      code: "SMS_DELIVERY_RECONCILIATION_REQUIRED", statusCode: 409, deliveryUncertain: true,
    });
  }
  return claimed;
};

export const commitCommunicationUsageReservation = async ({
  reservation,
  providerOperationId = "",
  providerStatus = "accepted",
}) => {
  if (!reservation?._id) return null;
  const committed = await CommunicationUsageReservation.findOneAndUpdate(
    { _id: reservation._id, state: { $in: ["pending", "uncertain"] },
      ...(reservation.ownerToken ? { ownerToken: reservation.ownerToken } : {}) },
    {
      $set: {
        state: "committed",
        providerOperationId,
        providerStatus,
        committedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 30 * DAY_MS),
      },
    },
    { returnDocument: "after" },
  );
  // A signed delivery callback can persist acceptance before the send call
  // returns. Treat that exact receipt as an idempotent successful commit.
  if (committed || !providerOperationId) return committed;
  return CommunicationUsageReservation.findOne({ _id: reservation._id,
    state: "committed", providerOperationId,
    ...(reservation.ownerToken ? { ownerToken: reservation.ownerToken } : {}) });
};

export const markCommunicationUsageUncertain = async ({ reservation, error, providerOperationId = "", providerStatus = "" }) => {
  if (!reservation?._id) return null;
  logOperationalWarning("communication_usage.delivery_uncertain", {
    reservationId: reservation._id,
    operationKey: reservation.operationKey,
    errorCode: error?.code || error?.name || "error",
  });
  return CommunicationUsageReservation.findOneAndUpdate(
    { _id: reservation._id, state: { $in: ["pending", "uncertain"] },
      ...(reservation.ownerToken ? { ownerToken: reservation.ownerToken } : {}) },
    {
      $set: {
        state: "uncertain",
        ...(providerOperationId ? { providerOperationId, providerStatus } : {}),
        releaseReason: String(error?.code || error?.message || "provider_uncertain").slice(0, 300),
        leaseExpiresAt: new Date(Date.now() + 24 * HOUR_MS),
      },
    },
    { returnDocument: "after" },
  );
};

const releaseClaim = async ({ reservationId, dispatchOwnerToken, reason, now, allowUncertain, providerRejected }) => {
  const ownerToken = crypto.randomUUID();
  const eligibleStates = allowUncertain ? ["pending", "uncertain"] : ["pending"];
  const claimed = await CommunicationUsageReservation.findOneAndUpdate(
    {
      _id: reservationId,
      $or: [
        { state: { $in: eligibleStates },
          ...(dispatchOwnerToken ? { ownerToken: dispatchOwnerToken } : {}),
          ...(!providerRejected && !allowUncertain ? { providerDispatchStartedAt: { $eq: null, $exists: true } } : {}) },
        { state: "releasing", leaseExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        state: "releasing",
        ownerToken,
        releaseReason: String(reason || "released").slice(0, 300),
        leaseExpiresAt: new Date(now.getTime() + RELEASE_LEASE_MS),
      },
    },
    { returnDocument: "after" },
  );
  return claimed ? { claimed, ownerToken } : null;
};

const releaseClaimTransactionally = async ({ claimed, ownerToken, reservations, amount, now }) => {
  const mongoSession = await mongoose.startSession();
  try {
    await mongoSession.withTransaction(async () => {
      const current = await CommunicationUsageReservation.findOne({
        _id: claimed._id,
        state: "releasing",
        ownerToken,
      }).session(mongoSession);
      if (!current) return;
      await releaseCommunicationUsage({
        reservations,
        amount,
        mongoSession,
      });
      await CommunicationUsageReservation.updateOne(
        { _id: current._id, state: "releasing", ownerToken },
        {
          $set: {
            state: "released",
            releasedAt: new Date(),
            leaseExpiresAt: new Date(now.getTime() + 30 * DAY_MS),
          },
        },
        { session: mongoSession },
      );
    });
  } finally {
    await mongoSession.endSession();
  }
};

export const releaseCommunicationUsageReservation = async ({
  reservation,
  usage,
  reason = "provider_rejected",
  allowUncertain = false,
  providerRejected = false,
  now = new Date(),
}) => {
  if (!reservation?._id) {
    if (usage?.reservations?.length) {
      await releaseCommunicationUsage({
        reservations: usage.reservations,
        amount: usage.amount,
      });
    }
    return null;
  }
  if (["committed", "released"].includes(reservation.state)) return reservation;
  const claim = await releaseClaim({
    reservationId: reservation._id,
    dispatchOwnerToken: reservation.ownerToken,
    reason,
    now,
    allowUncertain,
    providerRejected,
  });
  if (!claim) return CommunicationUsageReservation.findById(reservation._id);
  const reservations = usage?.reservations?.length
    ? usage.reservations
    : claim.claimed.counterIds || [];
  const amount = usage?.amount || claim.claimed.amount || 1;
  try {
    await releaseClaimTransactionally({
      claimed: claim.claimed,
      ownerToken: claim.ownerToken,
      reservations,
      amount,
      now,
    });
  } catch (error) {
    const production =
      String(process.env.NODE_ENV || "development").toLowerCase() === "production";
    if (isTransactionUnsupported(error) && !production) {
      logOperationalWarning("communication_usage.non_transactional_release", {
        reservationId: reservation._id,
        reason: "development_mongo_without_transactions",
      });
      await releaseCommunicationUsage({ reservations, amount });
      return CommunicationUsageReservation.findOneAndUpdate(
        {
          _id: reservation._id,
          state: "releasing",
          ownerToken: claim.ownerToken,
        },
        {
          $set: {
            state: "released",
            releasedAt: new Date(),
            leaseExpiresAt: new Date(now.getTime() + 30 * DAY_MS),
          },
        },
        { returnDocument: "after" },
      );
    }
    if (isTransactionUnsupported(error)) {
      logOperationalError("communication_usage.release_requires_replica_set", error, {
        reservationId: reservation._id,
      });
    }
    await CommunicationUsageReservation.updateOne(
      { _id: reservation._id, state: "releasing", ownerToken: claim.ownerToken },
      { $set: { leaseExpiresAt: new Date(Date.now() + RELEASE_LEASE_MS) } },
    ).catch(() => {});
    throw error;
  }
  return CommunicationUsageReservation.findById(reservation._id);
};

export const sweepExpiredCommunicationReservations = async ({ now = new Date(), limit = 500 } = {}) => {
  const expiredIds = await CommunicationUsageReservation.find({
    state: { $in: ["pending", "releasing"] },
    leaseExpiresAt: { $lte: now },
  })
    .sort({ leaseExpiresAt: 1 })
    .limit(Math.max(1, Math.min(5000, Number(limit) || 500)))
    .select("_id state ownerToken operationKey providerDispatchStartedAt")
    .lean();
  let released = 0;
  for (const item of expiredIds) {
    try {
      if (item.state === "pending" && item.providerDispatchStartedAt !== null) {
        await markCommunicationUsageUncertain({ reservation: item,
          error: { code: "SMS_DISPATCH_INTERRUPTED" } });
        continue;
      }
      const result = await releaseCommunicationUsageReservation({
        reservation: { _id: item._id },
        reason: "expired_before_provider_acceptance",
        now,
      });
      if (result?.state === "released") released += 1;
    } catch (error) {
      logOperationalError("communication_usage.expired_release_failed", error, {
        reservationId: item._id,
      });
    }
  }
  return { inspected: expiredIds.length, released };
};

export default {
  beginCommunicationUsageReservation,
  reserveCommunicationUsageOperation,
  commitCommunicationUsageReservation,
  markCommunicationProviderDispatch,
  findCommunicationOperation,
  isUncertainProviderFailure,
  markCommunicationUsageUncertain,
  releaseCommunicationUsageReservation,
  sweepExpiredCommunicationReservations,
};
