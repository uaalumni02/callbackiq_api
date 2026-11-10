import mongoose from 'mongoose';
import Alert from '../../models/alert.js';
import Appointment from '../../models/appointment.js';
import Conversation from '../../models/conversation.js';
import Lead from '../../models/lead.js';
import VoiceSession from '../../models/voiceSession.js';
import { normalizePhoneToE164 } from '../../voice/voicePhone.service.js';
import { assertDistributedLeaseActive } from '../distributedLease.service.js';
import { applyAppointmentBookingTransition } from './appointmentBookingTransition.repository.js';
import { extractCustomerPostalCode } from './customerAddress.service.js';
import { intakeApprovalKey, intakeReviewVersion, manualIntakeSubmitted, STALE_INTAKE_HOLD_REASON } from './intakeReviewContext.service.js';

const isIntakeHold = (appointment) => /^intake-approval:[a-f0-9]{24}:[a-f0-9]{24}$/.test(appointment.idempotencyKey);
const conflict = (message, code) => Object.assign(new Error(message), { statusCode: 409, code });

export async function assertVoiceReviewIdle(businessId, conversationId) {
  const activeCall = await VoiceSession.exists({ business: businessId, conversation: conversationId,
    status: { $in: ['routing', 'connecting', 'active', 'capturing_callback', 'safety_escalated', 'transferring', 'completing'] },
  });
  if (activeCall) throw conflict('The customer is still on a voice call. Review the completed call before approving.', 'INTAKE_VOICE_ACTIVE');
}

export async function rejectStaleIntakeHold(appointment) {
  const error = conflict(STALE_INTAKE_HOLD_REASON, 'INTAKE_REVIEW_CHANGED');
  const intent = appointment.confirmationIntent;
  const pending = intent?.status === 'pending_provider';
  // Preserve an intent that might already have reached a calendar provider.
  if (!isIntakeHold(appointment) || (pending && intent.attempts !== 0) ||
      !['held', 'failed'].includes(appointment.status)) throw error;

  assertDistributedLeaseActive();
  const released = await mongoose.connection.transaction(async (session) => {
    assertDistributedLeaseActive();
    const retired = await Appointment.findOneAndUpdate({
      _id: appointment._id, business: appointment.business, status: appointment.status,
      idempotencyKey: appointment.idempotencyKey, updatedAt: appointment.updatedAt,
      ...(pending ? {
        'confirmationIntent.status': 'pending_provider', 'confirmationIntent.token': intent.token,
        'confirmationIntent.leaseUntil': { $gt: new Date() }, 'confirmationIntent.attempts': 0,
      } : { 'confirmationIntent.status': { $ne: 'pending_provider' } }),
    }, {
      $set: {
        status: 'failed', failureReason: STALE_INTAKE_HOLD_REASON, heldExpiresAt: null,
        activeSlotKey: null, slotClaimKeys: [], capacityLane: null,
        idempotencyKey: `superseded-intake-approval:${appointment._id}`,
        approvalRecovery: { reconciled: true, state: 'resolved' },
      },
      ...(pending ? { $unset: { confirmationIntent: '' } } : {}),
    }, { session, returnDocument: 'after' });
    if (!retired) return false;

    await applyAppointmentBookingTransition(Conversation, 'intake_hold_superseded', retired, { session });
    await Alert.updateMany({
      business: retired.business, appointment: retired._id, 'metadata.approvalRequest': true, resolvedAt: null,
    }, { $set: { resolvedAt: new Date(), status: 'resolved', actionRequired: false,
      resolution: STALE_INTAKE_HOLD_REASON, 'metadata.approvalState': 'superseded' } }, { session });
    assertDistributedLeaseActive();
    return true;
  });
  if (!released) throw conflict('The appointment changed while the request was being reviewed. Refresh before continuing.', 'APPOINTMENT_CONFIRMATION_PENDING');
  throw Object.assign(error, { intakeHoldReleased: true });
}

export async function assertIntakeHoldCurrent(appointment) {
  if (!isIntakeHold(appointment)) return;
  if (!appointment.intakeReviewVersion) await rejectStaleIntakeHold(appointment);

  await assertVoiceReviewIdle(appointment.business, appointment.conversation);
  const [conversation, lead] = await Promise.all([
    Conversation.findOne({ _id: appointment.conversation, business: appointment.business }).lean(),
    Lead.findOne({ _id: appointment.lead, business: appointment.business }).lean(),
  ]);
  const address = String(lead?.address || '').trim();
  if (!conversation || !lead || conversation.status !== 'open' ||
      String(conversation.lead) !== String(appointment.lead) ||
      (conversation.bookingState?.appointment && String(conversation.bookingState.appointment) !== String(appointment._id)) ||
      !manualIntakeSubmitted(conversation) || intakeApprovalKey(conversation) !== appointment.idempotencyKey ||
      intakeReviewVersion(conversation, lead) !== appointment.intakeReviewVersion ||
      normalizePhoneToE164(conversation.customerPhone) !== normalizePhoneToE164(appointment.customerPhone) ||
      !address || appointment.address?.street !== address || appointment.address?.postalCode !== extractCustomerPostalCode(address)) {
    await rejectStaleIntakeHold(appointment);
  }
}
