import crypto from 'node:crypto';
import Appointment from '../../models/appointment.js';
import Alert from '../../models/alert.js';
import AlertService from '../alert.service.js';
import SocketService from '../socket.service.js';
import { customerAppointmentLabel } from './customerAppointmentPresentation.service.js';

const conflict = message => Object.assign(new Error(message), { statusCode: 409 });

export async function ensureRescheduleReview(appointment) {
  const request = appointment.rescheduleRequest;
  if (appointment.status !== 'confirmed' || request?.status !== 'pending') return;
  const saved = await AlertService.create({ businessId: appointment.business,
    appointmentId: appointment._id, leadId: appointment.lead, conversationId: appointment.conversation,
    type: 'appointment_change_review', priority: 'high', actionRequired: true,
    title: 'Customer requested a new appointment time',
    message: `Requested: ${customerAppointmentLabel({ ...appointment, startAt: request.startAt, endAt: request.endAt, arrivalStartAt: null, arrivalEndAt: null })}. The existing appointment remains confirmed.`,
    recommendedAction: 'Open Appointments to approve the requested time or keep the existing appointment and notify the customer.',
    metadata: { approvalRequest: true, rescheduleRequest: true, approvalState: 'pending',
      appointmentId: String(appointment._id), requestId: request.id,
      requestedStartAt: request.startAt, requestedEndAt: request.endAt },
    dedupeKey: `appointment-reschedule:${appointment._id}:${request.id}` });
  if (!saved?.alert?._id) throw new Error('Reschedule review could not be saved.');
  const latest = await Appointment.findOne({ _id: appointment._id, business: appointment.business }).lean();
  if (latest?.status !== 'confirmed' || latest.rescheduleRequest?.id !== request.id || latest.rescheduleRequest?.status !== 'pending') {
    await resolveRescheduleReviews(appointment, request.id);
  }
  await Appointment.updateOne({ _id: appointment._id, 'rescheduleRequest.id': request.id },
    { $set: { 'rescheduleRequest.alertPending': false } });
}

export async function resolveRescheduleReviews(appointment, requestId = null) {
  await Alert.updateMany({ business: appointment.business, appointment: appointment._id,
    'metadata.rescheduleRequest': true, ...(requestId ? { 'metadata.requestId': requestId } : {}), resolvedAt: null },
  { $set: { resolvedAt: new Date(), status: 'resolved', actionRequired: false, resolution: 'Appointment change reviewed' } });
}

export async function submitRescheduleRequest({ business, appointmentId, conversationId, startAt, endAt, channel }) {
  if (!Number.isFinite(Date.parse(startAt)) || Date.parse(startAt) <= Date.now() || Date.parse(endAt) <= Date.parse(startAt) || !Number.isFinite(Date.parse(endAt))) {
    throw conflict('Choose a future replacement time.');
  }
  let appointment = await Appointment.findOne({ _id: appointmentId, business: business._id, conversation: conversationId }).lean();
  if (!appointment || appointment.status !== 'confirmed') throw conflict('Reload the current appointment before requesting a change.');
  const prior = appointment.rescheduleRequest;
  if (prior?.status === 'pending' && (+new Date(prior.startAt) !== +new Date(startAt) || +new Date(prior.endAt) !== +new Date(endAt))) {
    throw conflict('A different change request is already awaiting review. Contact the team to update it.');
  }
  if (prior?.status !== 'pending') {
    appointment = await Appointment.findOneAndUpdate({ _id: appointmentId, business: business._id,
      status: 'confirmed', 'rescheduleRequest.status': { $ne: 'pending' } }, { $set: {
      customerRescheduleRequestedAt: new Date(), rescheduleRequest: { id: crypto.randomUUID(), status: 'pending',
        startAt, endAt, channel, requestedAt: new Date(), alertPending: true },
    } }, { new: true, runValidators: true }).lean();
    if (!appointment) throw conflict('The request changed. Please try again.');
  }
  // The request itself is durable and visible in Appointments even if alerting
  // fails. Leave its repair marker set and do not claim successful submission.
  await ensureRescheduleReview(appointment);
  SocketService.emitToBusiness(business._id, 'appointment:updated', appointment);
  return appointment;
}

export async function repairRescheduleReviews({ businessId = null, limit = 100 } = {}) {
  const rows = await Appointment.find({ 'rescheduleRequest.alertPending': true, ...(businessId ? { business: businessId } : {}) }).sort({ updatedAt: 1 }).limit(limit).lean();
  for (const row of rows) {
    try {
      if (row.status === 'confirmed' && row.rescheduleRequest?.status === 'pending') await ensureRescheduleReview(row);
      else {
        await resolveRescheduleReviews(row);
        await Appointment.updateOne({ _id: row._id, 'rescheduleRequest.id': row.rescheduleRequest.id }, { $set: { 'rescheduleRequest.alertPending': false } });
      }
    } catch (error) {
      await Appointment.updateOne({ _id: row._id, 'rescheduleRequest.id': row.rescheduleRequest.id }, { $set: { 'rescheduleRequest.lastError': String(error.message).slice(0, 300) } });
    }
  }
}
