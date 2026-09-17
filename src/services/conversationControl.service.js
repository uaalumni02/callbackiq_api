import { isRequestWithdrawal, requestWasWithdrawn } from './conversationControlPolicy.js';
export { isRequestWithdrawal, requestWasWithdrawn } from './conversationControlPolicy.js';
import AlertService from './alert.service.js';
import cancelAppointment from '../helpers/ai/tools/cancelAppointment.tool.js';
import { bookingQuestionReply } from './booking/conversationQuestions.service.js';
import { respectCustomerConstraints } from './conversationCondition.service.js';
import { assertDistributedLeaseActive } from './distributedLease.service.js';
import { assertVoiceTurnActive } from './voiceTurnContext.service.js';

const clean = value => String(value || '').replace(/\s+/g, ' ').trim();

const result = (reply, lead, extra = {}) => ({
  decision: 'send_fixed_response', actionType: 'send_fixed_response', messageCategory: 'service_details',
  reply, serviceNeeded: lead?.serviceNeeded || '', address: lead?.address || '',
  preferredAppointmentTime: lead?.preferredAppointmentTime || '', urgency: lead?.urgency || 'medium',
  intakeReady: false, shouldAlertOwner: false, riskFlags: [],
  guardrail: { skipAI: true, usedFallback: false, reason: 'conversation_control' }, ...extra,
});

const saveStaffAction = async payload => {
  const saved = await AlertService.create(payload);
  if (!saved?.alert?._id) throw Object.assign(new Error('Staff action was not saved.'), { code: 'STAFF_ACTION_NOT_SAVED' });
  return saved;
};

// Run after safety/consent and before service eligibility or slot selection.
// Questions and withdrawal do not authorize a new service or appointment.
export async function handleConversationControl({ business, lead, conversation, customerMessage, channel = 'sms' }) {
  if (!conversation || conversation.humanTakeover || conversation.aiEnabled === false || ['closed', 'archived'].includes(conversation.status)) return null;
  const text = clean(customerMessage);
  const check = () => { assertDistributedLeaseActive(); if (channel === 'voice') assertVoiceTurnActive(); };
  if (isRequestWithdrawal(text)) {
    if (typeof conversation.save !== 'function') return result('I could not save the cancellation. Please contact the business directly.', lead);
    check();
    const memory = conversation.conversationMemory?.toObject?.() || conversation.conversationMemory || {};
    conversation.conversationMemory = { ...memory, recoveryIntake: {
      ...(memory.recoveryIntake || {}), journeyKey: conversation.orchestration?.recoveryJourneyKey || '',
      withdrawnAt: memory.recoveryIntake?.withdrawnAt || new Date(), withdrawalReason: text.slice(0, 500),
    } };
    conversation.markModified?.('conversationMemory');
    if (conversation.lifecycle) conversation.lifecycle.nextRecoveryNudgeAt = null;
    await conversation.save(); check();
    const appointmentId = conversation.bookingState?.appointment;
    if (appointmentId) {
      try {
        await cancelAppointment({ business, appointmentId, reason: `Customer withdrew request by ${channel}: ${text}` });
        check();
      } catch (error) {
        if (['VOICE_STALE_TURN', 'DISTRIBUTED_LEASE_LOST'].includes(error?.code)) throw error;
        await saveStaffAction({ businessId: business._id, leadId: lead?._id, conversationId: conversation._id,
          type: 'system', title: 'Customer cancellation needs action', message: text,
          actionRequired: true, priority: 'high', recommendedAction: 'Cancel the appointment and verify provider and reminder cleanup.',
          dedupeKey: `withdrawal-failed:${conversation._id}:${appointmentId}` });
        return result('Your cancellation request is saved for staff review, but I could not confirm the appointment was canceled. Please contact the business directly before assuming it is canceled.', lead, { messageCategory: 'appointment_status' });
      }
    }
    check();
    await saveStaffAction({ businessId: business._id, leadId: lead?._id, conversationId: conversation._id,
      type: 'system', title: 'Customer withdrew service request', message: text,
      actionRequired: true, priority: 'medium', recommendedAction: 'Do not approve or dispatch this withdrawn request. Close any outstanding manual review.',
      dedupeKey: `withdrawal:${conversation._id}:${conversation.orchestration?.recoveryJourneyKey || 'current'}` });
    check();
    conversation.bookingState = { status: 'not_started', offeredSlots: [], selectedSlot: null, appointment: null, expiresAt: null };
    conversation.markModified?.('bookingState');
    await conversation.save(); check();
    if (lead?.save) { lead.status = 'lost'; await lead.save(); check(); }
    return result(appointmentId ? 'Your appointment has been canceled. I’m sorry we weren’t helpful.' : 'Your service request has been withdrawn. I’m sorry we weren’t helpful.', lead, { messageCategory: 'appointment_status' });
  }
  if (requestWasWithdrawn(conversation)) return result(conversation.bookingState?.appointment
    ? 'Your cancellation request is pending staff review. Appointment cancellation is not confirmed; please contact the business directly.'
    : 'Your earlier request is withdrawn. Please contact the business if you want to arrange service again.', lead);
  const question = bookingQuestionReply({ customerMessage: text, conversation });
  if (question) return result(question + (!lead?.address && conversation.bookingState?.status === 'human_takeover' ? ' What is the service address?' : ''), lead, { messageCategory: 'appointment_status' });
  if (/\b(?:what can i do|what should i do|anything i can do|what do i do)\b/i.test(text) &&
      /\b(?:right now|for now|meanwhile|until|in the meantime)\b/i.test(text)) {
    const issue = clean(lead?.serviceNeeded);
    const guidance = /\b(?:sink|tub|shower|toilet|drain)\b/i.test(issue) && /\b(?:leak(?:ing|s)?|drip(?:ping)?|overflow(?:ing)?|water)\b/i.test(issue)
      ? 'Avoid using the affected fixture for now and keep people away from wet areas and nearby electrical equipment. Where is the water coming from?'
      : 'Avoid using or attempting repairs on the affected equipment for now. What is happening with it right now?';
    return result(respectCustomerConstraints(guidance, { conversation, customerMessage: text }), lead);
  }
  return null;
}
