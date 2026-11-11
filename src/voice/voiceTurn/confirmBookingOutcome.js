import { Appointment, assertVoiceTurnActive, recordConfirmedAppointment } from './context.js';

export async function confirmBookingOutcome(context) {
  const { conversation, session, spokenBookingReply, previousAppointmentId, business, lead } = context;
assertVoiceTurnActive();
    await conversation.populate("bookingState.appointment");
    assertVoiceTurnActive();
    const appointmentId = conversation.bookingState?.appointment;
    if (appointmentId && conversation.bookingState?.status === 'pending_business_confirmation') {
      session.metadata = { ...(session.metadata || {}),
        bookingRequestSubmittedAt: new Date().toISOString(),
        requestedAppointmentId: String(appointmentId._id || appointmentId),
      };
      session.markModified?.('metadata');
      assertVoiceTurnActive();
      await session.save();
      assertVoiceTurnActive();
      return { completed: true, value: { reply: spokenBookingReply, outcome: 'appointment_requested' } };
    }
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

    return { completed: true, value: {
      reply: `${spokenBookingReply || "The booking step is complete."}${truthfulSuffix}`,
      ...(conversation.bookingState?.status === "booked"
        ? { outcome: "booked" }
        : {}),
    } };
}
