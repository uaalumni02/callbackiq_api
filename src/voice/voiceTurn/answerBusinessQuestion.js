import { COMMERCIAL, COMPLEX_PRICING, DIAGNOSTIC_FEE, EXISTING_JOB, VoiceAvailabilityService, VoiceExistingJobStatusService, VoiceServiceAreaService, WARRANTY, captureCallback, extractPostalCode, getDiagnosticFeeReply, isBusinessHoursQuestion, isServiceAreaQuestion, resetFallbackGuard } from './context.js';

export async function answerBusinessQuestion(context) {
  const { bookingInProgress, text, guard, business, session, lead, understanding } = context;
if (!bookingInProgress && EXISTING_JOB.test(text)) {
      resetFallbackGuard(guard);
      const status = await VoiceExistingJobStatusService.lookupExistingVoiceAppointment({ businessId: business._id, callerPhone: session.from || lead?.phone });
      return { completed: true, value: captureCallback({ session, customerMessage: text, reason: "existing_job_status", alertType: "human_requested", priority: "high", seed: { serviceNeeded: "Existing job or technician status", customerName: understanding?.entities?.name, location: understanding?.entities?.location || understanding?.entities?.city || understanding?.entities?.postalCode, urgency: understanding?.entities?.urgency, preferredTime: understanding?.entities?.preference }, openingPrompt: status.reply || "I can’t verify the technician’s live status, so I’ll flag this for priority team review rather than guess. I can’t guarantee a callback time." }) };
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
      return { completed: true, value: captureCallback({
        session,
        customerMessage: text,
        reason,
        alertType: "human_requested",
        seed: { serviceNeeded },
        openingPrompt:
          "That needs direct team review. I’ll collect and confirm a callback request instead of making an automated commitment.",
      }) };
    }

    if (!bookingInProgress && COMPLEX_PRICING.test(text)) {
      resetFallbackGuard(guard);
      return { completed: true, value: captureCallback({
        session,
        customerMessage: text,
        reason: "complex_pricing",
        alertType: "human_requested",
        seed: { serviceNeeded: "Binding quote or complex pricing request" },
        openingPrompt:
          "I can’t provide a binding quote, but I can collect the details for a pricing callback.",
      }) };
    }

    if (!bookingInProgress && (understanding?.intent === "hours" || isBusinessHoursQuestion(text))) {
      resetFallbackGuard(guard);
      return { completed: true, value: { reply: await VoiceAvailabilityService.describeBusinessHours(business), outcome: "direct_answer_resolved" } };
    }

    if (!bookingInProgress && (understanding?.intent === "service_area" || isServiceAreaQuestion(text))) {
      resetFallbackGuard(guard);
      const entities = understanding?.entities || {};
      const area = await VoiceServiceAreaService.checkVoiceServiceArea({ business, location: entities.location || text, city: entities.city, postalCode: entities.postalCode || extractPostalCode(text) });
      if (area.supported === true) return { completed: true, value: { reply: `Yes, ${area.postalCode || area.city || "that location"} is in the verified service area. Would you like to schedule a visit or create a callback request?`, outcome: "direct_answer_resolved" } };
      return { completed: true, value: captureCallback({ session, customerMessage: text, reason: "unverified_service_area", alertType: "low_ai_confidence", priority: "medium", seed: { location: entities.location || entities.city || entities.postalCode || text }, openingPrompt: "I can’t verify that location automatically, but I’ll flag it for team review. I can’t guarantee when someone will be available to call." }) };
    }

    if (!bookingInProgress && DIAGNOSTIC_FEE.test(text)) {
      resetFallbackGuard(guard);
      return { completed: true, value: { reply: await getDiagnosticFeeReply({ business, text }), outcome: "direct_answer_resolved" } };
    }
  return { completed: false, context: {  } };
}
