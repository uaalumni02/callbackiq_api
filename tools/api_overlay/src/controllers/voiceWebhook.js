import Business from "../models/business.js";
import TwilioController from "./twilio.js";
import VoiceAvailabilityService from "../voice/voiceAvailability.service.js";
import VoiceSessionService from "../voice/voiceSession.service.js";
import {
  conversationRelayTwiml,
  dialTwiml,
  emptyTwiml,
  isConversationRelayConfigured,
  normalizeVoiceSettings,
  sayTwiml,
} from "../voice/voiceRouting.service.js";

const findBusiness = (phone) =>
  Business.findOne({ phone, isActive: true });

const callFields = (req) => ({
  from: req.body.From || req.body.Caller || "",
  to: req.body.To || req.body.Called || "",
  providerCallSid: req.body.CallSid || "",
});

const sendXml = (res, body) => res.type("text/xml").status(200).send(body);

const gracefulVoiceFailure = async ({ res, session, error, context }) => {
  const failureReason = `${context}: ${error?.message || "Unknown voice routing error"}`;
  if (session?._id) {
    try {
      await VoiceSessionService.sendFallbackSms({
        sessionId: session._id,
        failureReason,
      });
    } catch (fallbackError) {
      console.error("Voice fallback failed after routing error:", fallbackError);
    }
  }
  return sendXml(
    res,
    sayTwiml(
      "I’m sorry, we’re having trouble handling this call. Please try again, or the team will follow up using your caller information.",
    ),
  );
};

const parseHandoffData = (value) => {
  try {
    return JSON.parse(String(value || "{}"));
  } catch {
    return {};
  }
};

class VoiceWebhookController {
  static async initial(req, res) {
    let session = null;
    try {
      const fields = callFields(req);
      if (!fields.from || !fields.to || !fields.providerCallSid) {
        return sendXml(
          res,
          sayTwiml(
            "I’m sorry, we could not identify this call. Please try again or contact the business directly.",
          ),
        );
      }
      const business = await findBusiness(fields.to);
      if (!business) {
        return sendXml(
          res,
          sayTwiml(
            "I’m sorry, this number is not configured for voice assistance. Please contact the business directly.",
          ),
        );
      }

      const settings = normalizeVoiceSettings(business);
      if (!settings.voiceAiEnabled || settings.answerMode === "disabled") {
        return TwilioController.voiceWebhook(req, res);
      }

      session = await VoiceSessionService.ensureContext({
        business,
        ...fields,
      });

      if (!isConversationRelayConfigured()) {
        await VoiceSessionService.sendFallbackSms({
          sessionId: session._id,
          failureReason:
            "ConversationRelay is enabled for the business but the secure WebSocket environment is not configured.",
        });
        return sendXml(
          res,
          sayTwiml(
            "I’m sorry, the voice assistant is unavailable. I’ve sent you a text so the team can follow up.",
          ),
        );
      }

      if (settings.answerMode === "always") {
        session.status = "connecting";
        await session.save();
        return sendXml(
          res,
          conversationRelayTwiml({ business, voiceSessionId: session._id }),
        );
      }

      const isOpen = await VoiceAvailabilityService.isBusinessOpen(business);
      if (settings.answerMode === "after_hours" && !isOpen) {
        session.status = "connecting";
        await session.save();
        return sendXml(
          res,
          conversationRelayTwiml({ business, voiceSessionId: session._id }),
        );
      }

      if (settings.transferPhone) {
        return sendXml(
          res,
          dialTwiml({
            transferPhone: settings.transferPhone,
            timeout: settings.overflowRingSeconds,
          }),
        );
      }

      if (settings.answerMode === "overflow") {
        session.status = "connecting";
        await session.save();
        return sendXml(
          res,
          conversationRelayTwiml({ business, voiceSessionId: session._id }),
        );
      }

      await VoiceSessionService.sendFallbackSms({
        sessionId: session._id,
        failureReason:
          "The business was open but no transfer phone was configured for after-hours mode.",
      });
      return sendXml(
        res,
        sayTwiml(
          "The team is unavailable right now. I’ve sent you a text so they can follow up.",
        ),
      );
    } catch (error) {
      console.error("Phase 9 voice routing error:", error);
      return gracefulVoiceFailure({
        res,
        session,
        error,
        context: "Initial voice routing failed",
      });
    }
  }

  static async overflow(req, res) {
    let session = null;
    try {
      const fields = callFields(req);
      const business = await findBusiness(fields.to);
      if (!business) {
        return sendXml(
          res,
          sayTwiml(
            "I’m sorry, this number is not configured for voice assistance. Please contact the business directly.",
          ),
        );
      }
      session = await VoiceSessionService.ensureContext({ business, ...fields });
      const settings = normalizeVoiceSettings(business);
      const dialStatus = String(req.body.DialCallStatus || "").toLowerCase();

      if (dialStatus === "completed" || dialStatus === "answered") {
        await VoiceSessionService.markCompleted(session._id, {
          dialStatus,
          routedToStaff: true,
        });
        return sendXml(res, emptyTwiml());
      }

      if (
        !settings.voiceAiEnabled ||
        settings.answerMode === "disabled" ||
        (settings.answerMode === "after_hours" &&
          (await VoiceAvailabilityService.isBusinessOpen(business)))
      ) {
        await VoiceSessionService.sendFallbackSms({
          sessionId: session._id,
          failureReason:
            settings.answerMode === "after_hours"
              ? `Staff did not answer during business hours (${dialStatus || "unknown"}); after-hours voice AI was not activated.`
              : "Voice AI was disabled before the overflow callback completed.",
        });
        return sendXml(
          res,
          sayTwiml(
            "I’m sorry we could not answer. I’ve sent you a text so the team can follow up.",
          ),
        );
      }

      if (!isConversationRelayConfigured()) {
        await VoiceSessionService.sendFallbackSms({
          sessionId: session._id,
          failureReason: `Staff did not answer (${dialStatus || "unknown"}) and ConversationRelay was unavailable.`,
        });
        return sendXml(
          res,
          sayTwiml(
            "I’m sorry we could not answer. I’ve sent you a text so the team can follow up.",
          ),
        );
      }

      session.status = "connecting";
      await session.save();
      return sendXml(
        res,
        conversationRelayTwiml({ business, voiceSessionId: session._id }),
      );
    } catch (error) {
      console.error("Voice overflow callback error:", error);
      return gracefulVoiceFailure({
        res,
        session,
        error,
        context: "Voice overflow routing failed",
      });
    }
  }

  static async complete(req, res) {
    let session = null;
    try {
      const fields = callFields(req);
      const business = await findBusiness(fields.to);
      if (!business) {
        return sendXml(
          res,
          sayTwiml(
            "I’m sorry, this number is not configured for voice assistance. Please contact the business directly.",
          ),
        );
      }
      session = await VoiceSessionService.ensureContext({ business, ...fields });
      const handoff = parseHandoffData(req.body.HandoffData);
      const settings = normalizeVoiceSettings(business);

      if (handoff.reasonCode === "voice-failure") {
        await VoiceSessionService.sendFallbackSms({
          sessionId: session._id,
          failureReason: handoff.reason || "ConversationRelay voice failure",
        });
        return sendXml(
          res,
          sayTwiml(
            "I’m sorry, the voice assistant could not continue. The team has your request and will follow up.",
          ),
        );
      }

      if (handoff.reasonCode === "live-agent-handoff") {
        if (settings.transferPhone) {
          return sendXml(
            res,
            dialTwiml({
              transferPhone: settings.transferPhone,
              timeout: settings.overflowRingSeconds,
              actionPath: "/api/twilio/voice-transfer-complete",
            }),
          );
        }
        await VoiceSessionService.sendFallbackSms({
          sessionId: session._id,
          failureReason: `Human handoff requested without a configured transfer phone: ${handoff.reason || "unknown"}`,
        });
        return sendXml(
          res,
          sayTwiml(
            "The team could not be reached by phone. I’ve sent you a text and created an urgent follow-up request.",
          ),
        );
      }

      const status = String(req.body.SessionStatus || req.body.CallStatus || "");
      if (/fail|error/i.test(status)) {
        await VoiceSessionService.sendFallbackSms({
          sessionId: session._id,
          failureReason: `ConversationRelay completed with status ${status}.`,
        });
        return sendXml(
          res,
          sayTwiml(
            "I’m sorry, the voice session ended unexpectedly. I’ve sent you a text so the team can follow up.",
          ),
        );
      }

      await VoiceSessionService.markCompleted(session._id, {
        sessionStatus: status || "completed",
      });
      return sendXml(res, emptyTwiml());
    } catch (error) {
      console.error("Voice completion callback error:", error);
      return gracefulVoiceFailure({
        res,
        session,
        error,
        context: "Voice completion handling failed",
      });
    }
  }

  static async transferComplete(req, res) {
    let session = null;
    try {
      const fields = callFields(req);
      const business = await findBusiness(fields.to);
      if (!business) {
        return sendXml(
          res,
          sayTwiml(
            "I’m sorry, this number is not configured for voice assistance. Please contact the business directly.",
          ),
        );
      }
      session = await VoiceSessionService.ensureContext({ business, ...fields });
      const dialStatus = String(req.body.DialCallStatus || "").toLowerCase();
      if (dialStatus !== "completed" && dialStatus !== "answered") {
        await VoiceSessionService.sendFallbackSms({
          sessionId: session._id,
          failureReason: `Requested human transfer was not answered (${dialStatus || "unknown"}).`,
        });
        return sendXml(
          res,
          sayTwiml(
            "The team could not answer the transfer. I’ve sent you a text and created a high-priority follow-up.",
          ),
        );
      }
      await VoiceSessionService.markCompleted(session._id, {
        dialStatus,
        transferredToStaff: true,
      });
      return sendXml(res, emptyTwiml());
    } catch (error) {
      console.error("Voice transfer completion error:", error);
      return gracefulVoiceFailure({
        res,
        session,
        error,
        context: "Voice transfer completion failed",
      });
    }
  }
}

export default VoiceWebhookController;
