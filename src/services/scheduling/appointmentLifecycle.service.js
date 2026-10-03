import Appointment from '../../models/appointment.js';
import Business from '../../models/business.js';
import Conversation from '../../models/conversation.js';
import Lead from '../../models/lead.js';
import { customerAppointmentLabel } from './customerAppointmentPresentation.service.js';
import { scheduleAppointmentChangeNotice, cancelAppointmentNotifications, scheduleAppointmentReminders } from './appointmentNotification.service.js';
import { resolveRescheduleReviews } from './rescheduleRequest.service.js';

export const lifecycleMarker = key => ({ key: `lifecycle_${key}`, pending: true, lastError: '' });

export function lifecycleMessage(appointment, business) {
  const name = business.businessName || 'The service team';
  const time = customerAppointmentLabel(appointment, appointment.timezone || business.timezone);
  const key = appointment.lifecycleNotice?.key || '';
  if (key === 'lifecycle_canceled') return `${name}: Your appointment for ${time} has been canceled. Reply here if you need help arranging another visit.`;
  if (key === 'lifecycle_declined') return `${name}: We couldn't confirm ${time}. Reply with another day or time and we'll help find another option.`;
  if (key.startsWith('lifecycle_change_declined_')) return `${name}: We couldn't approve your requested change. Your existing appointment remains confirmed for ${time}. Reply here to discuss another time.`;
  if (key === 'lifecycle_rescheduled') return `${name}: Your appointment has been rescheduled and is confirmed for ${time}. This replaces your previous appointment time. Reply here if you need help.`;
  return `${name}: Your appointment is confirmed for ${time}. Reply here if you need to reschedule or cancel.`;
}

// Written with the appointment decision. Repair is idempotent, scoped to the
// current event, and never guesses that an old appointment needs a new SMS.
export async function repairAppointmentLifecycle(appointment, business = null) {
  const marker = appointment.lifecycleNotice;
  if (!marker?.pending) return;
  const ownerBusiness = business || await Business.findById(appointment.business).lean();
  if (!ownerBusiness) throw new Error('Appointment business is missing.');
  const key = marker.key;
  const filter = { _id: appointment._id, business: appointment.business, status: appointment.status, 'lifecycleNotice.key': key };
  const expectedStatus = key === 'lifecycle_canceled' ? 'canceled' : key === 'lifecycle_declined' ? 'failed' : 'confirmed';
  if (appointment.status !== expectedStatus) {
    await Appointment.updateOne(filter, { $set: { 'lifecycleNotice.pending': false, 'lifecycleNotice.lastError': 'Superseded by appointment state.' } });
    return;
  }
  if (key === 'lifecycle_confirmed' && appointment.conversation) {
    await Conversation.updateOne({ _id: appointment.conversation, business: appointment.business,
      $or: [{ 'bookingState.appointment': null }, { 'bookingState.appointment': appointment._id }] },
    { $set: { 'bookingState.appointment': appointment._id, 'bookingState.status': 'booked', 'bookingState.expiresAt': null, 'bookingState.lastError': '' } });
  }
  if (key === 'lifecycle_rescheduled' && appointment.rescheduledFrom) {
    const original = await Appointment.findOne({ _id: appointment.rescheduledFrom, business: appointment.business }).lean();
    if (!original || (original.status !== 'rescheduled' && original.status !== 'confirmed')) throw new Error('Original appointment requires reconciliation.');
    if (original.status === 'rescheduled' && String(original.rescheduledTo) !== String(appointment._id)) throw new Error('Conflicting replacement appointment.');
    await Appointment.updateOne({ _id: original._id, business: appointment.business, status: 'confirmed' }, { $set: {
      status: 'rescheduled', rescheduledTo: appointment._id, activeSlotKey: null, slotClaimKeys: [], capacityLane: null,
      externalAppointmentId: null, externalCalendarId: null,
      ...(original.rescheduleRequest?.status === 'pending' ? { 'rescheduleRequest.status': 'approved', 'rescheduleRequest.decidedAt': new Date(), 'rescheduleRequest.alertPending': true } : {}),
    } });
    await cancelAppointmentNotifications({ businessId: appointment.business, appointmentId: original._id });
    await resolveRescheduleReviews(original);
    if (appointment.conversation) await Conversation.updateOne({ _id: appointment.conversation, business: appointment.business,
      'bookingState.appointment': original._id }, { $set: { 'bookingState.appointment': appointment._id,
      'bookingState.status': 'booked', 'bookingState.lastError': '', 'bookingState.expiresAt': null,
      'bookingState.selectedSlot': null, 'bookingState.offeredSlots': [],
    } });
    if (appointment.lead) await Lead.updateOne({ _id: appointment.lead, business: appointment.business, appointment: original._id },
      { $set: { appointment: appointment._id, bookedAt: appointment.confirmedAt } });
    await scheduleAppointmentReminders({ appointment });
  }
  if (['lifecycle_canceled', 'lifecycle_declined'].includes(key)) {
    await cancelAppointmentNotifications({ businessId: appointment.business, appointmentId: appointment._id, types: ['reminder', 'follow_up'] });
    await resolveRescheduleReviews(appointment);
    if (appointment.lead) await Lead.updateOne({ _id: appointment.lead, business: appointment.business, appointment: appointment._id }, { $set: { appointment: null } });
    if (appointment.conversation) await Conversation.updateOne({ _id: appointment.conversation, business: appointment.business,
      'bookingState.appointment': appointment._id }, { $set: { 'bookingState.status': 'not_started',
      'bookingState.appointment': null, 'bookingState.selectedSlot': null, 'bookingState.offeredSlots': [],
      'bookingState.expiresAt': null, 'bookingState.lastError': key === 'lifecycle_declined' ? 'business_declined' : '',
    } });
  }
  if (key.startsWith('lifecycle_change_declined_')) await resolveRescheduleReviews(appointment, key.slice('lifecycle_change_declined_'.length));
  await scheduleAppointmentChangeNotice({ appointment, key, body: lifecycleMessage(appointment, ownerBusiness) });
  await Appointment.updateOne(filter, { $set: { 'lifecycleNotice.pending': false, 'lifecycleNotice.lastError': '' } });
}

export async function tryRepairAppointmentLifecycle(appointment, business) {
  try { await repairAppointmentLifecycle(appointment, business); }
  catch (error) {
    // Report pending evidence in the API; maintenance retries the saved marker.
    try { await Appointment.updateOne({ _id: appointment._id, 'lifecycleNotice.key': appointment.lifecycleNotice?.key },
      { $set: { 'lifecycleNotice.lastError': String(error.message).slice(0, 300) } }); } catch { /* Keep the original marker. */ }
  }
}

export async function repairPendingAppointmentLifecycles({ businessId = null, limit = 100 } = {}) {
  const rows = await Appointment.find({ 'lifecycleNotice.pending': true, ...(businessId ? { business: businessId } : {}) }).sort({ updatedAt: 1 }).limit(limit).lean();
  for (const row of rows) await tryRepairAppointmentLifecycle(row);
}

export async function declineRescheduleRequest({ business, appointmentId, requestId, reason = '' }) {
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(requestId)) throw Object.assign(new Error('Reload the request before declining.'), { statusCode: 409 });
  let appointment = await Appointment.findOneAndUpdate({ _id: appointmentId, business: business._id, status: 'confirmed',
    'rescheduleRequest.id': requestId, 'rescheduleRequest.status': 'pending' }, { $set: {
    'rescheduleRequest.status': 'declined', 'rescheduleRequest.decidedAt': new Date(), 'rescheduleRequest.reason': String(reason).slice(0, 500),
    'rescheduleRequest.alertPending': true, lifecycleNotice: lifecycleMarker(`change_declined_${requestId}`),
  } }, { new: true });
  if (!appointment) appointment = await Appointment.findOne({ _id: appointmentId, business: business._id, status: 'confirmed',
    'rescheduleRequest.id': requestId, 'rescheduleRequest.status': 'declined' });
  if (!appointment) throw Object.assign(new Error('The request changed. Reload it before deciding.'), { statusCode: 409 });
  await tryRepairAppointmentLifecycle(appointment, business);
  return appointment;
}
