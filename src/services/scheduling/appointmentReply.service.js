import Appointment from '../../models/appointment.js';
import Notice from '../../models/appointmentNotificationJob.js';
import AlertService from '../alert.service.js';
import { scheduleAppointmentChangeNotice } from './appointmentNotification.service.js';
import { customerAppointmentLabel } from './customerAppointmentPresentation.service.js';
import { normalizePhoneToE164 } from '../../voice/voicePhone.service.js';
export const isAppointmentReply = text => /^\s*[cr]\s*$/i.test(String(text || ''));

// Reminder controls do not restart AI, change human ownership, or cancel a job.
export async function handleAppointmentReply({ business, conversation, inboundMessage, text }) {
  if (!isAppointmentReply(text) || business.isActive === false) return null;
  const phone = normalizePhoneToE164(conversation.customerPhone);
  if (!phone) return null;
  const candidates = await Appointment.find({ business: business._id, customerPhone: phone,
    status: 'confirmed', startAt: { $gt: new Date() } }).sort({ startAt: 1 }).limit(2).lean();
  if (!candidates.length) return null;
  if (candidates.length > 1) {
    await AlertService.create({ businessId: business._id, conversationId: conversation._id,
      leadId: conversation.lead, type: 'system', actionRequired: true, priority: 'high',
      title: 'Appointment reply needs clarification', message: 'The customer replied C or R but has multiple upcoming appointments. Ask which appointment they mean.',
      dedupeKey: `ambiguous-appointment-reply:${inboundMessage._id}` });
    return { handled: true, ambiguous: true };
  }
  const appointment = candidates[0];
  const priorNotice = await Notice.exists({ business: business._id, appointment: appointment._id,
    sentAt: { $ne: null }, $or: [{ type: 'reminder' }, { body: /Reply C to confirm/i }] });
  if (!priorNotice) return null;
  const confirm = text.trim().toLowerCase() === 'c';
  const updated = await Appointment.updateOne({ _id: appointment._id, business: business._id, status: 'confirmed' }, {
    $set: confirm ? { customerConfirmedAt: new Date() } : { customerRescheduleRequestedAt: new Date() },
  });
  if (!updated.matchedCount) return { handled: true, changed: true };
  if (!confirm) await AlertService.create({ businessId: business._id, conversationId: conversation._id,
    leadId: appointment.lead, type: 'system', actionRequired: true, priority: 'high',
    title: 'Customer requested another appointment time',
    message: 'Contact the customer to agree a replacement. The existing appointment remains confirmed.',
    metadata: { appointmentId: String(appointment._id) }, dedupeKey: `reminder-reschedule:${inboundMessage._id}` });
  await scheduleAppointmentChangeNotice({ appointment, key: `reply_${inboundMessage._id}`,
    body: confirm ? `Thank you. Your appointment is confirmed for ${customerAppointmentLabel(appointment)}.`
      : 'Your request to change the time has been saved for the team. Your existing appointment remains confirmed until a replacement is agreed.' });
  return { handled: true, action: confirm ? 'confirmed_attendance' : 'reschedule_requested' };
}
