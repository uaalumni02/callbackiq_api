import { CONCRETE_SERVICE_REQUEST, GENERAL_HELP_REPLY, MAX_UNMATCHED_TURNS_BEFORE_CALLBACK, TERMINAL_BOOKING_STATUSES, captureCallback, hasCatalogServiceMatch, resetFallbackGuard } from './context.js';

export async function resolveBookingIntent(context) {
  const { bookingInProgress, bookingIntent, business, text, understanding, guard, session, bookingStatus, conversation, availabilityInquiry, lead } = context;
const catalogServiceMatched =
      !bookingInProgress && !bookingIntent
        ? await hasCatalogServiceMatch({ businessId: business._id, text })
        : false;
    const bookingRequested = bookingInProgress || bookingIntent || catalogServiceMatched;

    if (!bookingRequested) {
      if (CONCRETE_SERVICE_REQUEST.test(text) || understanding?.entities?.service) {
        resetFallbackGuard(guard);
        return { completed: true, value: captureCallback({
          session,
          customerMessage: text,
          reason: "service_not_matched",
          alertType: "low_ai_confidence",
          priority: "medium",
          seedServiceFromMessage: true,
          openingPrompt:
            "I could not confidently match that request to an automatically bookable service, but I can preserve it for the team.",
        }) };
      }

      guard.fallbackTurnCount += 1;
      if (guard.fallbackTurnCount >= MAX_UNMATCHED_TURNS_BEFORE_CALLBACK) {
        return { completed: true, value: captureCallback({
          session,
          customerMessage: text,
          reason: "low_ai_confidence",
          alertType: "low_ai_confidence",
          priority: "medium",
          openingPrompt:
            "I may not be understanding you correctly. I’ll preserve the request for a team member instead of repeating the same help message.",
        }) };
      }
      return { completed: true, value: { reply: GENERAL_HELP_REPLY } };
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
      return { completed: true, value: captureCallback({
        session,
        customerMessage: text,
        reason: "voice_booking_not_enabled",
        alertType: "human_requested",
        seedServiceFromMessage: !bookingInProgress,
        openingPrompt:
          "I can collect the service details and preferred timing so the team can follow up without losing your request.",
      }) };
    }

    if (TERMINAL_BOOKING_STATUSES.has(bookingStatus) && bookingStatus !== "booked") {
      return { completed: true, value: captureCallback({
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
      }) };
    }
  return { completed: false, context: {  } };
}
