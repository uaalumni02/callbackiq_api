import { ACTIVE_BOOKING_STATUSES, COMPLAINT_OR_DISPUTE, captureCallback, isBookingIntent, isHumanRequest, isVoiceAvailabilityInquiry, recordPilotMetric, resetFallbackGuard } from './context.js';

export async function routeHumanRequest(context) {
  const { conversation, text, guard, session } = context;
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
      // Small businesses use MeekCall when the team cannot answer. Never
      // place another live call after AI answers. Preserve the ongoing intake,
      // submit a staff-review callback and make no timing commitment.
      return { completed: true, value: captureCallback({
        session,
        customerMessage: text,
        reason: "customer_requested_human",
        alertType: "human_requested",
        priority: "high",
        seedServiceFromMessage: true,
        openingPrompt:
          "I can help capture your request for the team. I cannot connect a live staff member, but I can save the details for a callback. What should I tell them?",
      }) };
    }

    if (!bookingInProgress && COMPLAINT_OR_DISPUTE.test(text)) {
      resetFallbackGuard(guard);
      return { completed: true, value: captureCallback({
        session,
        customerMessage: text,
        reason: "complaint_or_dispute",
        alertType: "angry_customer",
        priority: "high",
        seed: { serviceNeeded: "Complaint, refund, or account dispute" },
        openingPrompt:
          "I’m sorry you’re dealing with that. I won’t route you back to an unanswered line; I’ll create a priority callback for a team member.",
      }) };
    }
  return { completed: false, context: { bookingStatus, bookingInProgress, availabilityInquiry, bookingIntent } };
}
