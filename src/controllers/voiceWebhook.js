import Business from "../models/business.js";
import TwilioController from "./twilio.js";
import VoiceAvailabilityService from "../voice/voiceAvailability.service.js";
import VoiceSessionService from "../voice/voiceSession.service.js";
import VoiceFailureService from "../voice/voiceFailure.service.js";
import {
  conversationRelayTwiml,
  dialTwiml,
  emptyTwiml,
  isConversationRelayConfigured,
  normalizeVoiceSettings,
  sayTwiml,
} from "../voice/voiceRouting.service.js";
import {
  buildOverflowActionPath,
  buildTransferActionPath,
  determineInitialVoiceRoute,
  determinePostDialVoiceRoute,
  determineVoiceFailureRoute,
  getScenarioAction,
  getScenarioName,
  normalizePostDialFallback,
  VOICE_ROUTE,
} from "../voice/voiceRoutingPolicy.service.js";

const findBusiness = (phone) => Business.findOne({ phone, isActive: true });

const callFields = (req) => ({
  from: req.body.From || req.body.Caller || "",
  to: req.body.To || req.body.Called || "",
  providerCallSid: req.body.CallSid || "",
});

const sendXml = (res, body) => res.type("text/xml").status(200).send(body);

const queueFailureAudit = ({ session, failureReason, context }) => {
  if (!session?._id) return;

  Promise.resolve()
    .then(() =>
      VoiceFailureService.record({
        sessionId: session._id,
        failureReason,
      }),
    )
    .catch((error) => {
      console.error(`${context || "Voice failure audit"} failed:`, error);
    });
};

const queueFallbackSms = ({ session, failureReason, context }) => {
  if (!session?._id) return;

  // Never make call termination wait on MongoDB, Twilio SMS, or alert writes.
  // VoiceSessionService is idempotent, so the completion callback and socket
  // failure handler may both request fallback without double-texting a caller.
  Promise.resolve()
    .then(() =>
      VoiceSessionService.sendFallbackSms({
        sessionId: session._id,
        failureReason,
      }),
    )
    .catch((error) => {
      console.error(`${context || "Voice fallback"} failed:`, error);
    });
};

const parseHandoffData = (value) => {
  try {
    return JSON.parse(String(value || "{}"));
  } catch {
    return {};
  }
};

const markConnecting = async (session) => {
  session.status = "connecting";
  await session.save();
};

const fallbackSmsResponse = ({
  res,
  session,
  failureReason,
  message =
    "I’m sorry we could not answer. I’ve sent you a text so the team can follow up.",
}) => {
  queueFallbackSms({
    session,
    failureReason,
    context: "Missed-call SMS fallback",
  });
  return sendXml(res, sayTwiml(message));
};

const staffThenSmsResponse = ({
  res,
  settings,
  session,
  failureReason,
  reason = "voice_failure",
}) => {
  queueFailureAudit({
    session,
    failureReason,
    context: "Staff-first voice failure audit",
  });

  return sendXml(
    res,
    dialTwiml({
      transferPhone: settings.transferPhone,
      timeout: settings.overflowRingSeconds,
      actionPath: buildTransferActionPath({ reason }),
    }),
  );
};

const voiceFailureResponse = ({
  res,
  settings,
  session,
  failureReason,
  message =
    "I’m sorry, the voice assistant is unavailable. The team will follow up using your caller information.",
}) => {
  if (determineVoiceFailureRoute({ settings }) === VOICE_ROUTE.DIAL_STAFF) {
    return staffThenSmsResponse({
      res,
      settings,
      session,
      failureReason,
      reason: "voice_failure",
    });
  }

  return fallbackSmsResponse({
    res,
    session,
    failureReason,
    message,
  });
};

const relayOrFailurePolicy = async ({
  res,
  business,
  settings,
  session,
  unavailableReason,
}) => {
  if (!isConversationRelayConfigured()) {
    return voiceFailureResponse({
      res,
      settings,
      session,
      failureReason: unavailableReason,
    });
  }

  await markConnecting(session);
  return sendXml(
    res,
    conversationRelayTwiml({ business, voiceSessionId: session._id }),
  );
};

const gracefulVoiceFailure = ({ res, session, error, context, settings }) => {
  const failureReason = `${context}: ${
    error?.message || "Unknown voice routing error"
  }`;

  if (settings) {
    return voiceFailureResponse({
      res,
      settings,
      session,
      failureReason,
      message:
        "I’m sorry, we’re having trouble handling this call. The team will follow up using your caller information.",
    });
  }

  queueFallbackSms({ session, failureReason, context });
  return sendXml(
    res,
    sayTwiml(
      "I’m sorry, we’re having trouble handling this call. Please try again, or the team will follow up using your caller information.",
    ),
  );
};

class VoiceWebhookController {
  static async initial(req, res) {
    let session = null;
    let settings = null;

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

      settings = normalizeVoiceSettings(business);
      if (!settings.voiceAiEnabled || settings.answerMode === "disabled") {
        return TwilioController.voiceWebhook(req, res);
      }

      session = await VoiceSessionService.ensureContext({
        business,
        ...fields,
      });

      const isOpen = await VoiceAvailabilityService.isBusinessOpen(business);
      const scenario = getScenarioName(isOpen);
      const action = getScenarioAction({ settings, isOpen });
      const route = determineInitialVoiceRoute({ settings, isOpen });

      if (route === VOICE_ROUTE.LEGACY) {
        return TwilioController.voiceWebhook(req, res);
      }

      if (route === VOICE_ROUTE.DIAL_STAFF) {
        return sendXml(
          res,
          dialTwiml({
            transferPhone: settings.transferPhone,
            timeout: settings.overflowRingSeconds,
            actionPath: buildOverflowActionPath({ action, scenario }),
          }),
        );
      }

      if (route === VOICE_ROUTE.RELAY) {
        return relayOrFailurePolicy({
          res,
          business,
          settings,
          session,
          unavailableReason: `The ${scenario} routing policy selected voice AI, but the secure ConversationRelay transport was unavailable.`,
        });
      }

      return fallbackSmsResponse({
        res,
        session,
        failureReason: `The ${scenario} routing policy selected SMS recovery.`,
        message:
          "Thanks for calling. I’ve sent you a text so you can tell the team what you need.",
      });
    } catch (error) {
      console.error("Phase 9 voice routing error:", error);
      return gracefulVoiceFailure({
        res,
        session,
        settings,
        error,
        context: "Initial voice routing failed",
      });
    }
  }

  static async overflow(req, res) {
    let session = null;
    let settings = null;

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
      settings = normalizeVoiceSettings(business);
      const dialStatus = String(req.body.DialCallStatus || "").toLowerCase();
      const fallback = normalizePostDialFallback(req.query.fallback);
      const route = determinePostDialVoiceRoute({ dialStatus, fallback });

      if (route === VOICE_ROUTE.COMPLETE) {
        await VoiceSessionService.markCompleted(session._id, {
          dialStatus,
          routedToStaff: true,
          scenario: String(req.query.scenario || ""),
        });
        return sendXml(res, emptyTwiml());
      }

      if (route === VOICE_ROUTE.FALLBACK_SMS) {
        return fallbackSmsResponse({
          res,
          session,
          failureReason: `Staff did not answer (${
            dialStatus || "unknown"
          }); the configured post-ring action was SMS.`,
        });
      }

      return relayOrFailurePolicy({
        res,
        business,
        settings,
        session,
        unavailableReason: `Staff did not answer (${
          dialStatus || "unknown"
        }) and the configured post-ring voice AI transport was unavailable.`,
      });
    } catch (error) {
      console.error("Voice overflow callback error:", error);
      return gracefulVoiceFailure({
        res,
        session,
        settings,
        error,
        context: "Voice overflow routing failed",
      });
    }
  }

  static async complete(req, res) {
    let session = null;
    let settings = null;

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
      settings = normalizeVoiceSettings(business);
      const handoff = parseHandoffData(req.body.HandoffData);

      if (handoff.reasonCode === "voice-failure") {
        return voiceFailureResponse({
          res,
          settings,
          session,
          failureReason:
            handoff.reason || "ConversationRelay voice failure",
          message:
            "I’m sorry, the voice assistant could not continue. The team will follow up using your caller information.",
        });
      }

      if (handoff.reasonCode === "live-agent-handoff") {
        if (settings.transferPhone) {
          return sendXml(
            res,
            dialTwiml({
              transferPhone: settings.transferPhone,
              timeout: settings.overflowRingSeconds,
              actionPath: buildTransferActionPath({
                reason: handoff.reason || "live_agent_handoff",
              }),
            }),
          );
        }

        return fallbackSmsResponse({
          res,
          session,
          failureReason: `Human handoff requested without a configured transfer phone: ${
            handoff.reason || "unknown"
          }`,
          message:
            "The team could not be reached by phone. I’ve sent you a text and created an urgent follow-up request.",
        });
      }

      const status = String(req.body.SessionStatus || req.body.CallStatus || "");
      if (/fail|error/i.test(status)) {
        return voiceFailureResponse({
          res,
          settings,
          session,
          failureReason: `ConversationRelay completed with status ${status}.`,
          message:
            "I’m sorry, the voice session ended unexpectedly. The team will follow up using your caller information.",
        });
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
        settings,
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

      if (!["completed", "answered"].includes(dialStatus)) {
        return fallbackSmsResponse({
          res,
          session,
          failureReason: `${String(
            req.query.reason || "Requested human transfer",
          )} was not answered (${dialStatus || "unknown"}).`,
          message:
            "The team could not answer the transfer. I’ve sent you a text and created a high-priority follow-up.",
        });
      }

      await VoiceSessionService.markCompleted(session._id, {
        dialStatus,
        transferredToStaff: true,
        transferReason: String(req.query.reason || ""),
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
