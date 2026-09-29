import Alert from '../../models/alert.js';
import AppointmentNotificationJob from '../../models/appointmentNotificationJob.js';
import Business from '../../models/business.js';
import ServiceOffering from '../../models/serviceOffering.js';
import Conversation from '../../models/conversation.js';
import { scheduleAppointmentChangeNotice } from './appointmentNotification.service.js';
import { customerAppointmentLabel } from './customerAppointmentPresentation.service.js';

import { needsSeparateConfirmation } from './appointmentConfirmationState.js';
export { needsSeparateConfirmation } from './appointmentConfirmationState.js';

// The appointment's unreconciled marker is written with the confirmed decision.
// This stable outbox identity repairs a crash after that write without resending
// a notice that already has a provider receipt (or an uncertain send outcome).
export async function ensureBusinessApprovalNotice({ appointment, business, service = null }) {
  if (appointment.status !== 'confirmed' || !needsSeparateConfirmation(appointment)) return null;
  const ownerBusiness = business || await Business.findById(appointment.business).select('businessName timezone').lean();
  if (!ownerBusiness) throw new Error('Confirmation business no longer exists.');
  const offering = service || (appointment.serviceOffering?.name ? appointment.serviceOffering : await ServiceOffering.findById(appointment.serviceOffering));
  return scheduleAppointmentChangeNotice({ appointment, key: 'business_approval_confirmed',
    body: `${ownerBusiness.businessName || 'The service team'}: Confirmed — your ${offering?.name || 'service'} appointment is scheduled for ${customerAppointmentLabel(appointment, appointment.timezone || ownerBusiness.timezone)}. Reply here if you need to reschedule or cancel.`,
  });
}

export async function repairConfirmedApproval({ appointment, business }) {
  if (appointment.status !== 'confirmed') return;
  // Do not send a newly recovered confirmation for a visit that already started.
  // Existing jobs keep their identities; missing current/future notices are repaired.
  if (new Date(appointment.startAt).getTime() > Date.now()) {
    await ensureBusinessApprovalNotice({ appointment, business });
  } else if (needsSeparateConfirmation(appointment)) {
    const existing = await AppointmentNotificationJob.exists({ business: appointment.business,
      appointment: appointment._id, key: 'change_notice:business_approval_confirmed' });
    if (!existing) await Alert.updateOne({ business: appointment.business,
      dedupeKey: `appointment_confirmation_missing:${appointment._id}` }, { $setOnInsert: {
      business: appointment.business, appointment: appointment._id, conversation: appointment.conversation || null,
      lead: appointment.lead || null, type: 'integration_failure', channel: 'in_app', priority: 'high',
      status: 'sent', actionRequired: true, sentAt: new Date(),
      title: 'Appointment confirmation needs verification',
      message: 'The visit start time has passed and its confirmation was not queued. Verify the customer outcome; no stale confirmation was sent.',
      recommendedAction: 'Contact the customer and record the outcome.',
      metadata: { appointmentId: String(appointment._id), confirmationRecovery: true },
    } }, { upsert: true });
  }
  if (appointment.conversation) await Conversation.updateOne({ _id: appointment.conversation,
    business: appointment.business, 'bookingState.appointment': appointment._id,
    'bookingState.status': { $in: ['pending_business_confirmation', 'awaiting_confirmation', 'booking', 'booked'] },
  }, { $set: { 'bookingState.status': 'booked', 'bookingState.expiresAt': null, 'bookingState.lastError': '' } });
}
