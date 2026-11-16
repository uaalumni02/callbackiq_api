import { saveStateDocument } from '../services/stateTransitions/documents.js';
import { stageVoiceHandoffPhase, stageVoiceHandoffAcknowledgement, stageVoiceHandoffReason, stageVoiceHandoffTime, upsertVoiceHandoffReview } from '../services/stateTransitions/voice.js';
import { staffReviewDueAt } from "../services/staffReviewPolicy.service.js";
import Alert from "../models/alert.js";
import SocketService from "../services/socket.service.js";
import { assertVoiceTurnActive } from "../services/voiceTurnContext.service.js";
class VoiceHandoffService {
  static async request({
    session,
    reason,
    priority = "high",
    alertType = "human_requested",
    customerMessage = "",
  }) {
    assertVoiceTurnActive();
    session.status = "transferring";
    // Transfer was requested, not yet accepted by staff.
    session.transferredToHuman = false;
    session.transferReason = reason;
    session.metadata = {
      ...(session.metadata || {}),
      voiceHandoffPendingAt: new Date().toISOString(),
    };
    session.lastActivityAt = new Date();
    assertVoiceTurnActive();
    await saveStateDocument(session);
    if (session.conversation) {
      // Do not claim staff ownership until the screened transfer is accepted.
      if (
        session.conversation.humanTakeover !== true &&
        typeof session.conversation.set === "function"
      ) {
        stageVoiceHandoffPhase({ session });
        stageVoiceHandoffAcknowledgement({ session });
        stageVoiceHandoffReason({ reason, session });
        stageVoiceHandoffTime({ session });
      } else if (session.conversation.humanTakeover !== true) {
        session.conversation.orchestration = {
          ...(session.conversation.orchestration || {}),
          phase: "handoff_pending",
          handoffStatus: "pending_ack",
          handoffReason: reason,
          handoffRequestedAt: new Date(),
        };
      }
      session.conversation.lastMessage = customerMessage || reason;
      session.conversation.lastMessageAt = new Date();
      assertVoiceTurnActive();
      await saveStateDocument(session.conversation);
      if (typeof SocketService.emitConversationUpdated === "function") {
        SocketService.emitConversationUpdated(
          session.business._id,
          session.conversation,
        );
      }
    }

    assertVoiceTurnActive();
    const alert = await upsertVoiceHandoffReview({ Alert, alertType, customerMessage, priority, reason, session, staffReviewDueAt });
    if (alert && typeof SocketService.emitAlertCreated === "function") {
      SocketService.emitAlertCreated(session.business._id, alert);
    }
    if (typeof SocketService.emitDashboardRefresh === "function") {
      SocketService.emitDashboardRefresh(
        session.business._id,
        "voice_handoff_requested",
      );
    }

    return {
      type: "end",
      handoffData: JSON.stringify({
        reasonCode: "live-agent-handoff",
        reason,
        voiceSessionId: String(session._id),
      }),
    };
  }
}

export default VoiceHandoffService;
