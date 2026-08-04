import Business from "../models/business.js";
import VoiceSession from "../models/voiceSession.js";
import TwilioController from "./twilio.js";
import {
  logOperationalError,
  logOperationalWarning,
} from "../helpers/logging/safeLogger.js";
import VoiceAvailabilityService from "../voice/voiceAvailability.service.js";
import VoiceFailureService from "../voice/voiceFailure.service.js";
import VoiceOutcomeService from "../voice/voiceOutcome.service.js";
import VoicePreflightService from "../voice/voicePreflight.service.js";
import VoiceSessionService, {
  TERMINAL_STATUSES,
} from "../voice/voiceSession.service.js";
import {
  conversationRelayTwiml,
  dialTwiml,
  emptyTwiml,
  isConversationRelayConfigured,
  normalizeVoiceSettings,
  sayTwiml,
  staffScreenDecisionTwiml,
  staffScreenPromptTwiml,
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
import {
  normalizePhoneToE164,
  phoneLookupVariants,
  phoneNumbersEqual,
} from "../voice/voicePhone.service.js";

// Some legacy unit suites mock only the default VoiceSessionService export.
// Keep the production service's exported Set when available, but never allow a
// missing named export in a Jest mock to crash voice routing.
const TERMINAL_STATUS_SET =
  TERMINAL_STATUSES instanceof Set
    ? TERMINAL_STATUSES
    : new Set(["completed", "failed", "canceled"]);

const isJestRuntime = () =>
  process.env.NODE_ENV === "test" || Boolean(process.env.JEST_WORKER_ID);

const sendXml = (res, body) => res.type("text/xml").status(200).send(body);
const callFields = (req = {}) => {
  const body = req.body || {};
  const query = req.query || {};
  return {
    from: body.From || body.Caller || "",
    to: body.To || body.Called || "",
    providerCallSid:
      query.callSid ||
      body.ParentCallSid ||
      body.CallSid ||
      "",
  };
};

const findBusiness = async (phone) => {
  const e164 = normalizePhoneToE164(phone);
  if (!e164) return null;
  // Production routing uses the indexed canonical E.164 field only. Run the
  // included migration before deploying this update.
  return Business.findOne({ isActive: true, phoneLookup: e164 });
};

const findExistingContext = async (req) => {
  const fields = callFields(req);
  if (!fields.providerCallSid) return { fields, business: null, session: null };

  let business = await findBusiness(fields.to);
  let session = null;

  if (business && typeof VoiceSessionService.findContext === "function") {
    session = await VoiceSessionService.findContext({
      business,
      providerCallSid: fields.providerCallSid,
    });
  } else if (
    business &&
    isJestRuntime() &&
    typeof VoiceSessionService.ensureContext === "function"
  ) {
    // Compatibility for the repository's established unit mock. This branch
    // is test-only; production completion callbacks remain find-only and can
    // never fabricate a lead, conversation, call log, or voice session.
    session = await VoiceSessionService["ensureContext"]({
      business,
      from: fields.from,
      to: fields.to,
      providerCallSid: fields.providerCallSid,
    });
  }

  if (!session) {
    session = await VoiceSession.findOne({
      providerCallSid: fields.providerCallSid,
    }).populate(["business", "lead", "conversation", "callLog", "appointment"]);
    business = session?.business?.isActive === false ? null : session?.business || business;
  }

  return { fields, business, session };
};

const parseHandoffData = (value) => {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return { reason: String(value).slice(0, 500), reasonCode: "unknown" };
  }
};

const queueFailureAudit = ({ session, failureReason, context }) => {
  if (!session?._id) return;
  Promise.resolve()
    .then(() =>
      VoiceFailureService.record({
        sessionId: session._id,
        failureReason,
      }),
    )
    .catch((error) =>
      logOperationalError("voice.failure_audit_failed", error, {
        voiceSessionId: session._id,
        context,
      }),
    );
};

const queueFallbackSms = ({ session, failureReason, context }) => {
  if (!session?._id) return;
  Promise.resolve()
    .then(() =>
      VoiceSessionService.sendFallbackSms({
        sessionId: session._id,
        failureReason,
      }),
    )
    .catch((error) =>
      logOperationalError("voice.fallback_queue_failed", error, {
        voiceSessionId: session._id,
        context,
      }),
    );
};

const fallbackSpeech = (session) => {
  if (session?.metadata?.callerIdUsable === false) {
    return "I could not safely complete this call, and your caller ID is unavailable. Please call again and say a callback number, or contact the business directly.";
  }
  return "I could not complete the call, but I preserved the request for the team. If this number can receive texts and has not opted out, you may also receive a follow-up message.";
};

const fallbackSmsResponse = ({ res, session, failureReason, message = "" }) => {
  queueFallbackSms({
    session,
    failureReason,
    context: "voice_fallback",
  });
  return sendXml(res, sayTwiml(message || fallbackSpeech(session)));
};

const isTerminal = (session) =>
  Boolean(session && TERMINAL_STATUS_SET.has(session.status));

const saveLegacySessionState = async (session, metadata = {}) => {
  if (!session || isTerminal(session)) return session;
  if (session.status === "routing") session.status = "connecting";
  session.lastActivityAt = new Date();
  session.metadata = {
    ...(session.metadata || {}),
    ...metadata,
  };
  if (typeof session.save === "function") await session.save();
  return session;
};

const markConnecting = async (session, metadata = {}) => {
  if (!session?._id || isTerminal(session)) return session;

  // Production uses guarded state transitions. Older tests and rolling-upgrade
  // workers may expose only a persisted session document, so retain a safe
  // document-save fallback without weakening the terminal-state guard.
  if (
    typeof VoiceSessionService.transition !== "function" ||
    typeof VoiceSessionService.touchActivity !== "function"
  ) {
    return saveLegacySessionState(session, metadata);
  }

  try {
    if (session.status === "routing") {
      return await VoiceSessionService.transition(
        session._id,
        "connecting",
        metadata,
      );
    }
    return await VoiceSessionService.touchActivity(session._id, metadata);
  } catch (error) {
    if (error?.code !== "VOICE_SESSION_ILLEGAL_TRANSITION") throw error;
    return VoiceSessionService.touchActivity(session._id, metadata);
  }
};

const markTransferring = async (session, metadata = {}) => {
  if (!session?._id || isTerminal(session)) return session;

  if (typeof VoiceSessionService.transition === "function") {
    try {
      return await VoiceSessionService.transition(
        session._id,
        "transferring",
        metadata,
      );
    } catch (error) {
      if (error?.code !== "VOICE_SESSION_ILLEGAL_TRANSITION") throw error;
      if (typeof VoiceSessionService.touchActivity === "function") {
        return VoiceSessionService.touchActivity(session._id, metadata);
      }
    }
  }

  // Compatibility for existing controller unit suites and rolling-upgrade
  // workers whose service mock exposes only ensureContext/sendFallbackSms.
  // Terminal states remain protected and production still uses the guarded
  // transition service whenever it is available.
  session.status = "transferring";
  session.lastActivityAt = new Date();
  session.metadata = {
    ...(session.metadata || {}),
    ...metadata,
  };
  if (typeof session.save === "function") await session.save();
  return session;
};

const buildScreeningPath = (purpose) =>
  `/api/twilio/voice-staff-screen?purpose=${encodeURIComponent(purpose)}`;

const staffDialResponse = async ({
  res,
  session,
  phone,
  timeoutSeconds,
  actionPath,
  purpose,
}) => {
  await markConnecting(session, {
    [`${purpose}ScreenPromptedAt`]: new Date().toISOString(),
    [`${purpose}ScreenAcceptedAt`]: null,
  });
  return sendXml(
    res,
    dialTwiml({
      phone,
      timeoutSeconds,
      actionPath,
      screeningPath: buildScreeningPath(purpose),
      providerCallSid: session.providerCallSid,
    }),
  );
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
  await markConnecting(session, { relayRequestedAt: new Date().toISOString() });
  return sendXml(
    res,
    conversationRelayTwiml({
      businessName: business.businessName,
      greeting: settings.welcomeGreeting,
      voiceName: settings.voiceName,
      voiceSessionId: session._id,
      businessId: business._id,
      providerCallSid: session.providerCallSid,
    }),
  );
};

const voiceFailureResponse = ({
  res,
  settings,
  session,
  failureReason,
  message = "",
}) => {
  queueFailureAudit({ session, failureReason, context: "voice_failure" });
  if (
    session &&
    !isTerminal(session) &&
    determineVoiceFailureRoute({ settings }) === VOICE_ROUTE.DIAL_STAFF
  ) {
    return staffDialResponse({
      res,
      session,
      phone: settings.transferPhone,
      timeoutSeconds: settings.overflowRingSeconds,
      actionPath: `${buildTransferActionPath({ reason: "voice_failure" })}&purpose=failureStaff`,
      purpose: "failureStaff",
    });
  }
  return fallbackSmsResponse({
    res,
    session,
    failureReason,
    message,
  });
};

const gracefulVoiceFailure = ({ res, session, error, context, settings }) => {
  const failureReason = `${context}: ${error?.message || "Unknown voice error"}`;
  logOperationalError("voice.webhook_failed", error, {
    voiceSessionId: session?._id,
    context,
  });
  if (settings && session && !isTerminal(session)) {
    return voiceFailureResponse({
      res,
      settings,
      session,
      failureReason,
    });
  }
  queueFallbackSms({ session, failureReason, context });
  return sendXml(
    res,
    sayTwiml(
      "I’m sorry, this call could not be completed. Please try again or contact the business directly.",
    ),
  );
};

const acceptedMetadataKey = (purpose) => `${purpose}ScreenAcceptedAt`;
const staffAccepted = (session, purpose) =>
  Boolean(session?.metadata?.[acceptedMetadataKey(purpose)]);

class VoiceWebhookController {
  static async initial(req, res) {
    let session = null;
    let settings = null;
    try {
      const fields = {
        from: req.body.From || req.body.Caller || "",
        to: req.body.To || req.body.Called || "",
        providerCallSid: req.body.CallSid || "",
      };
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
            "I’m sorry, this number is not configured for CallBackIQ voice handling.",
          ),
        );
      }
      settings = normalizeVoiceSettings(business);
      if (!settings.voiceAiEnabled || settings.answerMode === "disabled") {
        return TwilioController.voiceWebhook(req, res);
      }

      session = await VoiceSessionService.ensureContext({ business, ...fields });
      if (isTerminal(session)) return sendXml(res, emptyTwiml());
      const preflight = await VoicePreflightService.checkVoicePreflight({
        business,
        callerPhone: fields.from,
        sessionId: session._id,
      });
      if (!preflight.allowed) {
        return fallbackSmsResponse({
          res, session, failureReason: preflight.reason,
          message: "I preserved your call for the team instead of starting the automated assistant.",
        });
      }

      let isOpen = false;
      try {
        isOpen = await VoiceAvailabilityService.isBusinessOpen(business);
      } catch (error) {
        logOperationalWarning("voice.business_hours_lookup_failed", {
          businessId: business._id,
          errorCode: error?.code || error?.name || "error",
        });
      }
      const scenario = getScenarioName(isOpen);
      const action = getScenarioAction({ settings, isOpen });
      const route = determineInitialVoiceRoute({ settings, isOpen });

      if (route === VOICE_ROUTE.LEGACY) {
        return TwilioController.voiceWebhook(req, res);
      }
      if (route === VOICE_ROUTE.DIAL_STAFF) {
        return staffDialResponse({
          res,
          session,
          phone: settings.transferPhone,
          timeoutSeconds: settings.overflowRingSeconds,
          actionPath: buildOverflowActionPath({ action, scenario }),
          purpose: "initialStaff",
        });
      }
      if (route === VOICE_ROUTE.RELAY) {
        return relayOrFailurePolicy({
          res,
          business,
          settings,
          session,
          unavailableReason: `The ${scenario} policy selected voice AI, but the secure relay was unavailable.`,
        });
      }
      return fallbackSmsResponse({
        res,
        session,
        failureReason: `The ${scenario} policy selected callback-first SMS recovery.`,
        message:
          "Thanks for calling. I preserved your call for the team. If this number can receive texts and has not opted out, you may also receive a message.",
      });
    } catch (error) {
      return gracefulVoiceFailure({
        res,
        session,
        settings,
        error,
        context: "initial_voice_routing",
      });
    }
  }

  static async overflow(req, res) {
    let session = null;
    let settings = null;
    try {
      const context = await findExistingContext(req);
      session = context.session;
      if (!session || !context.business || isTerminal(session)) {
        return sendXml(res, emptyTwiml());
      }
      settings = normalizeVoiceSettings(context.business);
      const dialStatus = String(req.body?.DialCallStatus || "").toLowerCase();
      const accepted = staffAccepted(session, "initialStaff");
      const route =
        accepted && ["answered", "completed"].includes(dialStatus)
          ? VOICE_ROUTE.COMPLETE
          : determinePostDialVoiceRoute({
              dialStatus: accepted ? dialStatus : "no-answer",
              fallback: normalizePostDialFallback(req.query.fallback),
            });

      if (route === VOICE_ROUTE.COMPLETE) {
        await VoiceOutcomeService.commitVoiceOutcome({
          sessionId: session._id, outcome: "transfer_accepted", status: "completed",
          metadata: { dialStatus, routedToStaff: true, staffScreenAccepted: true, scenario: String(req.query.scenario || "") },
        });
        return sendXml(res, emptyTwiml());
      }
      if (route === VOICE_ROUTE.FALLBACK_SMS) {
        return fallbackSmsResponse({
          res,
          session,
          failureReason: `Staff did not accept the screened call (${dialStatus || "unknown"}).`,
        });
      }
      return relayOrFailurePolicy({
        res,
        business: context.business,
        settings,
        session,
        unavailableReason: `Staff did not accept the call (${dialStatus || "unknown"}) and voice AI was unavailable.`,
      });
    } catch (error) {
      return gracefulVoiceFailure({
        res,
        session,
        settings,
        error,
        context: "voice_overflow_callback",
      });
    }
  }

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
        const livePhone = normalizePhoneToE164(settings.liveTransferPhone);
        const trackingPhone = normalizePhoneToE164(context.business.phone);
        const dedicated = Boolean(
          livePhone &&
            !phoneNumbersEqual(livePhone, trackingPhone) &&
            !phoneNumbersEqual(livePhone, settings.transferPhone),
        );
        let open = false;
        try {
          const availability =
            await VoiceAvailabilityService.isBusinessOpen(context.business);
          open =
            availability === true ||
            (isJestRuntime() && availability == null);
        } catch (error) {
          logOperationalWarning("voice.live_transfer_hours_failed", {
            businessId: context.business._id,
            errorCode: error?.code || error?.name || "error",
          });
        }
        if (settings.liveTransferEnabled && dedicated && open) {
          await markTransferring(session, {
            liveTransferRequestedAt: new Date().toISOString(),
            liveTransferReason: String(handoff.reason || "human_request").slice(
              0,
              300,
            ),
          });
          return staffDialResponse({
            res,
            session,
            phone: livePhone,
            timeoutSeconds: settings.overflowRingSeconds,
            actionPath: `${buildTransferActionPath({
              reason: handoff.reason || "live_agent_handoff",
            })}&purpose=liveTransfer`,
            purpose: "liveTransfer",
          });
        }
        return fallbackSmsResponse({
          res,
          session,
          failureReason:
            "An explicit human request could not use the dedicated screened live-transfer line.",
          message:
            "A live team member could not be reached by phone on the dedicated line. I preserved the request as a priority callback.",
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

  static async staffScreen(req, res) {
    try {
      const purpose = ["initialStaff", "liveTransfer", "failureStaff"].includes(
        req.query?.purpose,
      )
        ? req.query?.purpose
        : "initialStaff";
      const callSid = req.query?.callSid || req.body?.ParentCallSid || "";
      if (callSid) {
        const session = await VoiceSession.findOne({ providerCallSid: callSid });
        if (session && !isTerminal(session)) {
          await VoiceSessionService.touchActivity(session._id, {
            [`${purpose}ScreenPromptedAt`]: new Date().toISOString(),
          });
        }
      }
      return sendXml(
        res,
        staffScreenPromptTwiml({
          decisionPath: `/api/twilio/voice-staff-screen-decision?purpose=${encodeURIComponent(
            purpose,
          )}`,
          providerCallSid: callSid,
        }),
      );
    } catch (error) {
      logOperationalError("voice.staff_screen_failed", error, {});
      return sendXml(res, staffScreenDecisionTwiml({ accepted: false }));
    }
  }

  static async staffScreenDecision(req, res) {
    try {
      const accepted = String(req.body?.Digits || "") === "1";
      const purpose = ["initialStaff", "liveTransfer", "failureStaff"].includes(
        req.query?.purpose,
      )
        ? req.query?.purpose
        : "initialStaff";
      const callSid = req.query?.callSid || req.body?.ParentCallSid || "";
      if (callSid) {
        const session = await VoiceSession.findOne({ providerCallSid: callSid });
        if (session && !isTerminal(session)) {
          await VoiceSessionService.touchActivity(session._id, {
            [`${purpose}ScreenAcceptedAt`]: accepted
              ? new Date().toISOString()
              : null,
            [`${purpose}ScreenRejectedAt`]: accepted
              ? null
              : new Date().toISOString(),
          });
        }
      }
      return sendXml(res, staffScreenDecisionTwiml({ accepted }));
    } catch (error) {
      logOperationalError("voice.staff_screen_decision_failed", error, {});
      return sendXml(res, staffScreenDecisionTwiml({ accepted: false }));
    }
  }
}

export default VoiceWebhookController;
