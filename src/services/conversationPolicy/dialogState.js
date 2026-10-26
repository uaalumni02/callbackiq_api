/**
 * Structured, bounded conversation memory. No customer text or address is
 * retained here: the established lead/intake models are authoritative for PII.
 * This state is advisory and never a substitute for delivery/booking evidence.
 */
export const ACTIONS = Object.freeze(['answer_question','ask_missing_detail','update_request','staff_review',
  'request_business_approval','booking_engine','human_takeover','suppress_reply','safety_response','normal_pipeline']);
const allowed = new Set(ACTIONS);
const PHASE = {
  booked: 'confirmed', pending_business_confirmation: 'awaiting_approval',
  offering_slots: 'offering_options', awaiting_confirmation: 'awaiting_customer_selection',
  booking: 'booking_attempt', collecting_preference: 'collecting_preference',
  collecting_location: 'collecting_address', collecting_service: 'collecting_service',
};
export function phaseFor({ conversation = {}, snapshot = {} } = {}) {
  if (conversation.humanTakeover) return 'human_ownership';
  if (['closed','archived'].includes(conversation.status)) return 'closed';
  if (conversation.bookingState?.appointment || conversation.bookingState?.status === 'booked') return 'confirmed';
  if (snapshot.qualifyingPending) return 'qualifying';
  if (snapshot.reviewQueued) return 'staff_review_pending';
  if (conversation.orchestration?.handoffStatus === 'pending_ack') return 'handoff_transmission_pending';
  return PHASE[conversation.bookingState?.status] || (snapshot.hasService ? snapshot.hasAddress ? 'collecting_preference' : 'collecting_address' : 'collecting_service');
}
export function buildDialogState({ previous = {}, plan = {}, conversation = {}, channel = 'sms', observedAt = new Date() } = {}) {
  const prior = previous.version === 3 ? previous : {};
  const key = String(conversation.orchestration?.recoveryJourneyKey || 'legacy').slice(0,120);
  const isNewJourney = prior.journeyKey !== key;
  const action = allowed.has(plan.action) ? plan.action : plan.handled ? 'answer_question' : 'normal_pipeline';
  const same = !isNewJourney && prior.lastIntent === plan.intent && prior.lastAction === action;
  const repetition = same ? Math.min(5, (Number(prior.repeatedIntentCount) || 0) + 1) : 0;
  return Object.freeze({
    version: 3, journeyKey: key,
    phase: phaseFor({ conversation, snapshot: plan.snapshot || {} }),
    lastIntent: String(plan.intent || 'unknown').slice(0,64), lastAction: action,
    lastChannel: channel === 'voice' ? 'voice' : 'sms',
    repeatedIntentCount: repetition, lastTurnAt: observedAt.toISOString(),
    // Evidence-backed status, never infer it from a sent SMS or a model proposal.
    reviewQueued: plan.snapshot?.reviewQueued === true,
    appointmentConfirmed: Boolean(conversation.bookingState?.appointment || conversation.bookingState?.status === 'booked'),
  });
}
export function assertNoUnauthorizedEffects(plan) {
  if (!plan?.handled) return true;
  if (plan.sideEffects?.length || plan.appointmentConfirmed || plan.requiresApproval) throw new Error('Read-only dialog plan attempted an unauthorized effect');
  return true;
}
