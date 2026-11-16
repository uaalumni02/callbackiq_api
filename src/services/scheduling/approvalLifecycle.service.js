import { approvalLifecycleEnsureApprovalReviewAlertAtomicUpdate, approvalLifecycleEnsureApprovalReviewAlertUpdateOne, approvalLifecycleEnsureApprovalReviewAlertUpdateOne2, approvalLifecycleEnsureApprovalReviewAlertUpdateOne3, approvalLifecycleReconcileApprovalRequestsAppointmentUpdateOne, approvalLifecycleReconcileApprovalRequestsAppointmentUpdateOne2, approvalLifecycleReconcileApprovalRequestsAppointmentUpdateOne3, approvalLifecycleResolveApprovalReviewAlertUpdateMany } from '../stateTransitions/appointmentLifecycle.js';
import { applyAppointmentBookingTransition } from '../booking/appointmentBookingTransition.repository.js';
import { repairConfirmedApproval } from './appointmentConfirmation.service.js';
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
  const alert = await approvalLifecycleEnsureApprovalReviewAlertAtomicUpdate({ Alert, appointment, business, dueAt, expired });
  // Preserve an existing deadline and assignment while repairing legacy reviews.
  await approvalLifecycleEnsureApprovalReviewAlertUpdateOne({ Alert, alert, dueAt });
  await approvalLifecycleEnsureApprovalReviewAlertUpdateOne2({ Alert, alert, business });
  await approvalLifecycleEnsureApprovalReviewAlertUpdateOne3({ Alert, alert });
  SocketService.emitAlertUpdated(appointment.business, alert);
  return alert;
}

export async function reconcileApprovalRequests({ businessId = null, limit = 100 } = {}) {
  const appointments = await Appointment.find({ $and: [{ $or: [{ requiresBusinessApproval: true }, { automaticConfirmationAuthorized: true, source: { $ne: 'sms' } }] }],
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
        if (appointment.status === 'confirmed') await repairConfirmedApproval({ appointment });
        await resolveApprovalReview(appointment);
        await approvalLifecycleReconcileApprovalRequestsAppointmentUpdateOne({ Appointment, appointment });
        repaired++; continue;
      }
      await ensureApprovalReview(appointment, { expired });
      if (expired) {
        if (appointment.approvalRecovery?.expiredAt && Date.now() - new Date(appointment.approvalRecovery.expiredAt).getTime() < 86400000 && new Date(appointment.heldExpiresAt).getTime() > Date.now() - 86400000) await scheduleAppointmentChangeNotice({ appointment, key: 'approval_hold_expired',
          body: 'Your appointment is still awaiting approval. The requested time is no longer reserved. Your request remains open for the team to review. Reply here if another day would work.' });
        await applyAppointmentBookingTransition(Conversation, 'approval_hold_expired', appointment);
      }
      await approvalLifecycleReconcileApprovalRequestsAppointmentUpdateOne2({ Appointment, appointment, expired });
      const latest = await Appointment.findById(appointment._id).lean();
      if (latest && latest.status !== appointment.status && latest.status !== 'held') {
        await resolveApprovalReview(latest);
        if (latest.status === 'confirmed') await applyAppointmentBookingTransition(Conversation, 'confirmation_recovered', latest);
      }
      repaired++;
    } catch (error) {
      // Leave the marker unset: the next worker pass repairs the same records.
      await approvalLifecycleReconcileApprovalRequestsAppointmentUpdateOne3({ Appointment, appointment, error });
    }
  }
  return { repaired };
}

export async function resolveApprovalReview(appointment) {
  await approvalLifecycleResolveApprovalReviewAlertUpdateMany({ Alert, appointment });
}
