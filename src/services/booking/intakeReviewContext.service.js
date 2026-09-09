import crypto from 'crypto';
export const intakeReviewVersion = (conversation, lead) => crypto.createHash('sha256').update(JSON.stringify([
  String(conversation?._id || ''), conversation?.orchestration?.recoveryJourneyKey || '',
  String(conversation?.orchestration?.lastInboundMessage || ''), lead?.status || '',
  conversation?.customerPhone || '', lead?.phone || '',
  lead?.serviceNeeded || '', lead?.address || '', lead?.preferredAppointmentTime || '',
  conversation?.conversationMemory?.recoveryIntake?.serviceDetail || '',
  conversation?.conversationMemory?.recoveryIntake?.triageAnswer || '',
])).digest('hex');
export const manualIntakeSubmitted = conversation => {
  const state = conversation?.conversationMemory?.recoveryIntake || {};
  const journey = conversation?.orchestration?.recoveryJourneyKey || '';
  if (state.journeyKey !== undefined && state.journeyKey !== journey) return false;
  if (Number(state.failures || 0) >= 2 && state.reviewReady !== true) return false;
  return Boolean(state.submitted || conversation?.orchestration?.handoffReason === 'intake_complete');
};
