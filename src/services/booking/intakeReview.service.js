import { withStaffSchedulingException } from '../scheduling/staffSchedulingException.service.js';
import { extractCustomerPostalCode } from './customerAddress.service.js';
import crypto from 'crypto';
import mongoose from 'mongoose';
import Conversation from '../../models/conversation.js';
import Lead from '../../models/lead.js';
import Alert from '../../models/alert.js';
import VoiceSession from '../../models/voiceSession.js';
import { normalizePhoneToE164 } from '../../voice/voicePhone.service.js';
import AppointmentNotificationJob from '../../models/appointmentNotificationJob.js';
import AppointmentService, { ensureBusinessApprovalNotice } from '../scheduling/appointment.service.js';
import { withDistributedLease, assertDistributedLeaseActive } from '../distributedLease.service.js';

const fail = (message, code, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
export { intakeReviewVersion, manualIntakeSubmitted } from './intakeReviewContext.service.js';
import { intakeReviewVersion, manualIntakeSubmitted } from './intakeReviewContext.service.js';

const assertVoiceReviewIdle = async (businessId, conversationId) => {
  const activeCall = await VoiceSession.exists({ business: businessId, conversation: conversationId,
    status: { $in: ['routing', 'connecting', 'active', 'capturing_callback', 'safety_escalated', 'transferring', 'completing'] },
  });
  if (activeCall) throw fail('The customer is still on a voice call. Review the completed call before approving.', 'INTAKE_VOICE_ACTIVE');
};

export const approveIntake = async ({ business, conversationId, input, approvedBy }) => {
  if (!mongoose.isValidObjectId(conversationId) || !mongoose.isValidObjectId(input.serviceOfferingId) ||
      typeof input.intakeReviewVersion !== 'string' || !/^[a-f0-9]{64}$/.test(input.intakeReviewVersion) ||
      typeof input.startAt !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(input.startAt) || !Number.isFinite(Date.parse(input.startAt)) ||
      (input.endAt && (typeof input.endAt !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(input.endAt) || !Number.isFinite(Date.parse(input.endAt)) || Date.parse(input.endAt) <= Date.parse(input.startAt)))) {
    throw fail('A reviewed service, timezone-qualified start time, and current intake review version are required.', 'INVALID_INTAKE_APPROVAL', 400);
  }
  const requestedException = input.schedulingException;
  if (requestedException !== undefined && (!requestedException || requestedException.allowShortNotice !== true ||
      typeof requestedException.reason !== 'string' || requestedException.reason.trim().length < 15 ||
      requestedException.reason.trim().length > 500 || !mongoose.isValidObjectId(approvedBy))) {
    throw fail('A staff identity and a 15–500 character reason are required for a short-notice exception.', 'INVALID_SCHEDULING_EXCEPTION', 400);
  }
  const exception = requestedException ? { businessId: String(business._id), serviceOfferingId: String(input.serviceOfferingId),
    startAt: input.startAt, approvedBy: String(approvedBy), reason: requestedException.reason.trim(), approvedAt: new Date() } : null;
  const runScheduling = operation => exception ? withStaffSchedulingException(exception, operation) : operation();
  const lease = await withDistributedLease(`sms-conversation:${conversationId}`, async () => {
    const conversation = await Conversation.findOne({ _id: conversationId, business: business._id });
    if (!conversation) throw fail('Conversation not found.', 'CONVERSATION_NOT_FOUND', 404);
    const lead = await Lead.findOne({ _id: conversation.lead, business: business._id });
    if (!lead || ['closed', 'archived'].includes(conversation.status) || !manualIntakeSubmitted(conversation)) {
      throw fail('This conversation does not have an active submitted service request.', 'INTAKE_NOT_REVIEWABLE');
    }
    const reviewState = conversation.conversationMemory?.recoveryIntake || {};
    const unresolvedQualification = (reviewState.problem && reviewState.problem.status !== 'clear') ||
      reviewState.triagePending || reviewState.clogPending;
    const qualificationReviewNote = typeof input.qualificationReviewNote === 'string' ? input.qualificationReviewNote.trim() : '';
    if (input.qualificationReviewNote !== undefined &&
        (typeof input.qualificationReviewNote !== 'string' || qualificationReviewNote.length < 15 || qualificationReviewNote.length > 500)) {
      throw fail('A qualification review note must contain 15–500 characters.', 'INVALID_QUALIFICATION_REVIEW_NOTE', 400);
    }
    // This owner-scoped endpoint is the explicit human decision. Preserve the
    // exact uncertainty reviewed; do not force an incompatible new UI field or
    // pretend the customer's symptom was resolved by approving a diagnostic visit.
    const qualificationReview = unresolvedQualification ? {
      note: qualificationReviewNote, approvedBy, reviewedAt: new Date(),
      problem: reviewState.problem || null, triagePending: Boolean(reviewState.triagePending),
      clogPending: Boolean(reviewState.clogPending), triageAnswer: reviewState.triageAnswer || '',
    } : null;
    if (conversation.bookingState?.appointment && !reviewState.reviewAppointmentId && !reviewState.appointmentId) {
      throw fail('This request already has an appointment. Review or reschedule that appointment instead.', 'INTAKE_EXISTING_APPOINTMENT');
    }
    if (intakeReviewVersion(conversation, lead) !== input.intakeReviewVersion) throw fail('The customer details changed. Refresh and review the request again.', 'INTAKE_REVIEW_CHANGED');
    const alert = await Alert.exists({ business: business._id, conversation: conversation._id, type: 'human_requested', $or: [{ 'metadata.handoffReason': { $in: ['intake_complete', 'scheduling_review', 'intake_unclear'] } }, { 'metadata.messageCategory': 'appointment_preference' }] });
    if (!alert) throw fail('The service request review record is missing.', 'INTAKE_REVIEW_MISSING');
    await assertVoiceReviewIdle(business._id, conversation._id);
    const customerPhone = normalizePhoneToE164(conversation.customerPhone);
    if (!customerPhone) throw fail('Confirm a usable customer phone number before approving this request.', 'INTAKE_CONTACT_REQUIRED');
    const address = String(lead.address || '').trim();
    const postalCode = extractCustomerPostalCode(address);
    if (!address || !postalCode || !lead.serviceNeeded) throw fail('Review the service and complete address before scheduling.', 'INTAKE_INCOMPLETE');
    const journey = conversation.orchestration?.recoveryJourneyKey || 'legacy';
    const key = `intake-approval:${conversation._id}:${crypto.createHash('sha256').update(journey).digest('hex').slice(0, 24)}`;
    assertDistributedLeaseActive();
    const appointment = await runScheduling(() => AppointmentService.create({ business, idempotencyKey: key, confirm: false, ownerValuationAuthorized: true, input: {
      serviceOfferingId: input.serviceOfferingId, startAt: input.startAt, ...(input.endAt ? { endAt: input.endAt } : {}),
      lead: lead._id, conversation: conversation._id, customerName: lead.customerName || conversation.customerName,
      customerPhone, customerEmail: lead.email || '', address: { street: address, postalCode },
      timezone: business.timezone || 'America/New_York', source: 'manual', bookedBy: 'staff', requiresBusinessApproval: true,
      notes: `Reviewed service request: ${lead.serviceNeeded}. Customer preference: ${lead.preferredAppointmentTime || ''}${unresolvedQualification ? `. Staff approved with unresolved intake details: ${reviewState.problem?.reason || 'triage_unresolved'}.${qualificationReviewNote ? ` Review note: ${qualificationReviewNote}` : ''}` : ''}`,
    } }));
    assertDistributedLeaseActive();
    await Conversation.updateOne({ _id: conversation._id, business: business._id }, { $set: {
      'conversationMemory.recoveryIntake.reviewAppointmentId': String(appointment._id),
      'bookingState.appointment': appointment._id,
      'bookingState.status': appointment.status === 'confirmed' ? 'booked' : 'pending_business_confirmation',
    } });
    assertDistributedLeaseActive();
    if (normalizePhoneToE164(appointment.customerPhone) !== customerPhone || String(appointment.conversation) !== String(conversation._id) || String(appointment.lead) !== String(lead._id) ||
      appointment.address?.street !== address || appointment.address?.postalCode !== postalCode ||
      String(appointment.serviceOffering) !== String(input.serviceOfferingId) || new Date(appointment.startAt).getTime() !== Date.parse(input.startAt) ||
      (input.endAt && new Date(appointment.endAt).getTime() !== Date.parse(input.endAt))) {
      throw fail('This request already has a different appointment operation. Review that appointment before changing it.', 'INTAKE_APPOINTMENT_MISMATCH');
    }
    // Voice and staff edits may not share the SMS worker lease. Re-read the
    // reviewed facts after availability lookup before granting confirmation.
    const currentConversation = await Conversation.findOne({ _id: conversation._id, business: business._id });
    const currentLead = await Lead.findOne({ _id: lead._id, business: business._id });
    if (!currentConversation || !currentLead || ['closed', 'archived'].includes(currentConversation.status) ||
        intakeReviewVersion(currentConversation, currentLead) !== input.intakeReviewVersion) {
      throw fail('The customer details changed during review. Refresh before confirming.', 'INTAKE_REVIEW_CHANGED');
    }
    assertDistributedLeaseActive();
    await assertVoiceReviewIdle(business._id, conversation._id);
    assertDistributedLeaseActive();
    const confirmed = await runScheduling(() => AppointmentService.confirm({ business, appointmentId: appointment._id, approvedBy }));
    assertDistributedLeaseActive();
    // Retry safely repairs a notice missing after a crash, without resending an existing job.
    let confirmationNoticeStatus = 'unavailable';
    try {
      await ensureBusinessApprovalNotice({ appointment: confirmed, business });
      const notice = await AppointmentNotificationJob.findOne({ business: business._id, appointment: confirmed._id, key: 'change_notice:business_approval_confirmed' }).lean();
      confirmationNoticeStatus = notice?.status || 'unavailable';
    } catch { /* The appointment is confirmed; report missing notice honestly. */ }
    await Conversation.updateOne({ _id: conversation._id, business: business._id }, { $set: {
      'conversationMemory.recoveryIntake.appointmentId': String(confirmed._id),
      'conversationMemory.recoveryIntake.approvedAt': confirmed.approvalDecisionAt || new Date(),
      'conversationMemory.recoveryIntake.approvedBy': approvedBy,
      ...(unresolvedQualification ? { 'conversationMemory.recoveryIntake.qualificationReview': qualificationReview } : {}),
      'bookingState.status': 'booked', 'bookingState.appointment': confirmed._id,
      'bookingState.expiresAt': null, 'bookingState.lastError': '',
    } });
    return { appointment: confirmed, confirmationNoticeStatus };
  });
  if (!lease.acquired) throw fail('This conversation is being updated. Try again shortly.', 'INTAKE_BUSY');
  return lease.value;
};
