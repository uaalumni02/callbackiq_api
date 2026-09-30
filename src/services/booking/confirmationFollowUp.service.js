import { recoveryPreferenceLabel } from './recoveryIntakePresentation.service.js';

// Read-only presentation: queue evidence is not staff receipt or approval.
export function confirmationFollowUpReply({ lead = {}, conversation = {}, channel = 'sms' } = {}) {
  const state = conversation.conversationMemory?.recoveryIntake || {};
  const preference = String(lead.preferredAppointmentTime || state.preferredAppointmentTime || '').trim();
  const dated = preference.match(/^(\d{4}-\d{2}-\d{2}) at (.+)$/);
  const label = dated ? recoveryPreferenceLabel({ date: dated[1], time: dated[2] }) : preference;
  const queued = state.review?.status === 'queued' && Boolean(state.review?.alertId);
  const status = queued
    ? `Your request${label ? ` for ${label}` : ''} is saved for team review.`
    : `Your request${label ? ` for ${label}` : ''} still needs team review; I can't verify that it is queued yet.`;
  const next = channel === 'voice'
    ? 'If you would like to request a callback, say “call me.”'
    : 'To request a callback from the team, reply “call me.”';
  return `I don't have a confirmation timeframe. ${status} This is not a confirmed appointment. ${next} A callback time is not guaranteed.`;
}
