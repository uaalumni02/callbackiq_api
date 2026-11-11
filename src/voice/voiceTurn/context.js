import { maybeAnswerDialogQuestion } from '../../services/conversationPolicy/dialogInterruption.js';

import { preventNonProgressReply } from '../../services/conversationPolicy/repetitionGuard.js';

import { dialogMode } from '../../services/conversationPolicy/dialogPolicy.js';

import { handleCompoundCustomerTurn } from '../../services/messaging/compoundCustomerTurn.service.js';

import { planCustomerTurn } from '../../services/messaging/customerTurnPlan.service.js';

import { applyCustomerAddressRevision } from '../../services/messaging/customerRequestRevision.service.js';

import { captureTurnFacts } from '../../services/booking/turnFactCapture.service.js';

import { classifySmsIntent } from '../../services/messaging/smsIntentClassifier.service.js';

import { handleConversationControl } from '../../services/conversationControl.service.js';

import { guardServiceRequest } from '../../services/serviceEligibility/serviceEligibility.service.js';

import { observeCustomerConstraint, respectCustomerConstraints } from '../../services/conversationCondition.service.js';

import AlertService from '../../services/alert.service.js';

import { handleVoiceExit } from "../voiceExit.service.js";

import "../../services/booking/recoveryIntake.service.js";

import { schedulingQuestionReply } from "../../services/booking/schedulingQuestions.service.js";

import { beginValuation, finishValuation } from "../../services/valuation/opportunityValuation.service.js";

import Appointment from "../../models/appointment.js";

import CallLog from "../../models/callLog.js";

import ServiceOffering from "../../models/serviceOffering.js";

import searchServicesTool from "../../helpers/ai/tools/searchServices.tool.js";

import "../../helpers/ai/tools/validateServiceArea.tool.js";

import sendConfirmationSmsTool from "../../helpers/ai/tools/sendConfirmationSms.tool.js";

import { bookingQuestionReply, isAmbiguousServiceLoss, serviceLossQuestion } from "../../services/booking/conversationQuestions.service.js";

import BookingStateMachineService from "../../services/booking/bookingStateMachine.service.js";

import "../../services/safetyAssessmentService.js";

import {
  logOperationalError,
  logOperationalWarning,
} from "../../helpers/logging/safeLogger.js";

import VoiceAvailabilityService from "../voiceAvailability.service.js";

import VoiceCallbackService from "../voiceCallback.service.js";

import VoiceTranscriptService from "../voiceTranscript.service.js";

import VoiceUnderstandingService from "../voiceUnderstanding.service.js";

import VoiceServiceAreaService from "../voiceServiceArea.service.js";

import VoiceExistingJobStatusService from "../voiceExistingJobStatus.service.js";

import VoiceMetricsService from "../voiceMetrics.service.js";

import {
  cleanVoiceText,
  containsAbuse,
  extractPostalCode,
  isBookingIntent,
  isBusinessHoursQuestion,
  isCallbackRequest,
  isHumanRequest,
  isLikelyNonEnglish,
  isRepeatIntent,
  isServiceAreaQuestion,
  isVoiceAvailabilityInquiry,
  isTransientDependencyError,
  toSpokenReply,
} from "../voiceInput.service.js";

import "../voicePhone.service.js";

import { assertVoiceTurnActive } from "../../services/voiceTurnContext.service.js";

import { classifyOperationalUrgency } from "../../services/scheduling/customerSchedulingIntent.service.js";

const DIAGNOSTIC_FEE =
  /\b(?:diagnostic|service call|trip)\b.{0,25}\b(?:fee|cost|charge)\b/i;

const COMPLAINT_OR_DISPUTE =
  /\b(?:complaint|dispute|refund|chargeback|lawsuit|lawyer|attorney|terrible service|angry|furious|upset|scam|ripped off|manager)\b/i;

const WARRANTY = /\b(?:warranty|guarantee claim|covered under warranty)\b/i;

const COMMERCIAL =
  /\b(?:commercial|industrial|property manager|apartment complex|multi[- ]family|restaurant|warehouse|office building)\b/i;

const EXISTING_JOB =
  /\b(?:existing job|current job|technician already|appointment today|where is the tech|previous repair|came out already|return visit|unfinished work|technician did not|tech did not|status of my appointment)\b/i;

const COMPLEX_PRICING =
  /\b(?:exact|final|binding|firm|guaranteed)\b.{0,30}\b(?:price|quote|cost)|\b(?:full replacement quote|insurance estimate|itemized quote)\b/i;

const SERVICE_REQUEST_HINT =
  /\b(?:need|want|looking for|repair|fix|service|install|replace|maintenance|inspection|leak|clog|clogged|broken|not working|stopped working|problem|issue|no heat|no cooling|no hot water)\b/i;

const CONCRETE_SERVICE_REQUEST =
  /\b(?:plumber|plumbing|hvac|air conditioner|a\/?c|furnace|roofer|roofing|electrician|electrical|restoration|water damage|garage door|locksmith|landscaping|repair|fix|install|replace|maintenance|inspection|leak|clog|clogged|broken|not working|stopped working|no heat|no cooling|no hot water|problem with|issue with)\b/i;

const ACTIVE_BOOKING_STATUSES = new Set([
  "collecting_service",
  "collecting_location",
  "collecting_preference",
  "offering_slots",
  "awaiting_confirmation",
  "booking",
]);

const TERMINAL_BOOKING_STATUSES = new Set([
  "booked",
  "human_takeover",
  "failed",
  "canceled",
]);

const GENERAL_HELP_REPLY =
  "I can help with business information, services, scheduling questions, or a callback request. What do you need help with?";

const MAX_REPEATED_INPUTS = 3;

const MAX_ABUSIVE_TURNS = 2;

const MAX_UNMATCHED_TURNS_BEFORE_CALLBACK = 2;

const clean = (value, maximum = 2000) => cleanVoiceText(value, maximum);

const VOICE_URGENCY_RANK = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
  emergency: 3,
});

const preserveVoiceUrgency = async (lead, candidate) => {
  if (!lead || !candidate || !(candidate in VOICE_URGENCY_RANK)) return;
  const current =
    lead.urgency in VOICE_URGENCY_RANK ? lead.urgency : "medium";
  if (VOICE_URGENCY_RANK[candidate] <= VOICE_URGENCY_RANK[current]) return;
  lead.urgency = candidate;
  assertVoiceTurnActive();
  await lead.save();
};

const recordPilotMetric = (
  session,
  event,
  value = 1,
  metadata = {},
) => {
  if (!session?._id) return;

  void VoiceMetricsService.recordVoiceMetric({
    sessionId: session._id,
    event,
    value,
    metadata,
  }).catch((error) => {
    // Operational metrics must never interrupt the caller-facing flow.
    logOperationalError("voice.metric_record_failed", error, {
      voiceSessionId: session._id,
      metricEvent: String(event || "").slice(0, 100),
    });
  });
};

const captureCallback = ({
  session,
  customerMessage,
  reason,
  alertType = "human_requested",
  priority = "high",
  openingPrompt,
  seed = {},
  seedServiceFromMessage = false,
  immediate = false,
  completionReply = "",
  sendConfirmationSms = true,
  requiredFields,
}) =>
  VoiceCallbackService.handle({
    session,
    customerMessage,
    reason,
    alertType,
    priority,
    openingPrompt,
    seed: {
      serviceNeeded: session?.metadata?.currentUnderstanding?.entities?.service || undefined,
      customerName: session?.metadata?.currentUnderstanding?.entities?.name || undefined,
      location: session?.metadata?.currentUnderstanding?.entities?.location || session?.metadata?.currentUnderstanding?.entities?.city || session?.metadata?.currentUnderstanding?.entities?.postalCode || undefined,
      urgency: session?.metadata?.currentUnderstanding?.entities?.urgency || undefined,
      preferredTime: session?.metadata?.currentUnderstanding?.entities?.preference || undefined,
      ...seed,
    },
    seedServiceFromMessage,
    immediate,
    completionReply,
    sendConfirmationSms,
    requiredFields,
  });

const hasCatalogServiceMatch = async ({ businessId, text }) => {
  if (!businessId || !SERVICE_REQUEST_HINT.test(text)) return false;
  try {
    const matches = (await searchServicesTool({ businessId, query: text })) || [];
    const normalizedText = clean(text, 1000).toLowerCase();
    return matches.some((match) => {
      const score = Number(match?.score);
      if (Number.isFinite(score)) return score > 0;
      const serviceName = clean(match?.name, 200).toLowerCase();
      return Boolean(serviceName && normalizedText.includes(serviceName));
    });
  } catch (error) {
    logOperationalWarning("voice.service_intent_lookup_failed", {
      businessId,
      errorCode: error?.code || error?.name || "error",
    });
    return false;
  }
};

const updateTurnGuards = (session, text) => {
  const metadata = (session.metadata = { ...(session.metadata || {}) });
  const guard = (metadata.voiceAgentGuard = {
    ...(metadata.voiceAgentGuard || {}),
  });
  const normalized = clean(text, 500).toLowerCase();
  if (normalized && normalized === guard.lastCustomerInput) {
    guard.repeatedInputCount = Number(guard.repeatedInputCount || 1) + 1;
  } else {
    guard.lastCustomerInput = normalized;
    guard.repeatedInputCount = normalized ? 1 : 0;
  }
  const abusive = containsAbuse(text);
  const likelyNonEnglish = isLikelyNonEnglish(text);
  guard.abusiveTurnCount = abusive
    ? Number(guard.abusiveTurnCount || 0) + 1
    : 0;
  guard.nonEnglishTurnCount = likelyNonEnglish
    ? Number(guard.nonEnglishTurnCount || 0) + 1
    : 0;
  guard.fallbackTurnCount = Number(guard.fallbackTurnCount || 0);
  guard.lastTurnAt = new Date().toISOString();
  return guard;
};

const resetFallbackGuard = (guard) => {
  guard.fallbackTurnCount = 0;
};

const getDiagnosticFeeReply = async ({ business, text }) => {
  try {
    const matches =
      (await searchServicesTool({ businessId: business._id, query: text })) || [];
    assertVoiceTurnActive();
    // The search tool may return a sole unrelated offering with score zero.
    // Only one positive match can authorize looking up its published fee.
    const positiveMatches = matches.filter(match => Number.isFinite(match?.score) && match.score > 0);
    const service =
      positiveMatches.length === 1
        ? await ServiceOffering.findOne({
            _id: positiveMatches[0].id,
            business: business._id,
            active: true,
            aiCanDiscuss: true,
          })
        : null;
    assertVoiceTurnActive();
    if (
      service?.aiCanDiscuss === true &&
      service.discloseDiagnosticFee === true &&
      Number.isFinite(service.diagnosticFee) && service.diagnosticFee >= 0
    ) {
      return `The published diagnostic fee for ${service.name} is $${service.diagnosticFee}. Final scope and pricing require confirmation by the business.`;
    }
  } catch (error) {
    if (error?.code === "VOICE_STALE_TURN") throw error;
    logOperationalError("voice.diagnostic_fee_lookup_failed", error, {
      businessId: business._id,
    });
  }
  return "I don’t have a verified diagnostic fee for that service. I can help schedule a visit or create a pricing callback request.";
};

const recordConfirmedAppointment = async ({
  session,
  business,
  lead,
  conversation,
  appointment,
}) => {
  assertVoiceTurnActive();
  session.appointment = appointment._id;
  session.estimatedValue = appointment.estimatedValue ?? null;
  session.valuation = appointment.valuation;
  assertVoiceTurnActive();
  await session.save();

  if (lead) {
    lead.status = "booked";
    lead.bookedAt = lead.bookedAt || new Date();
    lead.appointment = appointment._id;
    lead.recovered = true;
    lead.recoveredBy = "voice_ai";
    assertVoiceTurnActive();
    await lead.save();
  }

  const callLog =
    session.callLog && typeof session.callLog.save === "function"
      ? session.callLog
      : session.callLog
        ? await CallLog.findById(session.callLog)
        : null;
  if (callLog) {
    callLog.recovered = true;
    assertVoiceTurnActive();
    await callLog.save();
  }

  try {
    assertVoiceTurnActive();
    return await sendConfirmationSmsTool({
      business,
      lead,
      conversation,
      appointmentId: appointment._id,
      voiceSessionId: session._id,
    });
  } catch (error) {
    logOperationalError("voice.booking_confirmation_sms_failed", error, {
      businessId: business._id,
      voiceSessionId: session._id,
      appointmentId: appointment._id,
    });
    return { failed: true };
  }
};

export { ACTIVE_BOOKING_STATUSES, AlertService, Appointment, BookingStateMachineService, COMMERCIAL, COMPLAINT_OR_DISPUTE, COMPLEX_PRICING, CONCRETE_SERVICE_REQUEST, DIAGNOSTIC_FEE, EXISTING_JOB, GENERAL_HELP_REPLY, MAX_ABUSIVE_TURNS, MAX_REPEATED_INPUTS, MAX_UNMATCHED_TURNS_BEFORE_CALLBACK, TERMINAL_BOOKING_STATUSES, VOICE_URGENCY_RANK, VoiceAvailabilityService, VoiceCallbackService, VoiceExistingJobStatusService, VoiceServiceAreaService, VoiceTranscriptService, VoiceUnderstandingService, WARRANTY, applyCustomerAddressRevision, assertVoiceTurnActive, beginValuation, bookingQuestionReply, captureCallback, captureTurnFacts, classifyOperationalUrgency, classifySmsIntent, clean, containsAbuse, dialogMode, extractPostalCode, finishValuation, getDiagnosticFeeReply, guardServiceRequest, handleCompoundCustomerTurn, handleConversationControl, handleVoiceExit, hasCatalogServiceMatch, isAmbiguousServiceLoss, isBookingIntent, isBusinessHoursQuestion, isCallbackRequest, isHumanRequest, isRepeatIntent, isServiceAreaQuestion, isTransientDependencyError, isVoiceAvailabilityInquiry, logOperationalError, maybeAnswerDialogQuestion, observeCustomerConstraint, planCustomerTurn, preserveVoiceUrgency, preventNonProgressReply, recordConfirmedAppointment, recordPilotMetric, resetFallbackGuard, respectCustomerConstraints, schedulingQuestionReply, serviceLossQuestion, toSpokenReply, updateTurnGuards };
