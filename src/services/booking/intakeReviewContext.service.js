import crypto from 'crypto';

export const STALE_INTAKE_HOLD_REASON = 'The reviewed customer details changed. Reload the captured request and review it before booking.';
export const intakeApprovalKey = (conversation) => {
  const journey = conversation.orchestration?.recoveryJourneyKey || 'legacy';
  const hash = crypto.createHash('sha256').update(journey).digest('hex').slice(0, 24);
  return `intake-approval:${conversation._id}:${hash}`;
};
export const intakeReviewVersion = (conversation, lead) => crypto.createHash('sha256').update(JSON.stringify([
  String(conversation?._id || ''), conversation?.orchestration?.recoveryJourneyKey || '',
  String(conversation?.orchestration?.lastInboundMessage || ''), lead?.status || '',
  conversation?.customerPhone || '', lead?.phone || '', lead?.customerName || '', conversation?.customerName || '',
  lead?.serviceNeeded || '', lead?.address || '', lead?.preferredAppointmentTime || '',
  conversation?.conversationMemory?.recoveryIntake?.serviceDetail || '',
  conversation?.conversationMemory?.recoveryIntake?.triageAnswer || '',
  lead?.urgency || '', conversation?.serviceEligibility?.decision || '',
  conversation?.serviceEligibility?.serviceId || '',
  conversation?.conversationMemory?.recoveryIntake?.problem || null,
  conversation?.conversationMemory?.recoveryIntake?.coverage?.reason || '',
  conversation?.conversationMemory?.recoveryIntake?.coverage?.address || '',
  conversation?.conversationMemory?.recoveryIntake?.unresolvedQuestions || [],
  Boolean(conversation?.conversationMemory?.recoveryIntake?.triagePending),
  Boolean(conversation?.conversationMemory?.recoveryIntake?.clogPending),
])).digest('hex');
export const manualIntakeSubmitted = conversation => {
  const state = conversation?.conversationMemory?.recoveryIntake || {};
  const journey = conversation?.orchestration?.recoveryJourneyKey || '';
  if (state.withdrawnAt || state.review?.status === 'resolved') return false;
  if (state.journeyKey !== undefined && state.journeyKey !== journey) return false;
  if (Number(state.failures || 0) >= 2 && state.reviewReady !== true) return false;
  return Boolean(state.submitted || ['intake_complete', 'scheduling_review'].includes(conversation?.orchestration?.handoffReason) ||
    (state.reviewReady === true && conversation?.orchestration?.handoffReason === 'intake_unclear'));
};
