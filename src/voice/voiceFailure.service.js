import { saveStateDocument } from '../services/stateTransitions/documents.js';
import { upsertVoiceFailureReview } from '../services/stateTransitions/voice.js';
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
    await saveStateDocument(session);

    const businessId = session.business._id || session.business;
    const alert = await upsertVoiceFailureReview({ Alert, businessId, reason, session });

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
