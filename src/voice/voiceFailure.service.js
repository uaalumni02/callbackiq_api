import { safeConsole } from "../helpers/logging/safeLogger.js";
import Alert from "../models/alert.js";
import VoiceSession from "../models/voiceSession.js";
import SocketService from "../services/socket.service.js";
import VoiceTranscriptService from "./voiceTranscript.service.js";

const populateSession = (query) =>
  query.populate(["business", "lead", "conversation", "callLog", "appointment"]);

const emit = (method, ...args) => {
  try {
    if (typeof SocketService?.[method] === "function") {
      SocketService[method](...args);
    }
  } catch (error) {
    safeConsole.warn(`Voice failure socket event ${method} failed:`, error.message);
  }
};

class VoiceFailureService {
  /**
   * Persist the failure audit trail without sending SMS or ending a staff
   * transfer. This is used by the staff-then-SMS policy before Twilio dials the
   * business. If that transfer is unanswered, VoiceSessionService later claims
   * and sends the idempotent SMS fallback.
   */
  static async record({ sessionId, failureReason }) {
    const reason = String(failureReason || "Voice AI unavailable").slice(
      0,
      2000,
    );

    const session = await populateSession(VoiceSession.findById(sessionId));
    if (!session?.business) {
      throw new Error("Voice failure audit could not resolve session context.");
    }

    session.failureReason = reason;
    session.lastActivityAt = new Date();
    session.metadata = {
      ...(session.metadata || {}),
      voiceFailureRecordedAt: new Date(),
      voiceFailureRecoveryPending: true,
    };
    await session.save();

    const businessId = session.business._id || session.business;
    const alert = await Alert.findOneAndUpdate(
      {
        business: businessId,
        dedupeKey: `voice_failure:${session._id}`,
      },
      {
        $setOnInsert: {
          business: businessId,
          lead: session.lead?._id || session.lead || null,
          conversation:
            session.conversation?._id || session.conversation || null,
          type: "integration_failure",
          channel: "in_app",
          title: "Voice AI session failed",
          message:
            "The voice session failed. CallBackIQ preserved the partial transcript and started the configured staff-first recovery path.",
          status: "pending",
          priority: "high",
          actionRequired: true,
          reason: reason.slice(0, 1000),
          recommendedAction:
            "Answer the transfer or contact the caller immediately.",
          lastCustomerMessage:
            session.transcript
              ?.filter((entry) => entry.role === "customer")
              .at(-1)?.text || "",
          dedupeKey: `voice_failure:${session._id}`,
          metadata: { voiceSessionId: session._id },
        },
      },
      { upsert: true, returnDocument: "after" },
    );

    if (alert) emit("emitAlertCreated", businessId, alert);
    emit("emitDashboardRefresh", businessId, "voice_session_failed");

    try {
      await VoiceTranscriptService.finalize(session._id);
    } catch (error) {
      safeConsole.error("Voice failure transcript finalization failed:", error);
    }

    return session;
  }
}

export default VoiceFailureService;
