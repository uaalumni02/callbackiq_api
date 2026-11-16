// Named state transitions. Callers retain decision guards and side-effect order.
// Explicit capabilities preserve existing model binding, sessions, hooks and query laziness.

// src/services/booking/existingBookingTurn.service.js:100 — updateOne; predicate and write options are owned here.
export function recordCustomerRescheduleRequest({ Appointment, appointmentId, business }) {
  return (Appointment.updateOne(
        { _id: appointmentId, business: business._id },
        { $set: { customerRescheduleRequestedAt: new Date() } },
      ));
}

// src/services/booking/existingBookingTurn.service.js:118 — findOneAndUpdate; predicate and write options are owned here.
export function recordCustomerAppointmentAcknowledgement({ Appointment, appointmentId, business }) {
  return (Appointment.findOneAndUpdate(
        {
          _id: appointmentId,
          business: business._id,
          status: "confirmed",
        },
        {
          $set: { customerConfirmedAt: new Date() },
        },
        { returnDocument: "after" },
      ));
}

// src/services/booking/intakeReview.service.js:119 — updateOne; predicate and write options are owned here.
export function persistReviewedLeadName({ Lead, business, customerName, lead }) {
  return (Lead.updateOne({ _id: lead._id, business: business._id, customerName: lead.customerName ?? null },
      { $set: { customerName } }));
}

// src/services/booking/intakeReview.service.js:121 — updateOne; predicate and write options are owned here.
export function persistReviewedConversationName({ Conversation, business, conversation, customerName }) {
  return (Conversation.updateOne({ _id: conversation._id, business: business._id, customerName: conversation.customerName ?? null },
      { $set: { customerName } }));
}

// src/services/booking/recoveryIntake/captureRequestFacts.js:22 — assignment; predicate and write options are owned here.
export function invalidateIntakeAvailability({ conversation }) {
  return (conversation.conversationMemory.recoveryIntake.availability = { status: 'unknown' });
}

// src/services/booking/recoveryIntake/captureRequestFacts.js:23 — assignment; predicate and write options are owned here.
export function reopenIntakeSubmission({ conversation }) {
  return (conversation.conversationMemory.recoveryIntake.submitted = false);
}

// src/services/booking/staffSchedulingReview.service.js:38 — assignment; predicate and write options are owned here.
export function stageVoiceSchedulingReview({ conversation, now }) {
  return (conversation.orchestration = { ...(conversation.orchestration?.toObject?.() || conversation.orchestration || {}),
        phase: 'handoff_pending', handoffStatus: 'pending_ack', handoffReason: 'scheduling_review',
        handoffRequestedAt: now, handoffAcknowledgedAt: null });
}
