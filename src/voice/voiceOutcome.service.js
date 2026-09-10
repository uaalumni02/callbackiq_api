import { recordCallAnswer } from "../services/callAnswerEvidence.service.js";
import AlertService from "../services/alert.service.js";
import VoiceSession from "../models/voiceSession.js";
import Conversation from "../models/conversation.js";
import VoiceSessionService from "./voiceSession.service.js";
import SocketService from "../services/socket.service.js";
import { logOperationalError } from "../helpers/logging/safeLogger.js";

export const VOICE_OUTCOMES = Object.freeze([
  "booked",
  "callback_saved",
  "transfer_accepted",
  "direct_answer_resolved",
  "safety_escalated",
  "wrong_number",
  "caller_declined",
  "opted_out",
  "abandoned",
  "technical_failure",
]);

const OUTCOME_SET = new Set(VOICE_OUTCOMES);
const normalizeId = (value) => value?._id || value?.id || value || null;
const clean = (value, max = 500) =>
  String(value || "").trim().slice(0, max);

export const hasCommittedVoiceOutcome = (session) =>
  Boolean(session?.outcome && OUTCOME_SET.has(session.outcome));

export const inferVoiceOutcome = (session) => {
  if (hasCommittedVoiceOutcome(session)) return session.outcome;
  if (session?.appointment || session?.metadata?.bookingCompletedAt) {
    return "booked";
  }
  const callback = session?.metadata?.callbackCapture;
  if (callback?.completedAt || callback?.status === "completed") {
    return String(callback?.reason || "").startsWith("safety_emergency") ||
      callback?.priority === "critical"
      ? "safety_escalated"
      : "callback_saved";
  }
  if (
    session?.transferredToHuman &&
    (session?.metadata?.staffScreenAccepted ||
      session?.metadata?.transferCompleted)
  ) {
    return "transfer_accepted";
  }
  if (session?.metadata?.directAnswerResolvedAt) {
    return "direct_answer_resolved";
  }
  return "";
};

export const commitVoiceOutcome = async ({
  sessionId,
  outcome,
  metadata = {},
  status,
  now = new Date(),
}) => {
  if (!sessionId || !OUTCOME_SET.has(outcome)) {
    return { committed: false, reason: "invalid_outcome" };
  }
  const set = {
    outcome,
    outcomeCommittedAt: now,
    "metadata.outcome": {
      outcome,
      committedAt: now.toISOString(),
      ...metadata,
    },
  };
  if (status) set.status = status;
  if (status === "completed") set.endedAt = now;
  if (outcome === "transfer_accepted") set.transferredToHuman = true;

  const session = await VoiceSession.findOneAndUpdate(
    {
      _id: sessionId,
      $or: [
        { outcome: { $exists: false } },
        { outcome: null },
        { outcome: "" },
        { outcome },
      ],
    },
    { $set: set },
    { returnDocument: "after" },
  );

  if (session && outcome === "transfer_accepted") {
    await recordCallAnswer({ businessId: normalizeId(session.business), callLogId: normalizeId(session.callLog), answeredBy: 'business', now });
  }

  if (session && outcome === "transfer_accepted" && session.conversation) {
    const conversationId = normalizeId(session.conversation);
    const claimedConversation = await Conversation.findByIdAndUpdate(
      conversationId,
      {
        $set: {
          aiEnabled: false,
          humanTakeover: true,
          humanTakeoverAt: now,
          humanTakeoverBy: null,
          "bookingState.status": "human_takeover",
          "orchestration.phase": "human_takeover",
          "orchestration.handoffStatus": "acknowledged",
          "orchestration.handoffAcknowledgedAt": now,
        },
      },
      { returnDocument: "after" },
    );
    if (
      claimedConversation &&
      typeof SocketService.emitConversationUpdated === "function"
    ) {
      SocketService.emitConversationUpdated(
        normalizeId(session.business),
        claimedConversation,
      );
    }
  }

  return { committed: Boolean(session), session };
};

export const recoverAbandonedVoiceCall = async ({
  sessionId,
  closeCode = 1000,
  closeReason = "",
  now = new Date(),
}) => {
  if (!sessionId) return { recovered: false, reason: "session_required" };

  // WebSocket close, ConversationRelay action, and Twilio status callbacks can
  // arrive together. This database claim is the only component allowed to start
  // abandonment recovery, preventing duplicate SMS and alerts.
  const session = await VoiceSession.findOneAndUpdate(
    {
      _id: sessionId,
      status: { $in: ["routing", "connecting", "active", "capturing_callback", "completing"] },
      $or: [
        { outcome: { $exists: false } },
        { outcome: null },
        { outcome: "" },
      ],
      "metadata.abandonmentRecoveryClaimedAt": { $exists: false },
    },
    {
      $set: {
        status: "fallback_sms",
        outcome: "abandoned",
        outcomeCommittedAt: now,
        "metadata.outcome": {
          outcome: "abandoned",
          committedAt: now.toISOString(),
          source: "abandonment_recovery_claim",
        },
        "metadata.abandonmentRecoveryClaimedAt": now,
        "metadata.abandonmentCloseCode": Number(closeCode) || 0,
        "metadata.abandonmentCloseReason": clean(closeReason),
      },
    },
    { returnDocument: "after" },
  ).populate(["business", "lead", "conversation", "callLog"]);

  if (!session) return { recovered: false, duplicate: true };

  let smsStatus = "failed";
  try {
    const smsSession = await VoiceSessionService.sendFallbackSms({
      sessionId: session._id,
      failureReason:
        "Caller disconnected before a committed voice outcome.",
      alert: false,
    });
    smsStatus = ["sent", "suppressed", "failed"].includes(
      smsSession?.fallbackSmsStatus,
    )
      ? smsSession.fallbackSmsStatus
      : "failed";
  } catch (error) {
    logOperationalError("voice.abandonment_sms_failed", error, {
      voiceSessionId: session._id,
      businessId: normalizeId(session.business),
    });
  }

  let alertCreated = false;
  let alertLatencyMs = 0;
  try {
    const alertResult = await AlertService.createAutomatic({
      businessId: normalizeId(session.business),
      leadId: normalizeId(session.lead),
      conversationId: normalizeId(session.conversation),
      type: "missed_call",
      title: "Abandoned Voice AI call recovered",
      message:
        "The caller disconnected before booking, callback capture, transfer, or a resolved answer. CallBackIQ preserved the session and started missed-call recovery.",
      priority: "high",
      metadata: {
        source: "voice_abandonment_recovery",
        voiceSessionId: String(session._id),
        providerCallSid: session.providerCallSid || null,
        smsStatus,
        closeCode: Number(closeCode) || 0,
      },
      dedupeKey: `voice_abandoned:${
        session.providerCallSid || session._id
      }`,
    });
    alertCreated = Boolean(alertResult?.created);
    alertLatencyMs = Math.max(0, Date.now() - new Date(now).getTime());
  } catch (error) {
    logOperationalError("voice.abandonment_alert_failed", error, {
      voiceSessionId: session._id,
      businessId: normalizeId(session.business),
    });
  }

  await VoiceSession.updateOne(
    { _id: session._id },
    {
      $set: {
        "metadata.abandonmentSmsStatus": smsStatus,
        "metadata.abandonmentAlertCreated": alertCreated,
        "metadata.abandonmentAlertLatencyMs": alertLatencyMs,
        "metadata.abandonmentRecoveryCompletedAt": new Date(),
      },
      $push: {
        "metadata.metricEvents": {
          $each: [
            {
              event: "abandonment_alert_latency_ms",
              value: alertLatencyMs,
              metadata: { alertCreated, smsStatus },
              at: new Date(),
            },
          ],
          $slice: -500,
        },
      },
    },
  );

  return {
    recovered: true,
    smsStatus,
    alertCreated,
    alertLatencyMs,
  };
};

export default {
  VOICE_OUTCOMES,
  commitVoiceOutcome,
  hasCommittedVoiceOutcome,
  inferVoiceOutcome,
  recoverAbandonedVoiceCall,
};
