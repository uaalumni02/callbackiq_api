import { createRequestBookingGuard, saveRequestBookingDocument } from '../requestBookingPersistence.service.js';
import { addressFromTurn, applyBookingStateTransition, clean, confirmationTimingReply, fixed, guardServiceRequest, isConfirmationQuestion, isSoftOptOutPhrase, known, resolveRequestAddress } from './context.js';
const checkRequestBookingWrite = createRequestBookingGuard('voice');


export async function captureRequestFacts(context) {
  const { customerMessage, lead, conversation, recentMessages, business, channel, turnId, semanticAssessment } = context;
const text = clean(customerMessage);
  if (isSoftOptOutPhrase(text)) return { completed: true, value: null };
  if (!text || !lead || !conversation || conversation.humanTakeover || conversation.aiEnabled === false || ['closed', 'archived'].includes(conversation.status)) return { completed: true, value: null };
  const existingAddress = resolveRequestAddress({ lead, conversation });
  const capturedAddress = addressFromTurn({ customerMessage: text, recentMessages, conversation, knownAddress: existingAddress });
  if (!capturedAddress && existingAddress && existingAddress !== lead.address) {
    checkRequestBookingWrite();
    lead.address = existingAddress; await saveRequestBookingDocument({ document: lead, guard: checkRequestBookingWrite, before: false, after: false, optional: true });
  }
  if (capturedAddress) {
    checkRequestBookingWrite();
    if (known(lead.address) && capturedAddress !== lead.address && !conversation.bookingState?.appointment) {
      applyBookingStateTransition(conversation, 'intake_address_changed');
      if (conversation.conversationMemory?.recoveryIntake) {
        conversation.conversationMemory.recoveryIntake.availability = { status: 'unknown' };
        conversation.conversationMemory.recoveryIntake.submitted = false;
        conversation.markModified?.('conversationMemory.recoveryIntake');
      }
      await saveRequestBookingDocument({ document: conversation, guard: checkRequestBookingWrite, before: false, optional: true });
    }
    lead.address = capturedAddress; await saveRequestBookingDocument({ document: lead, guard: checkRequestBookingWrite, before: false, after: false, optional: true });
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
