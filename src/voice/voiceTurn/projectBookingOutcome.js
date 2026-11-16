import { saveStateDocument } from '../../services/stateTransitions/documents.js';
import { assertVoiceTurnActive, captureCallback, clean, toSpokenReply } from './context.js';
export async function projectBookingOutcome(context) {
  const { booking, lead, conversation, session, text } = context;
const capturedService = booking.result?.serviceNeeded;
    if (capturedService && capturedService !== "Unknown" && capturedService !== lead?.serviceNeeded && lead?.save) {
      assertVoiceTurnActive();
      lead.serviceNeeded = capturedService;
      await saveStateDocument(lead);
      assertVoiceTurnActive();
    }
    const bookingReply = clean(booking.result?.reply, 4000);
    const spokenBookingReply = toSpokenReply(bookingReply);
    if (booking.result?.handoff?.reason === "scheduling_review" && booking.result?.outcome === "callback_saved") {
      return { completed: true, value: { reply: spokenBookingReply, outcome: "callback_saved" } };
    }
    const currentBookingStatus = conversation.bookingState?.status;
    const bookingUnavailable =
      currentBookingStatus === "human_takeover" ||
      /automatic booking (?:is )?(?:not enabled|unavailable)|unable to (?:book|confirm)/i.test(
        bookingReply,
      );

    if (currentBookingStatus === "failed" || bookingUnavailable) {
      return { completed: true, value: captureCallback({
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
      }) };
    }

    if (
      booking.result?.messageCategory === "service_area_question" &&
      /outside|unsupported|not (?:in|inside)/i.test(bookingReply)
    ) {
      return { completed: true, value: captureCallback({
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
      }) };
    }
  return { completed: false, context: { spokenBookingReply } };
}
