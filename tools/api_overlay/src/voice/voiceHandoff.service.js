import Alert from "../models/alert.js";
import SocketService from "../services/socket.service.js";

class VoiceHandoffService {
  static async request({
    session,
    reason,
    priority = "high",
    alertType = "human_requested",
    customerMessage = "",
  }) {
    session.status = "transferring";
    session.transferredToHuman = true;
    session.transferReason = reason;
    session.lastActivityAt = new Date();
    await session.save();

    if (session.conversation) {
      session.conversation.humanTakeover = true;
      session.conversation.lastMessage = customerMessage || reason;
      session.conversation.lastMessageAt = new Date();
      await session.conversation.save();
      if (typeof SocketService.emitConversationUpdated === "function") {
        SocketService.emitConversationUpdated(
          session.business._id,
          session.conversation,
        );
      }
    }

    const alert = await Alert.findOneAndUpdate(
      {
        business: session.business._id,
        dedupeKey: `voice_handoff:${session._id}:${reason}`,
      },
      {
        $setOnInsert: {
          business: session.business._id,
          lead: session.lead?._id || null,
          conversation: session.conversation?._id || null,
          type: alertType,
          channel: "in_app",
          title:
            priority === "critical"
              ? "Critical voice safety escalation"
              : "Voice caller needs a person",
          message:
            priority === "critical"
              ? "A voice caller reported a possible safety emergency and was routed out of automation."
              : "The voice agent stopped automation and requested a live handoff.",
          status: "pending",
          priority,
          actionRequired: true,
          reason,
          recommendedAction:
            "Answer the transfer or contact the caller immediately.",
          lastCustomerMessage: customerMessage,
          dedupeKey: `voice_handoff:${session._id}:${reason}`,
          metadata: { voiceSessionId: session._id },
        },
      },
      { upsert: true, returnDocument: "after" },
    );
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
