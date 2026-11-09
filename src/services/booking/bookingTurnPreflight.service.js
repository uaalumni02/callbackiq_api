import { fixedResult } from './bookingFixedResult.policy.js';
import { planRejectedBookingPreference } from './bookingTurnDecision.policy.js';
import { hasBookingAvailabilityHint, EXACT_PRICE } from './bookingMessagePolicy.service.js';
import { schedulingEvidence } from './schedulingEvidence.service.js';
import { handleConversationControl } from '../conversationControl.service.js';
import { getApprovedServiceEstimate } from './approvedServiceEstimate.service.js';
import { guardServiceRequest } from '../serviceEligibility/serviceEligibility.service.js';
import { schedulingQuestionReply } from "./schedulingQuestions.service.js";
import { bookingQuestionReply } from "./conversationQuestions.service.js";
import { buildBusinessReadiness } from "../businessReadiness.service.js";
import { assertVoiceTurnActive } from "../voiceTurnContext.service.js";
import { assertDistributedLeaseActive } from "../distributedLease.service.js";
import escalateToHumanTool from "../../helpers/ai/tools/escalateToHuman.tool.js";
import { findDateRange, parseTimePreference } from "./appointmentPreferenceParser.service.js";
import { updateState } from "./bookingTurnState.repository.js";
import { bookingInquiryOperations } from "./bookingInquiryRuntime.js";
const { handleBookingReadinessFailure } = bookingInquiryOperations;

async function routeBookingControl({ business, lead, conversation, customerMessage, channel, text }) {
  const control = await handleConversationControl({ business, lead, conversation, customerMessage, channel });
  if (control) return { handled: true, result: control };
  const serviceGuard = await guardServiceRequest({ business, lead, conversation, customerMessage, channel });
  if (serviceGuard) return { handled: true, result: serviceGuard };
  const schedulingReply = schedulingQuestionReply({ customerMessage: text, business, lead });
  if (schedulingReply) return { handled: true, result: fixedResult({ reply: schedulingReply, category: "availability_inquiry" }) };

  const questionReply = bookingQuestionReply({ customerMessage: text, conversation, lead, channel });
  if (questionReply) return { handled: true, result: fixedResult({ reply: questionReply, category: "appointment_status" }) };
}

async function routeRejectedPreference({ business, lead, conversation, text, enabled }) {
  const evidence = schedulingEvidence(text);
  const timezone = business.timezone || 'America/New_York';
  const acceptedTime = parseTimePreference(text, timezone);
  const preferenceRejection = planRejectedBookingPreference({
    evidence, acceptedTime, hasReplacementDate: evidence.rejectedDate ? Boolean(findDateRange(text, timezone)) : false,
    enabled, hasExistingAppointment: Boolean(conversation?.bookingState?.appointment),
  });
  if (preferenceRejection) {
    // Rejected proposals must not remain selectable on the next "yes".
    if (lead?.save && preferenceRejection.updateRequestedPreference) {
      const range = findDateRange(evidence.rejectedDate ? text : lead.preferredAppointmentTime, timezone);
      const time = evidence.rejectedTime ? acceptedTime : parseTimePreference(lead.preferredAppointmentTime, timezone);
      const day = range ? range.startDate === range.endDate ? range.startDate : `${range.startDate} through ${range.endDate}` : '';
      const clock = time.exactMinutes !== null ? `${Math.floor(time.exactMinutes / 60)}:${String(time.exactMinutes % 60).padStart(2, '0')}`
        : time.targetMinutes !== null || time.timeOfDay ? time.raw : '';
      assertVoiceTurnActive(); assertDistributedLeaseActive();
      lead.preferredAppointmentTime = [day, clock].filter(Boolean).join(' at ');
      await lead.save();
    }
    if (conversation?.set && preferenceRejection.updateRequestedPreference) {
      await updateState(conversation, preferenceRejection.statePatch);
    }
    return { handled: true, result: fixedResult({
      reply: preferenceRejection.reply, category: preferenceRejection.category,
    }) };
  }
}

export async function routeBookingPreflight(context) {
  return (await routeBookingControl(context)) || routeRejectedPreference(context);
}

export async function checkBookingReadiness({ business, lead, activeConversation, text, bookingChannel, currentStatus, smsIntent }) {
  const stateActive = currentStatus !== 'not_started';
  if (
    !stateActive &&
    bookingChannel !== "voice" &&
    !smsIntent.intents.scheduling &&
    !hasBookingAvailabilityHint(text, business.timezone || "America/New_York")
  ) {
    return { handled: false };
  }

  if (smsIntent.intents.human) {
    await escalateToHumanTool({
      businessId: business._id,
      leadId: lead?._id,
      conversationId: activeConversation._id,
      reason: "customer_requested_human",
      customerMessage: text,
    });

    return {
      handled: true,
      result: fixedResult({
        reply:
          "I’ve paused the automated booking and alerted the team. A person will follow up directly.",
        category: "human_requested",
      }),
    };
  }

  if (
    smsIntent.intents.pricing &&
    !smsIntent.intents.availabilityInquiry
  ) {
    const approvedEstimate = await getApprovedServiceEstimate({ businessId: business._id, serviceNeeded: lead?.serviceNeeded, customerMessage: text });

    return {
      handled: true,
      result: fixedResult({
        reply:
          approvedEstimate ||
          (EXACT_PRICE.test(text)
            ? "I can help schedule the visit, but the team must confirm final scope and pricing after reviewing the job."
            : "I don’t have a business-approved price range for that service, so I don’t want to guess. I can still help schedule a visit so the team can assess the job and confirm pricing."),
        category: "pricing_request",
      }),
    };
  }

  // CALLBACKIQ_BOOKING_RECOVERY_FIX_V2: feature flag alone is insufficient; booking must be operationally ready now.
  let runtimeReadiness;
  try {
    runtimeReadiness = await buildBusinessReadiness(business, {
      persist: false,
    });
  } catch (error) {
    return handleBookingReadinessFailure({
      business,
      lead,
      conversation: activeConversation,
      error,
      customerMessage: text,
    });
  }

  if (!runtimeReadiness?.states?.bookingReady) {
    return handleBookingReadinessFailure({
      business,
      lead,
      conversation: activeConversation,
      readiness: runtimeReadiness,
      customerMessage: text,
    });
  }
}
