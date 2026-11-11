import { BookingStateMachineService, assertVoiceTurnActive, captureCallback, isTransientDependencyError, logOperationalError } from './context.js';

export async function executeBooking(context) {
  const { conversation, business, lead, text, session, signal, bookingInProgress } = context;
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
      return { completed: true, value: captureCallback({
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
      }) };
    }

    if (!booking?.handled) {
      return { completed: true, value: captureCallback({
        session,
        customerMessage: text,
        reason: "low_ai_confidence",
        alertType: "low_ai_confidence",
        seedServiceFromMessage: !bookingInProgress,
        openingPrompt:
          "I want to make sure the team receives accurate information. I’ll create a callback request instead of making an uncertain booking.",
      }) };
    }
  return { completed: false, context: { previousAppointmentId, booking } };
}
