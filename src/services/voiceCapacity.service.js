import VoiceCapacity from "../models/voiceCapacity.js";
import { logOperationalError } from "../helpers/logging/safeLogger.js";
import AlertService from "./alert.service.js";

export const VOICE_CAPACITY_MAX_DURATION_SECONDS = 600;
export const VOICE_CAPACITY_CONFIGURED_MAX_DURATION_SECONDS = 3600;
const VOICE_CAPACITY_LEASE_GRACE_MS = 60_000;

const clamp = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

const getBusinessId = (business) => business?._id || business?.id || business;
const getSessionId = (session) => session?._id || session?.id || null;
const getKey = (session) =>
  String(session?.providerCallSid || getSessionId(session) || "").trim();

const failClosed = () => {
  if (process.env.VOICE_CAPACITY_FAIL_CLOSED === "true") return true;
  if (process.env.VOICE_CAPACITY_FAIL_CLOSED === "false") return false;
  return String(process.env.NODE_ENV || "development").toLowerCase() === "production";
};

const updateCapacity = ({
  businessId,
  key,
  sessionId,
  now,
  expiresAt,
  maximum,
  upsert,
}) =>
  VoiceCapacity.findOneAndUpdate(
    { business: businessId },
    [
      {
        $set: {
          business: businessId,
          leases: {
            $filter: {
              input: { $ifNull: ["$leases", []] },
              as: "lease",
              cond: { $gt: ["$$lease.expiresAt", now] },
            },
          },
        },
      },
      {
        $set: {
          leases: {
            $cond: [
              { $in: [key, "$leases.key"] },
              "$leases",
              {
                $cond: [
                  { $lt: [{ $size: "$leases" }, maximum] },
                  {
                    $concatArrays: [
                      "$leases",
                      [{ key, sessionId, acquiredAt: now, expiresAt }],
                    ],
                  },
                  "$leases",
                ],
              },
            ],
          },
        },
      },
    ],
    { upsert, returnDocument: "after" },
  );

const createVoiceCapacityAlert = async (payload) => {
  try {
    await AlertService.createSystemAlert(payload);
  } catch (error) {
    logOperationalError("voice_capacity.alert_failed", error, {
      businessId: payload.businessId,
      source: payload.metadata?.source,
    });
  }
};

export const resolveVoiceCapacityLimits = ({ business, settings = {} } = {}) => {
  const defaultMaximum = clamp(
    process.env.DEFAULT_VOICE_MAX_CONCURRENT_CALLS,
    25,
    1,
    100,
  );
  const defaultDurationSeconds = clamp(
    process.env.DEFAULT_VOICE_MAX_DURATION_SECONDS,
    VOICE_CAPACITY_MAX_DURATION_SECONDS,
    60,
    VOICE_CAPACITY_CONFIGURED_MAX_DURATION_SECONDS,
  );

  return {
    maximum: clamp(
      settings.maxConcurrentCalls ?? business?.voiceSettings?.maxConcurrentCalls,
      defaultMaximum,
      1,
      100,
    ),
    durationSeconds: clamp(
      settings.maxCallDurationSeconds ??
        business?.voiceSettings?.maxCallDurationSeconds,
      defaultDurationSeconds,
      60,
      VOICE_CAPACITY_CONFIGURED_MAX_DURATION_SECONDS,
    ),
  };
};

export const acquireVoiceCapacity = async ({
  business,
  session,
  settings = {},
}) => {
  const businessId = getBusinessId(business);
  const sessionId = getSessionId(session);
  const key = getKey(session);
  const { maximum, durationSeconds } = resolveVoiceCapacityLimits({
    business,
    settings,
  });

  if (!businessId || !key) {
    return {
      allowed: false,
      reason: "voice_capacity_context_required",
      maximum,
      durationSeconds,
    };
  }

  if (VoiceCapacity.db && VoiceCapacity.db.readyState !== 1) {
    return failClosed()
      ? {
          allowed: false,
          reason: "voice_capacity_unavailable",
          maximum,
          durationSeconds,
        }
      : {
          allowed: true,
          degraded: true,
          reason: "voice_capacity_unavailable",
          maximum,
          durationSeconds,
        };
  }

  const now = new Date();
  // Preserve the configured duration in readiness/capacity reporting for
  // backward compatibility, but never let a crash-orphaned lease survive for
  // more than the hardened ten-minute call ceiling plus the grace period.
  const leaseDurationSeconds = Math.min(
    durationSeconds,
    VOICE_CAPACITY_MAX_DURATION_SECONDS,
  );
  const expiresAt = new Date(
    now.getTime() +
      leaseDurationSeconds * 1000 +
      VOICE_CAPACITY_LEASE_GRACE_MS,
  );

  try {
    let capacity;

    try {
      capacity = await updateCapacity({
        businessId,
        key,
        sessionId,
        now,
        expiresAt,
        maximum,
        upsert: true,
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      capacity = await updateCapacity({
        businessId,
        key,
        sessionId,
        now,
        expiresAt,
        maximum,
        upsert: false,
      });
    }

    const leases = Array.isArray(capacity?.leases) ? capacity.leases : [];
    const allowed = leases.some((lease) => lease.key === key);

    if (!allowed) {
      await createVoiceCapacityAlert({
        businessId,
        title: "Voice AI concurrency allowance reached",
        message: `CallBackIQ prevented a new voice AI session because ${maximum} concurrent session${
          maximum === 1 ? " was" : "s were"
        } already active. The normal configured fallback path was used.`,
        priority: "high",
        metadata: {
          source: "voice_capacity_limit",
          maximum,
          activeCount: leases.length,
        },
        dedupeKey: `voice_capacity:${new Date().toISOString().slice(0, 13)}`,
      });
    } else if (leases.length / maximum >= 0.8) {
      await createVoiceCapacityAlert({
        businessId,
        title: "Voice AI capacity is nearly full",
        message: `${leases.length} of ${maximum} concurrent voice AI slots are currently reserved.`,
        priority: "medium",
        metadata: {
          source: "voice_capacity_threshold",
          maximum,
          activeCount: leases.length,
        },
        dedupeKey: `voice_capacity_threshold:${new Date()
          .toISOString()
          .slice(0, 13)}`,
      });
    }

    return {
      allowed,
      reason: allowed ? "" : "voice_concurrency_limit",
      maximum,
      activeCount: leases.length,
      durationSeconds,
      expiresAt,
    };
  } catch (error) {
    logOperationalError("voice_capacity.acquire_failed", error, { businessId });
    return failClosed()
      ? {
          allowed: false,
          reason: "voice_capacity_unavailable",
          maximum,
          durationSeconds,
        }
      : {
          allowed: true,
          degraded: true,
          reason: "voice_capacity_unavailable",
          maximum,
          durationSeconds,
        };
  }
};

export const releaseVoiceCapacity = async ({ businessId, session }) => {
  const key = getKey(session);

  if (
    !businessId ||
    !key ||
    (VoiceCapacity.db && VoiceCapacity.db.readyState !== 1)
  ) {
    return { released: false, reason: "voice_capacity_unavailable" };
  }

  try {
    const result = await VoiceCapacity.updateOne(
      { business: businessId },
      { $pull: { leases: { key } } },
    );
    return {
      released: Boolean(result?.modifiedCount),
      matchedCount: result?.matchedCount || 0,
    };
  } catch (error) {
    logOperationalError("voice_capacity.release_failed", error, { businessId });
    return { released: false, reason: "voice_capacity_release_failed" };
  }
};

export const sweepExpiredVoiceCapacity = async ({ now = new Date() } = {}) => {
  if (VoiceCapacity.db && VoiceCapacity.db.readyState !== 1) {
    return {
      matchedCount: 0,
      modifiedCount: 0,
      skipped: true,
      reason: "voice_capacity_unavailable",
    };
  }

  try {
    const result = await VoiceCapacity.updateMany(
      { "leases.expiresAt": { $lte: now } },
      { $pull: { leases: { expiresAt: { $lte: now } } } },
    );
    return {
      matchedCount: result?.matchedCount || 0,
      modifiedCount: result?.modifiedCount || 0,
      sweptAt: now,
    };
  } catch (error) {
    logOperationalError("voice_capacity.sweep_failed", error, {});
    throw error;
  }
};

export default {
  acquireVoiceCapacity,
  releaseVoiceCapacity,
  resolveVoiceCapacityLimits,
  sweepExpiredVoiceCapacity,
};
