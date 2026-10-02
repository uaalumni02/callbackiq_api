// Coverage is an operational prerequisite, independent of the customer's trade
// or wording. These replies never authorize a slot or claim staff has responded.
export const isCoverageQuestion = value =>
  /\b(?:service area|coverage|cover my|serve my|service my|serve this|service this|cover this)\b/i.test(String(value || ''));

export function coverageReviewReply({ lead, conversation, state, coverageQuestion, availabilityQuestion, preferenceCaptured }) {
  const parts = [];
  if (coverageQuestion) parts.push('I rechecked the service area, but I still cannot verify coverage for that address.');
  else if (availabilityQuestion) parts.push('I cannot offer appointment times until coverage for your address is verified.');
  else parts.push('Coverage for this address needs team review.');
  if (preferenceCaptured && lead.preferredAppointmentTime) {
    parts.push(`I have ${lead.preferredAppointmentTime} as your preferred time for ${lead.serviceNeeded} at ${lead.address}.`);
  }
  parts.push('The team needs to review coverage and availability.');
  if (conversation.bookingState?.appointment) parts.push('This message does not change your existing appointment.');
  else parts.push('Your request is not a confirmed appointment.');
  if (!lead.preferredAppointmentTime && !state.coveragePreferenceAsked) {
    parts.push('What day and time would you prefer? I can include that preference for review.');
    state.coveragePreferenceAsked = true;
  } else if (!preferenceCaptured) parts.push("I don't have a review or response timeframe.");
  return parts.join(' ');
}

export const currentCoverage = (conversation = {}, lead = {}) => {
  const state = conversation.conversationMemory?.recoveryIntake || {};
  if (!String(lead.address || '').trim() || state.coverage?.reason === 'zip_code_required') return null;
  return (state.journeyKey || '') === (conversation.orchestration?.recoveryJourneyKey || '') &&
    state.coverage?.address === lead.address ? state.coverage : null;
};
