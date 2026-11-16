import { rescheduleRequestEnsureRescheduleReviewAppointmentUpdateOne, rescheduleRequestResolveRescheduleReviewsAlertUpdateMany, submitRescheduleRequestAppointmentAtomicUpdate, rescheduleRequestRepairRescheduleReviewsAppointmentUpdateOne, rescheduleRequestRepairRescheduleReviewsAppointmentUpdateOne2 } from '../stateTransitions/appointmentLifecycle.js';
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
  await rescheduleRequestEnsureRescheduleReviewAppointmentUpdateOne({ Appointment, appointment, request });
}

export async function resolveRescheduleReviews(appointment, requestId = null) {
  await rescheduleRequestResolveRescheduleReviewsAlertUpdateMany({ Alert, appointment, requestId });
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
    appointment = await submitRescheduleRequestAppointmentAtomicUpdate({ Appointment, appointmentId, business, channel, crypto, endAt, startAt }).lean();
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
        await rescheduleRequestRepairRescheduleReviewsAppointmentUpdateOne({ Appointment, row });
      }
    } catch (error) {
      await rescheduleRequestRepairRescheduleReviewsAppointmentUpdateOne2({ Appointment, error, row });
    }
  }
}
