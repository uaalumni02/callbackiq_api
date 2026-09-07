import { beginValuation, finishValuation } from "../services/valuation/opportunityValuation.service.js";
import Appointment from "../models/appointment.js";
import CallLog from "../models/callLog.js";
import ServiceOffering from "../models/serviceOffering.js";
import searchServicesTool from "../helpers/ai/tools/searchServices.tool.js";
import validateServiceAreaTool from "../helpers/ai/tools/validateServiceArea.tool.js";
import sendConfirmationSmsTool from "../helpers/ai/tools/sendConfirmationSms.tool.js";
import BookingStateMachineService from "../services/booking/bookingStateMachine.service.js";
import { assessInboundSafety } from "../services/safetyAssessmentService.js";
import {
  logOperationalError,
  logOperationalWarning,
} from "../helpers/logging/safeLogger.js";
import VoiceAvailabilityService from "./voiceAvailability.service.js";
import VoiceCallbackService from "./voiceCallback.service.js";
import VoiceHandoffService from "./voiceHandoff.service.js";
import VoiceTranscriptService from "./voiceTranscript.service.js";
import VoiceUnderstandingService from "./voiceUnderstanding.service.js";
import VoiceServiceAreaService from "./voiceServiceArea.service.js";
import VoiceExistingJobStatusService from "./voiceExistingJobStatus.service.js";
import VoiceMetricsService from "./voiceMetrics.service.js";
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
} from "./voiceInput.service.js";
import {
  normalizePhoneToE164,
  phoneNumbersEqual,
} from "./voicePhone.service.js";
import { assertVoiceTurnActive } from "../services/voiceTurnContext.service.js";
import { classifyOperationalUrgency } from "../services/scheduling/customerSchedulingIntent.service.js";

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
  "I can help with a residential service request, service-area questions, published business hours, a verified diagnostic fee, scheduling, or a callback request. What do you need help with?";
const MAX_REPEATED_INPUTS = 3;
const MAX_ABUSIVE_TURNS = 2;
// Preserve a natural multi-question conversation. Unsupported questions may
// receive bounded guidance before callback recovery starts.
const MAX_UNMATCHED_TURNS_BEFORE_CALLBACK = 4;

const normalizeId = (value) => value?._id || value?.id || value || null;
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

const liveTransferResult = async ({ session, reason, prompt }) => ({
  reply: prompt,
  handoff: await VoiceHandoffService.request({
    session,
    reason,
    alertType: "human_requested",
    customerMessage:
      session.transcript
        ?.filter((entry) => entry.role === "customer")
        .at(-1)?.text || "",
  }),
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

const safeBusinessOpen = async (business) => {
  try {
    return await VoiceAvailabilityService.isBusinessOpen(business);
  } catch (error) {
    logOperationalError("voice.live_transfer_availability_failed", error, {
      businessId: normalizeId(business),
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
    const service =
      matches.length === 1
        ? await ServiceOffering.findOne({
            _id: matches[0].id,
            business: business._id,
            active: true,
          })
        : null;
    if (
      service?.discloseDiagnosticFee &&
      Number.isFinite(service.diagnosticFee)
    ) {
      return `The published diagnostic fee for ${service.name} is $${service.diagnosticFee}. Final scope and pricing still require technician evaluation.`;
    }
  } catch (error) {
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

class VoiceAgentService {
  static async handlePrompt({ session, customerMessage, signal = null }) {
    assertVoiceTurnActive();
    if (signal?.aborted) throw signal.reason || new Error("Voice turn aborted.");
    const text = clean(customerMessage, 4000);
    const business = session?.business;
    const lead = session?.lead;
    const conversation = session?.conversation;
    if (!business || !conversation) {
      throw new Error("Voice agent requires business and conversation context.");
    }
    if (!text) return { reply: GENERAL_HELP_REPLY };

    const valuationTicket = await beginValuation(lead, business._id);
    await finishValuation(valuationTicket, { businessId: business._id, evidence: [...(session.transcript || []).filter(entry => entry.role === "customer").slice(-20).map(entry => entry.text), text].join("\n") });
    const guard = updateTurnGuards(session, text);
    const recentMessages = (session.transcript || []).slice(-10).map((entry) => ({
      direction: entry.role === "customer" ? "inbound" : "outbound",
      body: entry.text,
      createdAt: entry.at,
    }));

    let safety;
    let understanding;
    try {
      understanding = await VoiceUnderstandingService.classifyVoiceTurn({
        customerMessage: text,
        recentMessages,
        signal,
      });
      assertVoiceTurnActive();
      const deterministicUrgency = classifyOperationalUrgency(text);
      const understoodUrgency = String(
        understanding?.entities?.urgency || "",
      ).toLowerCase();
      const urgencyCandidate =
        VOICE_URGENCY_RANK[deterministicUrgency] >=
        VOICE_URGENCY_RANK[understoodUrgency]
          ? deterministicUrgency
          : understoodUrgency;
      if (urgencyCandidate) {
        understanding.entities = {
          ...(understanding.entities || {}),
          urgency: urgencyCandidate,
        };
        await preserveVoiceUrgency(lead, urgencyCandidate);
      }

      session.metadata = { ...(session.metadata || {}), currentUnderstanding: understanding };
      safety = understanding.safety;
      if (understanding.usage) {
        session.openAiUsage = {
          inputTokens: Number(session.openAiUsage?.inputTokens || 0) + Number(understanding.usage.input_tokens || 0),
          outputTokens: Number(session.openAiUsage?.outputTokens || 0) + Number(understanding.usage.output_tokens || 0),
        };
      }
    } catch (error) {
      if (error?.code === "VOICE_STALE_TURN" || signal?.aborted) throw error;
      logOperationalError("voice.safety_assessment_failed", error, {
        businessId: business._id,
        voiceSessionId: session._id,
      });
      return captureCallback({
        session,
        customerMessage: text,
        reason: "safety_assessment_unavailable",
        alertType: "low_ai_confidence",
        priority: "high",
        seedServiceFromMessage: true,
        openingPrompt:
          "I can’t safely continue automation until the team reviews this request. I’ll preserve the details for a priority callback.",
      });
    }

    if (safety?.isEmergency || safety?.shouldSendSafetyReply) {
      if (lead) {
        lead.urgency = "emergency";
        lead.notes = `${lead.notes || ""}\nVoice safety escalation: ${text}`
          .trim()
          .slice(0, 2000);
        assertVoiceTurnActive();
        await lead.save();
      }
      return captureCallback({
        session,
        customerMessage: text,
        reason: `safety_emergency:${safety?.hazardType || "other"}`,
        alertType: "safety_emergency",
        priority: "critical",
        seed: {
          serviceNeeded: `Potential ${safety?.hazardType || "safety"} emergency`,
          urgency: "emergency",
          urgencyDetail: text,
        },
        immediate: true,
        sendConfirmationSms: false,
        completionReply:
          safety?.reply ||
          "If anyone is in immediate danger, hang up and call 911 now. CallBackIQ flagged this for urgent review, but do not wait for a callback or use this service instead of emergency services.",
      });
    }

    if (VoiceCallbackService.isActive(session)) {
      resetFallbackGuard(guard);
      return captureCallback({ session, customerMessage: text });
    }

    if (isRepeatIntent(text)) {
      resetFallbackGuard(guard);
      const previous = VoiceTranscriptService.getLastAssistantText(session);
      return {
        reply: previous
          ? `Of course. ${previous}`
          : "Of course. Tell me what service you need, or say callback for team follow-up.",
      };
    }

    if (guard.repeatedInputCount >= MAX_REPEATED_INPUTS) {
      return captureCallback({
        session,
        customerMessage: text,
        reason: "voice_conversation_loop",
        alertType: "low_ai_confidence",
        priority: "medium",
        seedServiceFromMessage: true,
        openingPrompt:
          "I may not be understanding you correctly. I’ll preserve the request for a team member instead of keeping you in a loop.",
      });
    }

    if (guard.abusiveTurnCount >= MAX_ABUSIVE_TURNS) {
      resetFallbackGuard(guard);
      return captureCallback({
        session,
        customerMessage: text,
        reason: "abusive_or_distressed_caller",
        alertType: "angry_customer",
        priority: "high",
        seed: { serviceNeeded: "Distressed or abusive caller follow-up" },
        openingPrompt:
          "I want to get this to the right person. I’ll create a priority callback request and end the automated conversation after the details are confirmed.",
      });
    }

    if (understanding?.directedAbuse || containsAbuse(text)) {
      resetFallbackGuard(guard);
      const strikes = Number(session.metadata?.directedAbuseStrikes || 0) + 1;
      session.metadata.directedAbuseStrikes = strikes;
      if (strikes >= 2) {
        return captureCallback({ session, customerMessage: text, reason: "repeated_directed_abuse", alertType: "angry_customer", priority: "high", seedServiceFromMessage: true, openingPrompt: "I hear that you’re upset. I’ll save this for a team member to handle directly." });
      }
      return { reply: "I hear that you’re upset. Tell me the service issue, or say callback and I’ll save it for team review." };
    }

    if (understanding?.language === "es" || guard.nonEnglishTurnCount >= 1) {
      resetFallbackGuard(guard);
      const entities = understanding?.entities || {};
      return captureCallback({
        session, customerMessage: text, reason: "language_barrier_spanish",
        alertType: "human_requested", priority: "high",
        seed: { language: "es", serviceNeeded: entities.service || "Solicitud en español", customerName: entities.name, location: entities.location || entities.city || entities.postalCode, urgency: entities.urgency, preferredTime: entities.preference },
        seedServiceFromMessage: !entities.service,
        openingPrompt: "Entiendo. Guardaré su solicitud para que el equipo la revise. No puedo garantizar cuándo habrá alguien disponible para llamar. ¿Qué nombre debo poner en la solicitud?",
      });
    }

    const bookingStatus = conversation?.bookingState?.status || "not_started";
    const bookingInProgress = ACTIVE_BOOKING_STATUSES.has(bookingStatus);
    const availabilityInquiry = isVoiceAvailabilityInquiry(text);
    const bookingIntent = isBookingIntent(text) || availabilityInquiry;
    const humanIntent = isHumanRequest(text) && !availabilityInquiry;

    // An explicit human request always wins. The caller should never have to
    // argue with automation, even when the same utterance also mentions booking.
    // The callback/transfer path preserves the existing booking context for staff
    // rather than silently discarding or auto-confirming it.
    if (humanIntent) {
      resetFallbackGuard(guard);
      recordPilotMetric(session, "exit_requested", 1, { exit: "human" });
      recordPilotMetric(session, "exit_honored_one_turn", 1, { exit: "human" });
      const settings = business.voiceSettings || {};
      const liveTransferPhone = normalizePhoneToE164(settings.liveTransferPhone);
      const transferConfigured = Boolean(
        settings.liveTransferEnabled &&
          liveTransferPhone &&
          !phoneNumbersEqual(liveTransferPhone, session.to || business.phone),
      );
      if (transferConfigured && (await safeBusinessOpen(business))) {
        recordPilotMetric(session, "transfer_attempted");
        return liveTransferResult({
          session,
          reason: "customer_requested_human",
          prompt:
            "I’ll try the dedicated live-transfer line now. If the team does not accept the call, CallBackIQ will preserve your information for follow-up.",
        });
      }
      return captureCallback({
        session,
        customerMessage: text,
        reason: "customer_requested_human",
        alertType: "human_requested",
        openingPrompt:
          "A verified live transfer is unavailable right now. I’ll create a priority callback request instead of sending you to voicemail.",
      });
    }

    if (!bookingInProgress && isCallbackRequest(text)) {
      resetFallbackGuard(guard);
      recordPilotMetric(session, "exit_requested", 1, { exit: "callback" });
      recordPilotMetric(session, "exit_honored_one_turn", 1, { exit: "callback" });
      return captureCallback({
        session,
        customerMessage: text,
        reason: "customer_requested_callback",
        alertType: "human_requested",
        openingPrompt: "Absolutely. I’ll collect and confirm the details for the team.",
      });
    }

    if (!bookingInProgress && COMPLAINT_OR_DISPUTE.test(text)) {
      resetFallbackGuard(guard);
      return captureCallback({
        session,
        customerMessage: text,
        reason: "complaint_or_dispute",
        alertType: "angry_customer",
        priority: "high",
        seed: { serviceNeeded: "Complaint, refund, or account dispute" },
        openingPrompt:
          "I’m sorry you’re dealing with that. I won’t route you back to an unanswered line; I’ll create a priority callback for a team member.",
      });
    }

    if (!bookingInProgress && EXISTING_JOB.test(text)) {
      resetFallbackGuard(guard);
      const status = await VoiceExistingJobStatusService.lookupExistingVoiceAppointment({ businessId: business._id, callerPhone: session.from || lead?.phone });
      return captureCallback({ session, customerMessage: text, reason: "existing_job_status", alertType: "human_requested", priority: "high", seed: { serviceNeeded: "Existing job or technician status", customerName: understanding?.entities?.name, location: understanding?.entities?.location || understanding?.entities?.city || understanding?.entities?.postalCode, urgency: understanding?.entities?.urgency, preferredTime: understanding?.entities?.preference }, openingPrompt: status.reply || "I can’t verify the technician’s live status, so I’ll flag this for priority team review rather than guess. I can’t guarantee a callback time." });
    }
    if (!bookingInProgress && (WARRANTY.test(text) || COMMERCIAL.test(text))) {
      resetFallbackGuard(guard);
      const reason = WARRANTY.test(text)
        ? "warranty_claim"
        : COMMERCIAL.test(text)
          ? "commercial_request"
          : "existing_job_problem";
      const serviceNeeded = WARRANTY.test(text)
        ? "Warranty or guarantee claim"
        : COMMERCIAL.test(text)
          ? "Commercial service request"
          : "Existing job or technician follow-up";
      return captureCallback({
        session,
        customerMessage: text,
        reason,
        alertType: "human_requested",
        seed: { serviceNeeded },
        openingPrompt:
          "That needs direct team review. I’ll collect and confirm a callback request instead of making an automated commitment.",
      });
    }

    if (!bookingInProgress && COMPLEX_PRICING.test(text)) {
      resetFallbackGuard(guard);
      return captureCallback({
        session,
        customerMessage: text,
        reason: "complex_pricing",
        alertType: "human_requested",
        seed: { serviceNeeded: "Binding quote or complex pricing request" },
        openingPrompt:
          "I can’t provide a binding quote, but I can collect the details for a pricing callback.",
      });
    }

    if (!bookingInProgress && (understanding?.intent === "hours" || isBusinessHoursQuestion(text))) {
      resetFallbackGuard(guard);
      return { reply: await VoiceAvailabilityService.describeBusinessHours(business), outcome: "direct_answer_resolved" };
    }

    if (!bookingInProgress && (understanding?.intent === "service_area" || isServiceAreaQuestion(text))) {
      resetFallbackGuard(guard);
      const entities = understanding?.entities || {};
      const area = await VoiceServiceAreaService.checkVoiceServiceArea({ business, location: entities.location || text, city: entities.city, postalCode: entities.postalCode || extractPostalCode(text) });
      if (area.supported === true) return { reply: `Yes, ${area.postalCode || area.city || "that location"} is in the verified service area. Would you like to schedule a visit or create a callback request?`, outcome: "direct_answer_resolved" };
      return captureCallback({ session, customerMessage: text, reason: "unverified_service_area", alertType: "low_ai_confidence", priority: "medium", seed: { location: entities.location || entities.city || entities.postalCode || text }, openingPrompt: "I can’t verify that location automatically, but I’ll flag it for team review. I can’t guarantee when someone will be available to call." });
    }

    if (!bookingInProgress && DIAGNOSTIC_FEE.test(text)) {
      resetFallbackGuard(guard);
      return { reply: await getDiagnosticFeeReply({ business, text }), outcome: "direct_answer_resolved" };
    }

    const catalogServiceMatched =
      !bookingInProgress && !bookingIntent
        ? await hasCatalogServiceMatch({ businessId: business._id, text })
        : false;
    const bookingRequested = bookingInProgress || bookingIntent || catalogServiceMatched;

    if (!bookingRequested) {
      if (CONCRETE_SERVICE_REQUEST.test(text)) {
        resetFallbackGuard(guard);
        return captureCallback({
          session,
          customerMessage: text,
          reason: "service_not_matched",
          alertType: "low_ai_confidence",
          priority: "medium",
          seedServiceFromMessage: true,
          openingPrompt:
            "I could not confidently match that request to an automatically bookable service, but I can preserve it for the team.",
        });
      }

      guard.fallbackTurnCount += 1;
      if (guard.fallbackTurnCount >= MAX_UNMATCHED_TURNS_BEFORE_CALLBACK) {
        return captureCallback({
          session,
          customerMessage: text,
          reason: "low_ai_confidence",
          alertType: "low_ai_confidence",
          priority: "medium",
          openingPrompt:
            "I may not be understanding you correctly. I’ll preserve the request for a team member instead of repeating the same help message.",
        });
      }
      return { reply: GENERAL_HELP_REPLY };
    }

    resetFallbackGuard(guard);
    const readOnlyAvailabilityInProgress =
      bookingStatus === "offering_slots" &&
      Array.isArray(conversation?.bookingState?.offeredSlots) &&
      conversation.bookingState.offeredSlots.length > 0;

    if (
      !business?.features?.aiBookingEnabled &&
      !availabilityInquiry &&
      !readOnlyAvailabilityInProgress
    ) {
      return captureCallback({
        session,
        customerMessage: text,
        reason: "voice_booking_not_enabled",
        alertType: "human_requested",
        seedServiceFromMessage: !bookingInProgress,
        openingPrompt:
          "I can collect the service details and preferred timing so the team can follow up without losing your request.",
      });
    }

    if (TERMINAL_BOOKING_STATUSES.has(bookingStatus) && bookingStatus !== "booked") {
      return captureCallback({
        session,
        customerMessage: text,
        reason: `voice_booking_${bookingStatus}`,
        alertType: "booking_conflict",
        seed: {
          serviceNeeded: lead?.serviceNeeded,
          customerName: lead?.customerName,
          location: lead?.address,
          preferredTime: lead?.preferredAppointmentTime,
        },
        openingPrompt:
          "I can’t safely continue that automated booking state. I’ll preserve the details for a priority callback.",
      });
    }

    const previousAppointmentId = conversation?.bookingState?.appointment;
    let booking;
    try {
      assertVoiceTurnActive();
      booking = await BookingStateMachineService.handle({
        business,
        lead,
        conversation,
        customerMessage: text,
        channel: "voice",
        source: "voice_booking_state_machine",
        providerCallSid: session.providerCallSid,
        voiceSessionId: session._id,
      });
      assertVoiceTurnActive();
    } catch (error) {
      if (error?.code === "VOICE_STALE_TURN" || signal?.aborted) throw error;
      logOperationalError("voice.booking_state_machine_failed", error, {
        businessId: business._id,
        voiceSessionId: session._id,
        transient: isTransientDependencyError(error),
      });
      return captureCallback({
        session,
        customerMessage: text,
        reason: "voice_booking_dependency_failed",
        alertType: "booking_conflict",
        seed: {
          serviceNeeded: lead?.serviceNeeded || text,
          customerName: lead?.customerName,
          location: lead?.address,
          preferredTime: lead?.preferredAppointmentTime,
        },
        openingPrompt:
          "I couldn’t safely complete the scheduling check. I’ll preserve the request for a priority callback instead of guessing or double-booking.",
      });
    }

    if (!booking?.handled) {
      return captureCallback({
        session,
        customerMessage: text,
        reason: "low_ai_confidence",
        alertType: "low_ai_confidence",
        seedServiceFromMessage: !bookingInProgress,
        openingPrompt:
          "I want to make sure the team receives accurate information. I’ll create a callback request instead of making an uncertain booking.",
      });
    }

    const bookingReply = clean(booking.result?.reply, 4000);
    const spokenBookingReply = toSpokenReply(bookingReply);
    const currentBookingStatus = conversation.bookingState?.status;
    const bookingUnavailable =
      currentBookingStatus === "human_takeover" ||
      /automatic booking (?:is )?(?:not enabled|unavailable)|unable to (?:book|confirm)/i.test(
        bookingReply,
      );

    if (currentBookingStatus === "failed" || bookingUnavailable) {
      return captureCallback({
        session,
        customerMessage: text,
        reason:
          currentBookingStatus === "failed"
            ? "voice_booking_failed"
            : "voice_booking_unavailable",
        alertType: "booking_conflict",
        seed: {
          serviceNeeded: lead?.serviceNeeded,
          customerName: lead?.customerName,
          location: lead?.address,
          preferredTime: lead?.preferredAppointmentTime,
        },
        openingPrompt:
          "I couldn’t safely confirm the appointment. I’ll preserve the details and create a priority callback instead.",
      });
    }

    if (
      booking.result?.messageCategory === "service_area_question" &&
      /outside|unsupported|not (?:in|inside)/i.test(bookingReply)
    ) {
      return captureCallback({
        session,
        customerMessage: text,
        reason: "unsupported_service_area",
        alertType: "low_ai_confidence",
        priority: "medium",
        seed: {
          serviceNeeded: lead?.serviceNeeded,
          location: conversation.bookingState?.postalCode || lead?.address,
        },
        openingPrompt:
          "That location needs manual review. I’ll create a callback request instead of making an unsupported booking.",
      });
    }

    assertVoiceTurnActive();
    await conversation.populate("bookingState.appointment");
    assertVoiceTurnActive();
    const appointmentId = conversation.bookingState?.appointment;
    let confirmationOutcome = null;
    if (
      appointmentId &&
      String(appointmentId?._id || appointmentId) !==
        String(previousAppointmentId || "") &&
      conversation.bookingState?.status === "booked"
    ) {
      const appointment = await Appointment.findById(appointmentId);
      assertVoiceTurnActive();
      if (appointment?.status === "confirmed") {
        confirmationOutcome = await recordConfirmedAppointment({
          session,
          business,
          lead,
          conversation,
          appointment,
        });
      }
    }

    const confirmationFailed =
      confirmationOutcome?.failed || confirmationOutcome?.status === "failed";
    const confirmationSuppressed =
      confirmationOutcome?.suppressed ||
      confirmationOutcome?.status === "suppressed";
    const truthfulSuffix = confirmationFailed
      ? " The appointment remains confirmed, but the confirmation text could not be sent."
      : confirmationSuppressed
        ? " The appointment remains confirmed, and no text was promised because messaging was suppressed."
        : "";

    return {
      reply: `${spokenBookingReply || "The booking step is complete."}${truthfulSuffix}`,
      ...(conversation.bookingState?.status === "booked"
        ? { outcome: "booked" }
        : {}),
    };
  }
}

export default VoiceAgentService;
