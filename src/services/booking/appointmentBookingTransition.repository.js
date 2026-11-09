import { bookingStateFields } from './requestBookingState.js';

const linked = id => ({ 'bookingState.appointment': id });
const linkedOrUnassigned = id => ({ 'bookingState.appointment': { $in: [id, null] } });
const keepNewerReschedule = {
  'bookingState.lastError': { $nin: ['reschedule_requested', 'reschedule_pending_business_approval'] },
};
const confirmed = appointment => ({
  appointment: appointment._id, status: 'booked', expiresAt: null, lastError: '',
});
const released = lastError => ({
  appointment: null, status: 'not_started', selectedSlot: null, offeredSlots: [], expiresAt: null, lastError,
});

const transitions = new Map([
  ['appointment_confirmed', {
    statuses: ['confirmed'],
    filter: appointment => ({ ...linkedOrUnassigned(appointment._id), ...keepNewerReschedule }),
    fields: confirmed,
  }],
  ['confirmation_recovered', {
    statuses: ['confirmed'],
    filter: appointment => ({ ...linked(appointment._id), ...keepNewerReschedule }),
    fields: confirmed,
  }],
  ['intake_reservation_linked', {
    statuses: ['held', 'confirmed'],
    filter: appointment => linkedOrUnassigned(appointment._id),
    fields: appointment => ({
      appointment: appointment._id,
      status: appointment.status === 'confirmed' ? 'booked' : 'pending_business_confirmation',
    }),
    conversationFields: appointment => ({
      'conversationMemory.recoveryIntake.reviewAppointmentId': String(appointment._id),
    }),
  }],
  ['intake_confirmed', {
    statuses: ['confirmed'],
    filter: appointment => linked(appointment._id),
    fields: confirmed,
    conversationFields: (appointment, { approvedBy, qualificationReview }) => ({
      'conversationMemory.recoveryIntake.appointmentId': String(appointment._id),
      'conversationMemory.recoveryIntake.approvedAt': appointment.approvalDecisionAt || new Date(),
      'conversationMemory.recoveryIntake.approvedBy': approvedBy,
      ...(qualificationReview ? { 'conversationMemory.recoveryIntake.qualificationReview': qualificationReview } : {}),
    }),
  }],
  ['approval_repaired', {
    statuses: ['confirmed'],
    filter: appointment => ({
      ...linked(appointment._id), ...keepNewerReschedule,
      'bookingState.status': { $in: ['pending_business_confirmation', 'awaiting_confirmation', 'booking', 'booked'] },
    }),
    fields: () => ({ status: 'booked', expiresAt: null, lastError: '' }),
  }],
  ['approval_hold_expired', {
    statuses: ['failed'],
    filter: appointment => ({ ...linked(appointment._id), 'bookingState.status': { $ne: 'booked' } }),
    fields: () => ({ status: 'pending_business_confirmation', expiresAt: null, lastError: 'approval_needs_recheck' }),
  }],
  ['appointment_rescheduled', {
    statuses: ['confirmed'],
    filter: appointment => appointment.rescheduledFrom && linked(appointment.rescheduledFrom),
    fields: appointment => ({ ...confirmed(appointment), selectedSlot: null, offeredSlots: [] }),
  }],
  ['appointment_canceled', {
    statuses: ['canceled'],
    filter: appointment => linked(appointment._id),
    fields: () => released(''),
  }],
  ['appointment_declined', {
    statuses: ['failed'],
    filter: appointment => linked(appointment._id),
    fields: () => released('business_declined'),
  }],
]);

// The appointment is the durable decision. An atomic conversation update only
// projects that decision while the expected appointment still owns the link.
export async function applyAppointmentBookingTransition(Conversation, event, appointment, details = {}) {
  const transition = transitions.get(event);
  if (!transition) throw new TypeError(`Unknown appointment booking transition: ${event}`);
  if (!appointment._id || !appointment.business || !appointment.conversation ||
      !transition.statuses.includes(appointment.status)) return null;
  const filter = transition.filter(appointment);
  if (!filter) return null;
  return Conversation.updateOne(
    { _id: appointment.conversation, business: appointment.business, ...filter },
    { $set: {
      ...bookingStateFields(transition.fields(appointment)),
      ...transition.conversationFields?.(appointment, details),
    } },
  );
}
