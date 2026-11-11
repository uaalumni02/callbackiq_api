import { AlertService, fixed, recoveryCompletionReply } from './context.js';

export async function submitStaffReview(context) {
  const { state, turnId, lead, persist, journeyKey, pricingPrefix, availabilityNote, channel, ready, checkActive, business, conversation, session, text, now } = context;
state.reviewReady = true;
  state.decision = { action: 'request_staff_review', turnId: String(turnId) };
  state.review = { status: 'pending_persistence' };
  state.serviceNeeded = lead.serviceNeeded;
  state.address = lead.address;
  state.preferredAppointmentTime = lead.preferredAppointmentTime;
  await persist();
  const intakeReview = { tradeQualification: state.tradeQualification, reviewReady: true, journeyKey, serviceNeeded: state.serviceNeeded, serviceDetail: state.serviceDetail || '', address: state.address, preferredAppointmentTime: state.preferredAppointmentTime, triageAnswer: state.triageAnswer || '', availability: state.availability, problem: state.problem, coverage: state.coverage, readiness: state.readiness, unresolvedQuestions: state.unresolvedQuestions, activePreference: state.activePreference, eligibility: state.eligibility, review: state.review };
  const result = fixed(pricingPrefix + availabilityNote, lead, { intakeReady: true, intakeReview, summary: `${state.serviceDetail || lead.serviceNeeded}; ${Object.entries(state.tradeQualification?.answers || {}).map(([key,value]) => `${key}: ${value}`).join('; ')}; ${state.triageAnswer || ''}; ${lead.address}; requested ${lead.preferredAppointmentTime}`, messageCategory: 'appointment_preference', intakeCompletionReply: pricingPrefix + recoveryCompletionReply({ lead, state, channel }) });
  if (ready && channel === 'voice') {
    checkActive();
    const savedReview = await AlertService.createHumanHandoffAlert({ businessId: business._id, leadId: lead._id, conversationId: conversation._id, providerMessageId: `voice-intake:${session?._id || conversation._id}:${journeyKey}`, customerPhone: lead.phone || conversation.customerPhone, customerName: lead.customerName, customerMessage: text, lead, result: { ...result, handoff: { reason: 'intake_complete' } } });
    if (!savedReview?.alert?._id) throw Object.assign(new Error('Staff review was not saved.'), { code: 'STAFF_ACTION_NOT_SAVED' });
    checkActive(); state.submitted = true; state.review = { status: 'queued', alertId: String(savedReview.alert._id), queuedAt: now.toISOString() }; await persist();
    result.reply = result.intakeCompletionReply;
    result.outcome = 'callback_saved';
  }
  return { completed: true, value: result };
}
