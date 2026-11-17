import { assertTransition } from '../scheduling/appointmentStatePolicy.service.js';
// Named state transitions. Callers retain decision guards and side-effect order.
// Explicit capabilities preserve existing model binding, sessions, hooks and query laziness.

// src/services/scheduling/commands/cancel-1.js:61 — assignment; predicate and write options are owned here.
export function stageCanceledRescheduleRequest({ appointment }) {
  return (appointment.rescheduleRequest.status = 'canceled');
}

// src/services/scheduling/commands/cancel-1.js:64 — assignment; predicate and write options are owned here.
export function stageCanceledAppointment({ appointment }) {
  return stageAppointmentStatus(appointment, 'canceled');
}

// src/services/scheduling/commands/confirm-1.js:96 — assignment; predicate and write options are owned here.
export function stageUnavailableApproval({ appointment }) {
  return stageAppointmentStatus(appointment, 'failed');
}

// src/services/scheduling/commands/confirm-1.js:132 — assignment; predicate and write options are owned here.
export function stageFailedConfirmation({ appointment }) {
  return stageAppointmentStatus(appointment, 'failed');
}

// src/services/scheduling/commands/confirmWithoutRecovery.js:18 — assignment; predicate and write options are owned here.
export function stageProviderConfirmedAppointment({ appointment }) {
  return stageAppointmentStatus(appointment, 'confirmed');
}

// src/services/scheduling/commands/confirmWithoutRecovery.js:68 — assignment; predicate and write options are owned here.
export function stageProviderFailure({ appointment }) {
  return stageAppointmentStatus(appointment, 'failed');
}

// src/services/scheduling/commands/recheckAndConfirm-1.js:28 — findOneAndUpdate; predicate and write options are owned here.
export function reholdAppointmentForConfirmation({ Appointment, addMinutes, appointment, business, getSlotClaimKeys, getSlotKey, lane }) {
  return (Appointment.findOneAndUpdate({ _id: appointment._id, business: business._id,
            status: appointment.status, 'rescheduleIntent.key': { $exists: false }, 'confirmationIntent.status': { $ne: 'pending_provider' } }, { $set: { status: 'held', heldExpiresAt: addMinutes(new Date(), 5),
            failureReason: '', capacityLane: lane, activeSlotKey: `${getSlotKey(appointment.startAt, appointment.endAt)}|lane:${lane}`,
            slotClaimKeys: getSlotClaimKeys({ ...appointment.toObject(), capacityLane: lane }),
            'approvalRecovery.reconciled': false, 'approvalRecovery.state': 'pending',
          } }, { returnDocument: "after", runValidators: true }));
}

// src/services/scheduling/commands/update-1.js:53 — assignment; predicate and write options are owned here.
export function stageStaffAppointmentOutcome({ appointment, changes }) {
  if (!['completed', 'no_show'].includes(changes.status)) throw new TypeError('Staff outcome must be completed or no_show');
  return stageAppointmentStatus(appointment, changes.status);
}

export function stageAppointmentStatus(appointment, next) {
  if (appointment.status !== next) assertTransition(appointment.status, next);
  appointment.status = next;
  return next;
}
