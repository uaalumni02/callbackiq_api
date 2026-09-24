import Appointment from '../../models/appointment.js';
import Alert from '../../models/alert.js';
import Business from '../../models/business.js';
import Conversation from '../../models/conversation.js';
import SocketService from '../socket.service.js';
import { scheduleAppointmentChangeNotice } from './appointmentNotification.service.js';

// The appointment is a capacity reservation; this review survives its expiry.
// All writes have stable identities so maintenance can repair interrupted work.
export async function ensureApprovalReview(appointment, { expired = false } = {}) {
  const business = await Business.findById(appointment.business).select('owner businessName').lean();
  if (!business) throw new Error('Approval business no longer exists.');
  const dueAt = expired ? new Date() : new Date(Math.min(
    new Date(appointment.heldExpiresAt).getTime(), Date.now() + 15 * 60_000));
  const alert = await Alert.findOneAndUpdate({ business: appointment.business,
    dedupeKey: `appointment_approval_required:${appointment._id}` }, {
    $setOnInsert: { type: 'system', channel: 'in_app', status: 'sent', sentAt: new Date(),
      priority: 'medium', assignedTo: business.owner, assignedAt: new Date(),
      'metadata.approvalRequest': true },
    $set: { actionRequired: true, appointment: appointment._id,
      lead: appointment.lead || null, conversation: appointment.conversation || null,
      title: expired ? 'Appointment request needs an availability recheck' : 'Appointment approval required',
      message: expired ? 'The temporary reservation expired. The customer request remains open; check availability before approving.'
        : 'The customer selected a time. Approve or decline this request before its temporary reservation expires.',
      recommendedAction: expired ? 'Recheck the requested time or contact the customer to agree another time.' : 'Review and approve the customer’s selected time.',
      'metadata.appointmentId': String(appointment._id),
      'metadata.approvalState': expired ? 'needs_recheck' : 'pending',
      ...(expired ? { dueAt, resolvedAt: null, acknowledgedAt: null } : {}),
    },
  }, { upsert: true, new: true });
  // Preserve an existing deadline and assignment while repairing legacy reviews.
  await Alert.updateOne({ _id: alert._id, dueAt: null }, { $set: { dueAt } });
  await Alert.updateOne({ _id: alert._id, assignedTo: null }, { $set: { assignedTo: business.owner, assignedAt: new Date() } });
  await Alert.updateOne({ _id: alert._id }, { $set: { 'metadata.approvalRequest': true } });
  SocketService.emitAlertUpdated(appointment.business, alert);
  return alert;
}

export async function reconcileApprovalRequests({ businessId = null, limit = 100 } = {}) {
  const appointments = await Appointment.find({ requiresBusinessApproval: true,
    ...(businessId ? { business: businessId } : {}),
    $or: [{ status: { $in: ['confirmed', 'canceled', 'completed', 'no_show', 'rescheduled'] }, 'approvalRecovery.reconciled': { $ne: true } },
      { status: 'failed', approvalDecisionAt: { $ne: null }, 'approvalRecovery.reconciled': { $ne: true } },
      { status: 'held', 'approvalRecovery.reconciled': { $ne: true } },
      { status: 'failed', $or: [{ startAt: { $gt: new Date() } }, { 'approvalRecovery.expiredAt': { $gte: new Date(Date.now()-86400000) } }], failureReason: /hold expired/i, 'approvalRecovery.reconciled': { $ne: true } }],
  }).sort({ updatedAt: 1, _id: 1 }).limit(limit).lean();
  let repaired = 0;
  for (const appointment of appointments) {
    const expired = appointment.status === 'failed';
    try {
      if (appointment.status !== 'held' && !(appointment.status === 'failed' && !appointment.approvalDecisionAt && /hold expired/i.test(appointment.failureReason || ''))) {
        await resolveApprovalReview(appointment);
        await Appointment.updateOne({ _id: appointment._id, status: appointment.status }, { $set: { 'approvalRecovery.reconciled': true, 'approvalRecovery.state': 'resolved' } });
        repaired++; continue;
      }
      await ensureApprovalReview(appointment, { expired });
      if (expired) {
        if (appointment.approvalRecovery?.expiredAt && Date.now() - new Date(appointment.approvalRecovery.expiredAt).getTime() < 86400000 && new Date(appointment.heldExpiresAt).getTime() > Date.now() - 86400000) await scheduleAppointmentChangeNotice({ appointment, key: 'approval_hold_expired',
          body: 'Your appointment is still awaiting approval. The requested time is no longer reserved. Your request remains open for the team to review. Reply here if another day would work.' });
        if (appointment.conversation) await Conversation.updateOne({ _id: appointment.conversation,
          business: appointment.business, 'bookingState.appointment': appointment._id }, { $set: {
          'bookingState.expiresAt': null, 'bookingState.status': 'pending_business_confirmation',
          'bookingState.lastError': 'approval_needs_recheck',
        } });
      }
      await Appointment.updateOne({ _id: appointment._id, status: appointment.status }, { $set: {
        'approvalRecovery.reconciled': true, 'approvalRecovery.state': expired ? 'needs_recheck' : 'pending',
      } });
      const latest = await Appointment.findById(appointment._id).lean();
      if (latest && latest.status !== appointment.status && latest.status !== 'held') {
        await resolveApprovalReview(latest);
        if (latest.status === 'confirmed' && latest.conversation) await Conversation.updateOne({
          _id: latest.conversation, business: latest.business, 'bookingState.appointment': latest._id,
        }, { $set: { 'bookingState.status': 'booked', 'bookingState.expiresAt': null, 'bookingState.lastError': '' } });
      }
      repaired++;
    } catch (error) {
      // Leave the marker unset: the next worker pass repairs the same records.
      await Appointment.updateOne({ _id: appointment._id }, { $set: { 'approvalRecovery.lastError': String(error.code || error.message).slice(0, 200) } });
    }
  }
  return { repaired };
}

export async function resolveApprovalReview(appointment) {
  await Alert.updateMany({ business: appointment.business, 'metadata.appointmentId': String(appointment._id),
    'metadata.approvalRequest': true, resolvedAt: null }, { $set: {
    resolvedAt: new Date(), status: 'resolved', actionRequired: false,
    resolution: `Appointment ${appointment.status}`, 'metadata.approvalState': appointment.status,
  } });
}
