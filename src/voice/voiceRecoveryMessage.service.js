import { buildMissedCallRecoveryText } from '../services/messaging/smsCompliance.service.js';

export const COMPLETED_REQUEST_OUTCOMES = [
  'booked', 'appointment_requested', 'callback_saved', 'transfer_accepted',
  'direct_answer_resolved', 'safety_escalated', 'safety_guidance',
  'wrong_number', 'caller_declined', 'opted_out',
];

// Decide from durable facts, never by guessing that an assistant sentence
// proves a booking or promising that somebody will call the customer.
export function voiceRecoveryMessage(session) {
  const conversation = session.conversation || {};
  const callback = session.metadata?.callbackCapture;
  const booking = conversation.bookingState || {};
  const review = conversation.conversationMemory?.recoveryIntake;
  const completed = COMPLETED_REQUEST_OUTCOMES.includes(session.outcome) ||
    callback?.status === 'completed' || callback?.completedAt ||
    session.metadata?.bookingCompletedAt || session.metadata?.bookingRequestSubmittedAt ||
    (booking.appointment && ['booked', 'pending_business_confirmation'].includes(booking.status)) ||
    (review?.submitted && review?.review?.status === 'queued');
  if (completed) return { kind: 'suppressed', reason: 'A durable call/request outcome already exists; no recovery introduction is needed.', body: '' };
  const engaged = (session.transcript || []).some(turn => turn.role === 'customer' && turn.isFinal !== false && String(turn.text || '').trim());
  if (!engaged) return { kind: 'introduction', body: buildMissedCallRecoveryText({ business: session.business }) };
  const businessName = String(session.business?.businessName || 'the service team').trim();
  return { kind: 'continuation', body: buildMissedCallRecoveryText({ business: session.business,
    template: `Thanks for speaking with ${businessName}. If you still need help, reply here to continue your request or add details.` }) };
}
