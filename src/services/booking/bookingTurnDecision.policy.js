// Stage 4B: pure booking-entry decisions. This module deliberately has no persistence,
// provider, transport, or clock access. Side effects remain in BookingStateMachineService.
export const createBookingTurnContext = ({ business, customerMessage, channel = 'sms', source = 'booking_state_machine' }) => {
  const bookingChannel = channel === 'voice' ? 'voice' : 'sms';
  return {
    bookingChannel,
    bookingSource: String(source || 'booking_state_machine'),
    bookingIdempotencyPrefix: bookingChannel === 'voice' ? 'voice-' : '',
    bookingEventPrefix: bookingChannel === 'voice' ? 'voice:' : '',
    enabled: Boolean(business?.features?.aiBookingEnabled),
    text: String(customerMessage || '').trim(),
  };
};

export const isBookingTurnBlocked = (conversation) =>
  Boolean(conversation?.humanTakeover || ['closed', 'archived'].includes(conversation?.status));

// Rejection does not authorize a new appointment or change an existing one.
// This is the decision only. Updating lead preferences, resetting the offered slots,
// and issuing a customer reply remain sequenced by the existing service.
export const planRejectedBookingPreference = ({ evidence, acceptedTime, hasReplacementDate, enabled, hasExistingAppointment }) => {
  const rejected = (evidence.rejectedDate && !hasReplacementDate) ||
    (evidence.rejectedTime && acceptedTime.targetMinutes === null && !acceptedTime.timeOfDay);
  if (!rejected) return null;
  return {
    updateRequestedPreference: !hasExistingAppointment,
    event: 'preference_rejected',
    details: { enabled },
    reply: `What day and time would work instead?${hasExistingAppointment ? ' Your existing appointment has not been changed.' : ' No appointment is confirmed.'}`,
    category: 'appointment_preference',
  };
};
