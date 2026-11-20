import "../../models/business.js";
import "../../voice/voicePhone.service.js";
import VoiceOutcomeService from "../../voice/voiceOutcome.service.js";
import { emptyTwiml, normalizeVoiceSettings } from "../../voice/voiceRouting.service.js";
import { fallbackSmsResponse, findExistingContext, gracefulVoiceFailure, isTerminal, parseHandoffData, sendXml, staffAccepted, voiceFailureResponse } from "./helpers.js";

export default class VoiceWebhookCompletionController {
static async complete(req, res) {
    let session = null;
    let settings = null;
    try {
      const context = await findExistingContext(req);
      session = context.session;
      if (!session || !context.business || isTerminal(session)) {
        return sendXml(res, emptyTwiml());
      }
      settings = normalizeVoiceSettings(context.business);
      const handoff = parseHandoffData(req.body?.HandoffData);

      if (handoff.reasonCode === "voice-failure") {
        return voiceFailureResponse({
          res,
          settings,
          session,
          failureReason: handoff.reason || "ConversationRelay voice failure",
        });
      }

      if (handoff.reasonCode === "live-agent-handoff") {
        // Backward-compatible fail-closed handling for a legacy voice session.
        // New voice sessions capture a durable callback request in the agent.
        // This branch must never dial a live staff number after AI answered.
        return fallbackSmsResponse({
          res,
          session,
          failureReason: "Legacy post-AI live handoff disabled; callback-first recovery required.",
          message:
            "Your inquiry has been saved for review. I cannot connect a live staff member or promise a callback time.",
        });
      }

      const status = String(req.body?.SessionStatus || req.body?.CallStatus || "");
      if (/fail|error|disconnect/i.test(status)) {
        return voiceFailureResponse({
          res,
          settings,
          session,
          failureReason: `ConversationRelay completed with status ${status}.`,
        });
      }
      const inferred = VoiceOutcomeService.inferVoiceOutcome(session);
      if (inferred) {
        await VoiceOutcomeService.commitVoiceOutcome({
          sessionId: session._id, outcome: inferred, status: "completed",
          metadata: { sessionStatus: status || "completed", handoffReasonCode: String(handoff.reasonCode || "").slice(0, 100) },
        });
      } else {
        await VoiceOutcomeService.recoverAbandonedVoiceCall({
          sessionId: session._id, closeCode: 1000, closeReason: status || "conversation_relay_complete_without_outcome",
        });
      }
      return sendXml(res, emptyTwiml());
    } catch (error) {
      return gracefulVoiceFailure({
        res,
        session,
        settings,
        error,
        context: "voice_completion_callback",
      });
    }
  }

static async transferComplete(req, res) {
    let session = null;
    try {
      const context = await findExistingContext(req);
      session = context.session;
      if (!session || !context.business || isTerminal(session)) {
        return sendXml(res, emptyTwiml());
      }
      const purpose = ["liveTransfer", "failureStaff"].includes(req.query?.purpose)
        ? req.query?.purpose
        : "liveTransfer";
      const dialStatus = String(req.body?.DialCallStatus || "").toLowerCase();
      const accepted = staffAccepted(session, purpose);
      if (accepted && ["answered", "completed"].includes(dialStatus)) {
        await VoiceOutcomeService.commitVoiceOutcome({
          sessionId: session._id, outcome: "transfer_accepted", status: "completed",
          metadata: { dialStatus, transferCompleted: true, transferPurpose: purpose, staffScreenAccepted: true },
        });
        return sendXml(res, emptyTwiml());
      }
      return fallbackSmsResponse({
        res,
        session,
        failureReason: `Screened ${purpose} attempt was not accepted (${dialStatus || "unknown"}).`,
        message:
          "The team did not accept the live call. I preserved your request as a priority callback.",
      });
    } catch (error) {
      return gracefulVoiceFailure({
        res,
        session,
        settings: null,
        error,
        context: "voice_transfer_callback",
      });
    }
  }
}
