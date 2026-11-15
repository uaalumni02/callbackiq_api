import Alert from '../../models/alert.js';
import Appointment from '../../models/appointment.js';
import Conversation from '../../models/conversation.js';
import { assertDistributedLeaseActive } from '../distributedLease.service.js';
import { applyAppointmentBookingTransition } from './appointmentBookingTransition.repository.js';
import { STALE_INTAKE_HOLD_REASON } from './intakeReviewContext.service.js';
import { withRequestStateTransaction, requestStateWrite } from './requestStateTransaction.service.js';

const isIntakeHold = appointment => /^intake-approval:[a-f0-9]{24}:[a-f0-9]{24}$/.test(appointment.idempotencyKey);
const conflict = (message, code) => Object.assign(new Error(message), { statusCode: 409, code });

export async function rejectStaleIntakeHold(appointment) {
  const error = conflict(STALE_INTAKE_HOLD_REASON, 'INTAKE_REVIEW_CHANGED');
  const intent = appointment.confirmationIntent;
  const pending = intent?.status === 'pending_provider';
  // Preserve an intent that might already have reached a calendar provider.
  if (!isIntakeHold(appointment) || (pending && intent.attempts !== 0) ||
      !['held', 'failed'].includes(appointment.status)) throw error;

  assertDistributedLeaseActive();
  const released = await withRequestStateTransaction(async () => {
    assertDistributedLeaseActive();
    const retired = await requestStateWrite({ model: Appointment, method: 'findOneAndUpdate', filter: {
      _id: appointment._id, business: appointment.business, status: appointment.status,
      idempotencyKey: appointment.idempotencyKey, updatedAt: appointment.updatedAt,
      ...(pending ? {
        'confirmationIntent.status': 'pending_provider', 'confirmationIntent.token': intent.token,
        'confirmationIntent.leaseUntil': { $gt: new Date() }, 'confirmationIntent.attempts': 0,
      } : { 'confirmationIntent.status': { $ne: 'pending_provider' } }),
    }, changes: {
      $set: {
        status: 'failed', failureReason: STALE_INTAKE_HOLD_REASON, heldExpiresAt: null,
        activeSlotKey: null, slotClaimKeys: [], capacityLane: null,
        idempotencyKey: `superseded-intake-approval:${appointment._id}`,
        approvalRecovery: { reconciled: true, state: 'resolved' },
      },
      ...(pending ? { $unset: { confirmationIntent: '' } } : {}),
    }, options: {returnDocument:'after'} });
    if (!retired) return false;

    await applyAppointmentBookingTransition(Conversation, 'intake_hold_superseded', retired);
    await requestStateWrite({ model: Alert, method: 'updateMany', filter: {
      business: retired.business, appointment: retired._id, 'metadata.approvalRequest': true, resolvedAt: null,
    }, changes: { $set: { resolvedAt: new Date(), status: 'resolved', actionRequired: false,
      resolution: STALE_INTAKE_HOLD_REASON, 'metadata.approvalState': 'superseded' } } });
    assertDistributedLeaseActive();
    return true;
  });
  if (!released) throw conflict('The appointment changed while the request was being reviewed. Refresh before continuing.', 'APPOINTMENT_CONFIRMATION_PENDING');
  throw Object.assign(error, { intakeHoldReleased: true });
}

