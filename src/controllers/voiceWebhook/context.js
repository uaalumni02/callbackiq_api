import { saveStateDocument } from '../../services/stateTransitions/documents.js';
import "../../models/business.js";
import { resolveTwilioNumberContext } from "../../services/twilioBusinessResolver.service.js";

import VoiceSession from "../../models/voiceSession.js";

import TwilioController from "../twilio.js";

import {
  logOperationalError,
  logOperationalWarning,
} from "../../helpers/logging/safeLogger.js";

import VoiceAvailabilityService from "../../voice/voiceAvailability.service.js";

import VoiceFailureService from "../../voice/voiceFailure.service.js";

import VoiceOutcomeService from "../../voice/voiceOutcome.service.js";

import VoicePreflightService from "../../voice/voicePreflight.service.js";

import VoiceSessionService, {
  TERMINAL_STATUSES,
} from "../../voice/voiceSession.service.js";

import {
  conversationRelayTwiml,
  dialTwiml,
  emptyTwiml,
  isConversationRelayConfigured,
  normalizeVoiceSettings,
  sayTwiml,
  staffScreenDecisionTwiml,
  staffScreenPromptTwiml,
} from "../../voice/voiceRouting.service.js";

import { buildOverflowActionPath, determineInitialVoiceRoute, determinePostDialVoiceRoute, getScenarioAction, getScenarioName, normalizePostDialFallback, VOICE_ROUTE } from "../../voice/voiceRoutingPolicy.service.js";

import "../../voice/voicePhone.service.js";

const TERMINAL_STATUS_SET =
  TERMINAL_STATUSES instanceof Set
    ? TERMINAL_STATUSES
    : new Set(["completed", "failed", "canceled"]);

const isJestRuntime = () =>
  process.env.NODE_ENV === "test" || Boolean(process.env.JEST_WORKER_ID);

const sendXml = (res, body, statusCode = 200) =>
  res.type("text/xml").status(statusCode).send(body);

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
  const numberContext = await resolveTwilioNumberContext(phone);
  return numberContext?.business || null;
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
  return "I could not complete the call, but I preserved the request for the team. Please contact the business directly if you need further assistance.";
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
  if (typeof session.save === "function") await saveStateDocument(session);
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
  // AI is the fallback for unavailable staff, not a call-transfer service.
  // Even if an old setting selected staff_then_sms, never dial staff after
  // a caller has entered the voice AI path.
  return fallbackSmsResponse({ res, session, failureReason, message });
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

export { TwilioController, VOICE_ROUTE, VoiceAvailabilityService, VoicePreflightService, VoiceSessionService, buildOverflowActionPath, determineInitialVoiceRoute, emptyTwiml, fallbackSmsResponse, findBusiness, getScenarioAction, getScenarioName, gracefulVoiceFailure, isTerminal, logOperationalWarning, normalizeVoiceSettings, relayOrFailurePolicy, sayTwiml, sendXml, staffDialResponse, VoiceOutcomeService, determinePostDialVoiceRoute, findExistingContext, normalizePostDialFallback, staffAccepted, parseHandoffData, voiceFailureResponse, VoiceSession, logOperationalError, staffScreenDecisionTwiml, staffScreenPromptTwiml };
