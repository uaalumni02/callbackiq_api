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
    await session.save();

    if (session.conversation) {
      // Do not claim staff ownership until the screened transfer is accepted.
      if (
        session.conversation.humanTakeover !== true &&
        typeof session.conversation.set === "function"
      ) {
        session.conversation.set("orchestration.phase", "handoff_pending");
        session.conversation.set("orchestration.handoffStatus", "pending_ack");
        session.conversation.set("orchestration.handoffReason", reason);
        session.conversation.set("orchestration.handoffRequestedAt", new Date());
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
      await session.conversation.save();
      if (typeof SocketService.emitConversationUpdated === "function") {
        SocketService.emitConversationUpdated(
          session.business._id,
          session.conversation,
        );
      }
    }

    assertVoiceTurnActive();
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
              ? "A voice caller reported a possible safety emergency. CallBackIQ preserved the context and requested a live handoff without assuming staff accepted it."
              : "The caller requested a person. CallBackIQ requested a screened live handoff and preserved the context; ownership is not assigned until staff accepts.",
          status: "pending",
          priority,
          actionRequired: true,
          dueAt: staffReviewDueAt(priority),
          reason,
          recommendedAction:
            "Accept the screened transfer if available; otherwise review the captured context. Do not assume the caller was promised a callback time.",
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
