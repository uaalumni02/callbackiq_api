import { addressFromTurn, applyBookingStateTransition, assertDistributedLeaseActive, assertVoiceTurnActive, clean, confirmationTimingReply, fixed, guardServiceRequest, isConfirmationQuestion, isSoftOptOutPhrase, known, resolveRequestAddress } from './context.js';

export async function captureRequestFacts(context) {
  const { customerMessage, lead, conversation, recentMessages, business, channel, turnId, semanticAssessment } = context;
const text = clean(customerMessage);
  if (isSoftOptOutPhrase(text)) return { completed: true, value: null };
  if (!text || !lead || !conversation || conversation.humanTakeover || conversation.aiEnabled === false || ['closed', 'archived'].includes(conversation.status)) return { completed: true, value: null };
  const existingAddress = resolveRequestAddress({ lead, conversation });
  const capturedAddress = addressFromTurn({ customerMessage: text, recentMessages, conversation, knownAddress: existingAddress });
  if (!capturedAddress && existingAddress && existingAddress !== lead.address) {
    assertDistributedLeaseActive(); assertVoiceTurnActive();
    lead.address = existingAddress; await lead.save?.();
  }
  if (capturedAddress) {
    assertDistributedLeaseActive(); assertVoiceTurnActive();
    if (known(lead.address) && capturedAddress !== lead.address && !conversation.bookingState?.appointment) {
      applyBookingStateTransition(conversation, 'intake_address_changed');
      if (conversation.conversationMemory?.recoveryIntake) {
        conversation.conversationMemory.recoveryIntake.availability = { status: 'unknown' };
        conversation.conversationMemory.recoveryIntake.submitted = false;
        conversation.markModified?.('conversationMemory.recoveryIntake');
      }
      await conversation.save?.();
      assertDistributedLeaseActive(); assertVoiceTurnActive();
    }
    lead.address = capturedAddress; await lead.save?.();
  }
  const serviceGuard = await guardServiceRequest({ business, lead, conversation, customerMessage, channel, turnId, semanticAssessment, recentMessages });
  if (serviceGuard) return { completed: true, value: serviceGuard };
  if (isConfirmationQuestion(text) && !/\b(?:cancel|reschedule|call me|human)\b/i.test(text)) {
    if (!conversation.bookingState?.appointment && !['offering_slots', 'awaiting_confirmation'].includes(conversation.bookingState?.status)) {
      return { completed: true, value: fixed(confirmationTimingReply({ lead, conversation, channel }), lead, { messageCategory: 'appointment_status' }) };
    }
  }
  return { completed: false, context: { text, capturedAddress } };
}
