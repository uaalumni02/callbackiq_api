import crypto from "crypto";
import mongoose from "mongoose";

import VoiceUsageLedger from "../models/voiceUsageLedger.js";
import VoiceUsageReservation from "../models/voiceUsageReservation.js";
import VoiceUsageReconciliation from "../models/voiceUsageReconciliation.js";
import AlertService from "./alert.service.js";
import {
  logOperationalError,
  logOperationalWarning,
} from "../helpers/logging/safeLogger.js";

const DAY_SECONDS = 24 * 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const RESERVATION_LEASE_MS = Math.max(
  60_000,
  Number(process.env.VOICE_USAGE_RESERVATION_LEASE_MS) || 20 * 60_000,
);
const RECONCILIATION_LEASE_MS = Math.max(
  60_000,
  Number(process.env.VOICE_USAGE_RECONCILIATION_LEASE_MS) || 5 * 60_000,
);

const isTransactionUnsupported = (error) =>
  error?.code === 20 ||
  error?.codeName === "IllegalOperation" ||
  /transaction numbers are only allowed|does not support transactions|replica set/i.test(
    String(error?.message || ""),
  );

const clamp = (value, fallback, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const utcKey = (date, type) => {
  const iso = new Date(date).toISOString();
  return type === "month" ? iso.slice(0, 7) : iso.slice(0, 10);
};

const validObjectIdOrNull = (value) =>
  mongoose.isValidObjectId(value) ? value : null;

const limitsFor = (business = {}) => {
  const settings = business.voiceSettings || {};
  const limits = {
    dailySeconds: Math.round(
      clamp(settings.dailyVoiceMinutes, 240, 1, 100000) * 60,
    ),
    monthlySeconds: Math.round(
      clamp(settings.monthlyVoiceMinutes, 4000, 1, 1000000) * 60,
    ),
    hardCapEnabled: settings.voiceHardCapEnabled !== false,
    overageEnabled: settings.voiceOverageEnabled === true,
    warningThresholds: Array.isArray(settings.voiceUsageWarningThresholds)
      ? settings.voiceUsageWarningThresholds
      : [70, 85, 100],
  };

  if (business?.trialCostControls?.enabled === true) {
    const trialDailySeconds =
      clamp(process.env.TRIAL_VOICE_DAILY_MINUTES, 30, 1, 1440) * 60;
    const trialMonthlySeconds =
      clamp(process.env.TRIAL_VOICE_MONTHLY_MINUTES, 300, 1, 10000) * 60;
    limits.dailySeconds = Math.min(limits.dailySeconds, trialDailySeconds);
    limits.monthlySeconds = Math.min(
      limits.monthlySeconds,
      trialMonthlySeconds,
    );
    limits.hardCapEnabled = true;
    limits.overageEnabled = false;
  }

  return limits;
};

const ensureLedger = ({ businessId, type, now, mongoSession = null }) =>
  VoiceUsageLedger.findOneAndUpdate(
    { business: businessId, periodType: type, periodKey: utcKey(now, type) },
    {
      $setOnInsert: {
        business: businessId,
        periodType: type,
        periodKey: utcKey(now, type),
      },
    },
    {
      upsert: true,
      returnDocument: "after",
      setDefaultsOnInsert: true,
      ...(mongoSession ? { session: mongoSession } : {}),
    },
  );

const usedSeconds = (ledger) =>
  Number(ledger?.completedSeconds || 0) + Number(ledger?.reservedSeconds || 0);

const reserveLedger = async ({
  ledger,
  requested,
  limitSeconds,
  enforceLimit,
  sessionId,
  mongoSession = null,
}) => {
  const query = { _id: ledger._id };
  if (enforceLimit) {
    query.$expr = {
      $lte: [
        {
          $add: [
            { $ifNull: ["$completedSeconds", 0] },
            { $ifNull: ["$reservedSeconds", 0] },
            requested,
          ],
        },
        limitSeconds,
      ],
    };
  }
  return VoiceUsageLedger.findOneAndUpdate(
    query,
    {
      $inc: { reservedSeconds: requested },
      $set: { lastSession: validObjectIdOrNull(sessionId) },
    },
    {
      returnDocument: "after",
      ...(mongoSession ? { session: mongoSession } : {}),
    },
  );
};

const releaseLedgerReservation = async ({
  businessId,
  periodType,
  periodKey,
  seconds,
  mongoSession = null,
}) => {
  const amount = Math.max(0, Number(seconds) || 0);
  if (!amount) return;
  await VoiceUsageLedger.updateOne(
    { business: businessId, periodType, periodKey },
    [
      {
        $set: {
          reservedSeconds: {
            $max: [0, { $subtract: [{ $ifNull: ["$reservedSeconds", 0] }, amount] }],
          },
        },
      },
    ],
    {
      ...(mongoSession ? { session: mongoSession } : {}),
      updatePipeline: true,
    },
  );
};

const maybeAlert = async ({ businessId, ledger, limitSeconds, thresholds }) => {
  if (!limitSeconds || !ledger) return;
  const percent = Math.floor((usedSeconds(ledger) / limitSeconds) * 100);
  const crossed = thresholds
    .map(Number)
    .filter(Number.isFinite)
    .filter((threshold) => percent >= threshold)
    .sort((a, b) => a - b);
  for (const threshold of crossed) {
    if (ledger.thresholdAlertsSent?.includes(threshold)) continue;
    try {
      await AlertService.createSystemAlert({
        businessId,
        title: `Voice usage reached ${threshold}%`,
        message:
          threshold >= 100
            ? "The voice allowance is exhausted. New AI calls will use the configured callback fallback unless overages are enabled."
            : `Voice usage has reached ${percent}% of the ${ledger.periodType} allowance.`,
        priority: threshold >= 100 ? "high" : "medium",
        metadata: {
          source: "voice_usage_threshold",
          periodType: ledger.periodType,
          periodKey: ledger.periodKey,
          threshold,
          percent,
        },
        dedupeKey: `voice_usage:${ledger.periodType}:${ledger.periodKey}:${threshold}`,
      });
      await VoiceUsageLedger.updateOne(
        { _id: ledger._id },
        { $addToSet: { thresholdAlertsSent: threshold } },
      );
    } catch (error) {
      logOperationalError("voice_usage.threshold_alert_failed", error, {
        businessId,
        periodType: ledger.periodType,
        threshold,
      });
    }
  }
};

const buildReservationKey = ({ businessId, sessionId, reservationKey }) =>
  String(
    reservationKey ||
      `voice:${businessId}:${sessionId || "unknown"}:${crypto.randomUUID()}`,
  )
    .trim()
    .slice(0, 220);

export const reserveVoiceUsage = async ({
  business,
  sessionId,
  reserveSeconds = 60,
  reservationKey = "",
  ownerToken = "",
  now = new Date(),
}) => {
  const businessId = business?._id || business?.id || business;
  const normalizedSessionId = validObjectIdOrNull(sessionId);
  if (!businessId) {
    return { allowed: false, reason: "voice_usage_business_required" };
  }
  if (!normalizedSessionId) {
    return { allowed: false, reason: "voice_usage_session_required" };
  }

  const requested = Math.round(clamp(reserveSeconds, 60, 15, DAY_SECONDS));
  const key = buildReservationKey({ businessId, sessionId, reservationKey });
  const existing = await VoiceUsageReservation.findOne({ reservationKey: key });
  if (existing) {
    if (["active", "committed"].includes(existing.state)) {
      return {
        allowed: true,
        replayed: true,
        reservationId: existing._id,
        reservationKey: existing.reservationKey,
        reservedSeconds: existing.requestedSeconds,
      };
    }
    return {
      allowed: false,
      replayed: true,
      reason:
        existing.state === "rejected"
          ? existing.releaseReason || "voice_allowance_exhausted"
          : "voice_usage_reservation_released",
    };
  }

  const limits = limitsFor(business);
  const leaseExpiresAt = new Date(now.getTime() + RESERVATION_LEASE_MS);
  const purgeAt = new Date(now.getTime() + 90 * DAY_MS);
  let reservation;
  try {
    reservation = await VoiceUsageReservation.create({
      business: businessId,
      session: normalizedSessionId,
      reservationKey: key,
      requestedSeconds: requested,
      state: "preparing",
      dayPeriodKey: utcKey(now, "day"),
      monthPeriodKey: utcKey(now, "month"),
      reservedPeriodTypes: [],
      ownerToken: String(ownerToken || "").slice(0, 160),
      leaseExpiresAt,
      purgeAt,
    });
  } catch (error) {
    if (error?.code === 11000) {
      return reserveVoiceUsage({
        business,
        sessionId,
        reserveSeconds,
        reservationKey: key,
        ownerToken,
        now,
      });
    }
    throw error;
  }

  const enforce = limits.hardCapEnabled && !limits.overageEnabled;
  const mongoSession = await mongoose.startSession();
  let reservedDaily = null;
  let reservedMonthly = null;
  let rejectionReason = "";
  try {
    await mongoSession.withTransaction(async () => {
      /*
       * MongoDB does not support parallel operations on the same
       * transaction session. Keep ledger initialization sequential
       * while preserving transaction atomicity.
       */
      const daily = await ensureLedger({
        businessId,
        type: "day",
        now,
        mongoSession,
      });

      const monthly = await ensureLedger({
        businessId,
        type: "month",
        now,
        mongoSession,
      });
      reservedDaily = await reserveLedger({
        ledger: daily,
        requested,
        limitSeconds: limits.dailySeconds,
        enforceLimit: enforce,
        sessionId,
        mongoSession,
      });
      if (!reservedDaily) {
        rejectionReason = "daily_voice_allowance_exhausted";
        const error = new Error(rejectionReason);
        error.code = "VOICE_USAGE_LIMIT_REACHED";
        throw error;
      }
      reservedMonthly = await reserveLedger({
        ledger: monthly,
        requested,
        limitSeconds: limits.monthlySeconds,
        enforceLimit: enforce,
        sessionId,
        mongoSession,
      });
      if (!reservedMonthly) {
        rejectionReason = "monthly_voice_allowance_exhausted";
        const error = new Error(rejectionReason);
        error.code = "VOICE_USAGE_LIMIT_REACHED";
        throw error;
      }
      await VoiceUsageReservation.updateOne(
        { _id: reservation._id, state: "preparing" },
        {
          $set: {
            state: "active",
            reservedPeriodTypes: ["day", "month"],
            leaseExpiresAt,
          },
        },
        { session: mongoSession },
      );
    });
  } catch (error) {
    const reason =
      error?.code === "VOICE_USAGE_LIMIT_REACHED"
        ? rejectionReason || "voice_allowance_exhausted"
        : "voice_usage_atomic_reservation_unavailable";
    await VoiceUsageReservation.updateOne(
      { _id: reservation._id, state: "preparing" },
      {
        $set: {
          state: "rejected",
          releaseReason: reason,
          releasedAt: new Date(),
          leaseExpiresAt: new Date(now.getTime() + 90 * DAY_MS),
        },
      },
    ).catch(() => {});
    if (error?.code !== "VOICE_USAGE_LIMIT_REACHED") {
      logOperationalError("voice_usage.atomic_reservation_failed", error, {
        businessId,
        sessionId,
        reservationKey: key,
      });
    } else {
      await VoiceUsageLedger.updateMany(
        {
          business: businessId,
          $or: [
            { periodType: "day", periodKey: utcKey(now, "day") },
            { periodType: "month", periodKey: utcKey(now, "month") },
          ],
        },
        { $inc: { rejectedCalls: 1 }, $set: { lastSession: normalizedSessionId } },
      ).catch(() => {});
    }
    return { allowed: false, reason };
  } finally {
    await mongoSession.endSession();
  }

  reservation = await VoiceUsageReservation.findById(reservation._id);
  await Promise.all([
    maybeAlert({
      businessId,
      ledger: reservedDaily,
      limitSeconds: limits.dailySeconds,
      thresholds: limits.warningThresholds,
    }),
    maybeAlert({
      businessId,
      ledger: reservedMonthly,
      limitSeconds: limits.monthlySeconds,
      thresholds: limits.warningThresholds,
    }),
  ]);

  return {
    allowed: true,
    reservationId: reservation._id,
    reservationKey: reservation.reservationKey,
    reservedSeconds: requested,
  };
};

const executeReconciliationTransaction = async ({
  businessId,
  sessionId,
  actualSeconds,
  openAiInputTokens,
  openAiOutputTokens,
  twilioEstimatedCostCents,
  openAiEstimatedCostCents,
  transferAttempts,
  now,
  reconciliation,
}) => {
  const mongoSession = await mongoose.startSession();
  let releasedSeconds = 0;
  try {
    await mongoSession.withTransaction(async () => {
      const reservations = await VoiceUsageReservation.find({
        business: businessId,
        session: sessionId,
        state: { $in: ["preparing", "active"] },
      }).session(mongoSession);

      for (const reservation of reservations) {
        if (reservation.reservedPeriodTypes.includes("day")) {
          await releaseLedgerReservation({
            businessId,
            periodType: "day",
            periodKey: reservation.dayPeriodKey,
            seconds: reservation.requestedSeconds,
            mongoSession,
          });
        }
        if (reservation.reservedPeriodTypes.includes("month")) {
          await releaseLedgerReservation({
            businessId,
            periodType: "month",
            periodKey: reservation.monthPeriodKey,
            seconds: reservation.requestedSeconds,
            mongoSession,
          });
        }
        releasedSeconds += reservation.requestedSeconds;
      }

      /*
       * Never run concurrent operations with the same MongoDB
       * transaction session.
       */
      const dayLedger = await ensureLedger({
        businessId,
        type: "day",
        now,
        mongoSession,
      });

      const monthLedger = await ensureLedger({
        businessId,
        type: "month",
        now,
        mongoSession,
      });
      const metrics = {
        completedSeconds: Math.max(0, Number(actualSeconds) || 0),
        openAiInputTokens: Math.max(0, Number(openAiInputTokens) || 0),
        openAiOutputTokens: Math.max(0, Number(openAiOutputTokens) || 0),
        twilioEstimatedCostCents: Math.max(
          0,
          Number(twilioEstimatedCostCents) || 0,
        ),
        openAiEstimatedCostCents: Math.max(
          0,
          Number(openAiEstimatedCostCents) || 0,
        ),
        transferAttempts: Math.max(0, Number(transferAttempts) || 0),
      };
      await VoiceUsageLedger.updateMany(
        { _id: { $in: [dayLedger._id, monthLedger._id] } },
        {
          $inc: metrics,
          $set: { lastSession: validObjectIdOrNull(sessionId) },
        },
        { session: mongoSession },
      );
      await VoiceUsageReservation.updateMany(
        { _id: { $in: reservations.map((item) => item._id) } },
        {
          $set: {
            state: "committed",
            actualSeconds: Math.max(0, Number(actualSeconds) || 0),
            committedAt: new Date(),
            leaseExpiresAt: new Date(now.getTime() + 90 * DAY_MS),
          },
        },
        { session: mongoSession },
      );
      await VoiceUsageReconciliation.updateOne(
        { _id: reconciliation._id, ownerToken: reconciliation.ownerToken },
        {
          $set: {
            state: "completed",
            actualSeconds: Math.max(0, Number(actualSeconds) || 0),
            reservedSecondsReleased: releasedSeconds,
            completedAt: new Date(),
            failureCode: "",
            failureMessage: "",
            leaseExpiresAt: new Date(now.getTime() + 90 * DAY_MS),
          },
        },
        { session: mongoSession },
      );
    });
    return releasedSeconds;
  } finally {
    await mongoSession.endSession();
  }
};

export const enqueueVoiceUsageReconciliation = async ({
  businessId,
  sessionId,
  actualSeconds = 0,
  openAiInputTokens = 0,
  openAiOutputTokens = 0,
  twilioEstimatedCostCents = 0,
  openAiEstimatedCostCents = 0,
  transferAttempts = 0,
  now = new Date(),
}) => {
  const normalizedSessionId = validObjectIdOrNull(sessionId);

  if (!businessId || !normalizedSessionId) {
    return { queued: false, reason: "voice_usage_reconciliation_context_required" };
  }

  const purgeAt = new Date(now.getTime() + 90 * DAY_MS);

  try {
    const reconciliation = await VoiceUsageReconciliation.findOneAndUpdate(
      { session: normalizedSessionId },
      {
        $setOnInsert: {
          business: businessId,
          session: normalizedSessionId,
          state: "pending",
          ownerToken: "pending",
          leaseExpiresAt: now,
          queuedAt: now,
          actualSeconds: Math.max(0, Number(actualSeconds) || 0),
          openAiInputTokens: Math.max(0, Number(openAiInputTokens) || 0),
          openAiOutputTokens: Math.max(0, Number(openAiOutputTokens) || 0),
          twilioEstimatedCostCents: Math.max(
            0,
            Number(twilioEstimatedCostCents) || 0,
          ),
          openAiEstimatedCostCents: Math.max(
            0,
            Number(openAiEstimatedCostCents) || 0,
          ),
          transferAttempts: Math.max(0, Number(transferAttempts) || 0),
          purgeAt,
        },
      },
      {
        upsert: true,
        returnDocument: "after",
        setDefaultsOnInsert: true,
      },
    );

    return {
      queued: reconciliation?.state !== "completed",
      completed: reconciliation?.state === "completed",
      reconciliationId: reconciliation?._id || null,
      state: reconciliation?.state || "",
    };
  } catch (error) {
    if (error?.code === 11000) {
      const existing = await VoiceUsageReconciliation.findOne({
        session: normalizedSessionId,
      }).lean();

      return {
        queued: existing?.state !== "completed",
        completed: existing?.state === "completed",
        replayed: true,
        reconciliationId: existing?._id || null,
        state: existing?.state || "",
      };
    }

    throw error;
  }
};

export const listVoiceUsageReconciliationCandidates = async ({
  now = new Date(),
  limit = 25,
} = {}) =>
  VoiceUsageReconciliation.find({
    $or: [
      { state: "pending" },
      { state: "failed", leaseExpiresAt: { $lte: now } },
      { state: "processing", leaseExpiresAt: { $lte: now } },
    ],
  })
    .sort({ queuedAt: 1, createdAt: 1 })
    .limit(Math.max(1, Math.min(500, Number(limit) || 25)))
    .lean();

export const reconcileVoiceUsage = async ({
  businessId,
  sessionId,
  reservedSeconds: legacyReservedSeconds = 0,
  actualSeconds = 0,
  openAiInputTokens = 0,
  openAiOutputTokens = 0,
  twilioEstimatedCostCents = 0,
  openAiEstimatedCostCents = 0,
  transferAttempts = 0,
  now = new Date(),
}) => {
  const normalizedSessionId = validObjectIdOrNull(sessionId);
  if (!businessId || !normalizedSessionId) return { reconciled: false };
  const ownerToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + RECONCILIATION_LEASE_MS);
  const purgeAt = new Date(now.getTime() + 90 * DAY_MS);
  let reconciliation;
  try {
    reconciliation = await VoiceUsageReconciliation.findOneAndUpdate(
      {
        session: normalizedSessionId,
        $or: [
          { state: "pending" },
          { state: "failed" },
          { state: "processing", leaseExpiresAt: { $lte: now } },
        ],
      },
      {
        $setOnInsert: {
          business: businessId,
          session: normalizedSessionId,
          purgeAt,
        },
        $set: {
          state: "processing",
          ownerToken,
          leaseExpiresAt,
          failureCode: "",
          failureMessage: "",
          lastAttemptAt: now,
        },
        $inc: {
          attemptCount: 1,
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    );
  } catch (error) {
    if (error?.code === 11000) {
      const existing = await VoiceUsageReconciliation.findOne({
        session: normalizedSessionId,
      }).lean();
      return {
        reconciled: existing?.state === "completed",
        pending: existing?.state !== "completed",
        replayed: true,
      };
    }
    throw error;
  }
  if (!reconciliation || reconciliation.ownerToken !== ownerToken) {
    return {
      reconciled: reconciliation?.state === "completed",
      pending: reconciliation?.state !== "completed",
      replayed: true,
    };
  }

  try {
    const releasedSeconds = await executeReconciliationTransaction({
      businessId,
      sessionId: normalizedSessionId,
      actualSeconds,
      openAiInputTokens,
      openAiOutputTokens,
      twilioEstimatedCostCents,
      openAiEstimatedCostCents,
      transferAttempts,
      now,
      reconciliation,
    });
    return { reconciled: true, releasedSeconds };
  } catch (error) {
    await VoiceUsageReconciliation.updateOne(
      { _id: reconciliation._id, ownerToken },
      {
        $set: {
          state: "failed",
          failureCode: String(error?.code || error?.name || "voice_usage_error").slice(
            0,
            160,
          ),
          failureMessage: String(error?.message || error).slice(0, 1000),
          leaseExpiresAt: new Date(Date.now() + RECONCILIATION_LEASE_MS),
        },
      },
    ).catch(() => {});
    logOperationalError("voice_usage.reconciliation_failed", error, {
      businessId,
      sessionId,
      legacyReservedSeconds,
    });
    throw error;
  }
};

export const releaseVoiceUsageReservation = async ({
  reservationId,
  now = new Date(),
  reason = "reservation_lease_expired",
} = {}) => {
  if (!reservationId) return null;
  const ownerToken = crypto.randomUUID();
  const releaseLeaseExpiresAt = new Date(now.getTime() + RECONCILIATION_LEASE_MS);
  const claimed = await VoiceUsageReservation.findOneAndUpdate(
    {
      _id: reservationId,
      $or: [
        {
          state: { $in: ["preparing", "active"] },
          leaseExpiresAt: { $lte: now },
        },
        { state: "releasing", leaseExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        state: "releasing",
        ownerToken,
        releaseReason: String(reason || "released").slice(0, 300),
        leaseExpiresAt: releaseLeaseExpiresAt,
      },
    },
    { returnDocument: "after" },
  );
  if (!claimed) return VoiceUsageReservation.findById(reservationId);

  const releaseWithoutTransaction = async () => {
    if (claimed.reservedPeriodTypes.includes("day")) {
      await releaseLedgerReservation({
        businessId: claimed.business,
        periodType: "day",
        periodKey: claimed.dayPeriodKey,
        seconds: claimed.requestedSeconds,
      });
    }
    if (claimed.reservedPeriodTypes.includes("month")) {
      await releaseLedgerReservation({
        businessId: claimed.business,
        periodType: "month",
        periodKey: claimed.monthPeriodKey,
        seconds: claimed.requestedSeconds,
      });
    }
    return VoiceUsageReservation.findOneAndUpdate(
      { _id: claimed._id, state: "releasing", ownerToken },
      {
        $set: {
          state: "released",
          releasedAt: new Date(),
          leaseExpiresAt: new Date(now.getTime() + 90 * DAY_MS),
        },
      },
      { returnDocument: "after" },
    );
  };

  const mongoSession = await mongoose.startSession();
  try {
    try {
      await mongoSession.withTransaction(async () => {
        const current = await VoiceUsageReservation.findOne({
          _id: claimed._id,
          state: "releasing",
          ownerToken,
        }).session(mongoSession);
        if (!current) return;
        if (current.reservedPeriodTypes.includes("day")) {
          await releaseLedgerReservation({
            businessId: current.business,
            periodType: "day",
            periodKey: current.dayPeriodKey,
            seconds: current.requestedSeconds,
            mongoSession,
          });
        }
        if (current.reservedPeriodTypes.includes("month")) {
          await releaseLedgerReservation({
            businessId: current.business,
            periodType: "month",
            periodKey: current.monthPeriodKey,
            seconds: current.requestedSeconds,
            mongoSession,
          });
        }
        await VoiceUsageReservation.updateOne(
          { _id: current._id, state: "releasing", ownerToken },
          {
            $set: {
              state: "released",
              releasedAt: new Date(),
              leaseExpiresAt: new Date(now.getTime() + 90 * DAY_MS),
            },
          },
          { session: mongoSession },
        );
      });
    } catch (error) {
      if (
        !isTransactionUnsupported(error) ||
        String(process.env.NODE_ENV || "development").toLowerCase() === "production"
      ) {
        throw error;
      }
      logOperationalWarning("voice_usage.non_transactional_release", {
        reservationId: claimed._id,
        reason: "development_mongo_without_transactions",
      });
      return releaseWithoutTransaction();
    }
  } catch (error) {
    await VoiceUsageReservation.updateOne(
      { _id: claimed._id, state: "releasing", ownerToken },
      { $set: { leaseExpiresAt: new Date(Date.now() + RECONCILIATION_LEASE_MS) } },
    ).catch(() => {});
    throw error;
  } finally {
    await mongoSession.endSession();
  }
  return VoiceUsageReservation.findById(claimed._id);
};

export const sweepExpiredVoiceUsageReservations = async ({
  now = new Date(),
  limit = 500,
} = {}) => {
  const expired = await VoiceUsageReservation.find({
    state: { $in: ["preparing", "active", "releasing"] },
    leaseExpiresAt: { $lte: now },
  })
    .sort({ leaseExpiresAt: 1 })
    .limit(Math.max(1, Math.min(5000, Number(limit) || 500)))
    .select("_id")
    .lean();
  let released = 0;
  for (const reservation of expired) {
    try {
      const result = await releaseVoiceUsageReservation({
        reservationId: reservation._id,
        now,
      });
      if (result?.state === "released") released += 1;
    } catch (error) {
      logOperationalError("voice_usage.expired_reservation_release_failed", error, {
        reservationId: reservation._id,
      });
    }
  }
  return { inspected: expired.length, released };
};

export const getVoiceUsageSummary = async ({ businessId, now = new Date() }) => {
  const [ledgers, pendingReservations] = await Promise.all([
    VoiceUsageLedger.find({
      business: businessId,
      $or: [
        { periodType: "day", periodKey: utcKey(now, "day") },
        { periodType: "month", periodKey: utcKey(now, "month") },
      ],
    }).lean(),
    VoiceUsageReservation.countDocuments({
      business: businessId,
      state: { $in: ["preparing", "active"] },
    }),
  ]);
  return {
    day: ledgers.find((item) => item.periodType === "day") || null,
    month: ledgers.find((item) => item.periodType === "month") || null,
    pendingReservations,
  };
};

export default {
  reserveVoiceUsage,
  enqueueVoiceUsageReconciliation,
  listVoiceUsageReconciliationCandidates,
  reconcileVoiceUsage,
  releaseVoiceUsageReservation,
  sweepExpiredVoiceUsageReservations,
  getVoiceUsageSummary,
};
