import VoiceSession from "../models/voiceSession.js";
import {
  logOperationalError,
  logOperationalWarning,
} from "../helpers/logging/safeLogger.js";
import VoiceSessionService, {
  TERMINAL_STATUSES,
} from "./voiceSession.service.js";

const NON_TERMINAL = { $nin: [...TERMINAL_STATUSES] };
const safeInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, parsed))
    : fallback;
};

class VoiceSessionMaintenanceService {
  static async reapStaleSessions({
    staleMinutes = safeInteger(
      process.env.VOICE_STALE_SESSION_MINUTES,
      15,
      5,
      120,
    ),
    limit = 100,
    now = new Date(),
  } = {}) {
    const cutoff = new Date(now.getTime() - staleMinutes * 60_000);
    const sessions = await VoiceSession.find({
      status: NON_TERMINAL,
      lastActivityAt: { $lt: cutoff },
    })
      .sort({ lastActivityAt: 1 })
      .limit(Math.min(1000, Math.max(1, limit)))
      .select("_id status fallbackSmsStatus lastActivityAt providerCallSid");

    const outcome = {
      scanned: sessions.length,
      fallbackAttempted: 0,
      failedClosed: 0,
      errors: 0,
    };

    for (const session of sessions) {
      try {
        if (["pending", "failed"].includes(session.fallbackSmsStatus)) {
          outcome.fallbackAttempted += 1;
          await VoiceSessionService.sendFallbackSms({
            sessionId: session._id,
            failureReason: `Voice session became stale after ${staleMinutes} minutes without activity.`,
          });
          continue;
        }

        const updated = await VoiceSession.findOneAndUpdate(
          { _id: session._id, status: NON_TERMINAL },
          {
            $set: {
              status: "failed",
              endedAt: now,
              lastActivityAt: now,
              failureReason: `Voice session became stale after ${staleMinutes} minutes without activity.`,
              "metadata.reapedAt": now.toISOString(),
              "metadata.reapedFromStatus": session.status,
            },
          },
          { returnDocument: "after" },
        );
        if (updated) outcome.failedClosed += 1;
      } catch (error) {
        outcome.errors += 1;
        logOperationalError("voice.stale_session_reap_failed", error, {
          voiceSessionId: session._id,
          providerCallSid: session.providerCallSid,
        });
      }
    }

    if (outcome.scanned) {
      logOperationalWarning("voice.stale_session_reap_completed", outcome);
    }
    return outcome;
  }

  static async redactExpiredTranscripts({
    retentionDays = safeInteger(
      process.env.VOICE_TRANSCRIPT_RETENTION_DAYS,
      30,
      1,
      365,
    ),
    limit = 500,
    now = new Date(),
  } = {}) {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
    const sessions = await VoiceSession.find({
      status: { $in: [...TERMINAL_STATUSES] },
      endedAt: { $lt: cutoff },
      "metadata.transcriptRedactedAt": { $exists: false },
      $or: [
        { "transcript.0": { $exists: true } },
        { summary: { $nin: ["", null] } },
      ],
    })
      .sort({ endedAt: 1 })
      .limit(Math.min(5000, Math.max(1, limit)))
      .select({ _id: 1 })
      .lean();
    const ids = sessions.map((session) => session._id);

    if (!ids.length) {
      return { retentionDays, matched: 0, modified: 0 };
    }

    const result = await VoiceSession.updateMany(
      { _id: { $in: ids } },
      {
        $set: {
          transcript: [],
          summary: "",
          "metadata.transcriptRedactedAt": now.toISOString(),
          "metadata.transcriptRetentionDays": retentionDays,
        },
      },
    );

    return {
      retentionDays,
      matched: result.matchedCount ?? result.n ?? ids.length,
      modified: result.modifiedCount ?? result.nModified ?? 0,
    };
  }
}

export default VoiceSessionMaintenanceService;
