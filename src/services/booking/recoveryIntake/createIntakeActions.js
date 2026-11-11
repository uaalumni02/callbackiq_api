import { AlertService, buildRequestReadiness, extractCustomerPostalCode, fixed, getApprovedServiceEstimate, isRepeatCorrection, known, logOperationalError, resetUncertainTurns } from './context.js';

export async function createIntakeActions(context) {
  const { understoodAnswer, classification, questions, coverageQuestion, semanticAssessment, text, lead, state, checkActive, business, conversation, now, turnId, reviewOnly, channel, session, journeyKey, address, urgentPlumbing, wasTriageResolved } = context;
if (!understoodAnswer && !classification.intents?.pricing && !classification.intents?.completionQuestion && !questions.clarificationAnswer && !classification.intents?.availabilityInquiry && !coverageQuestion && !semanticAssessment &&
      !(/^\d{5}(?:-\d{4})?$/.test(text) && known(lead.address)) && (!state.field || /\?$/.test(text)) && !state.problem?.asked && !state.tradeQualification?.pending && !(state.tradeQualification && /\b(?:actually|correction|now|instead|no longer)\b/i.test(text))) return { completed: true, value: null };
  let approvedEstimate = '';
  if (classification.intents?.pricing) {
    checkActive();
    try { approvedEstimate = await getApprovedServiceEstimate({ businessId: business._id, serviceNeeded: lead.serviceNeeded, customerMessage: text }); }
    catch (error) { logOperationalError('intake.price_lookup_failed', error, { businessId: business._id }); }
    checkActive();
  }
  if (approvedEstimate) state.unresolvedQuestions = state.unresolvedQuestions.filter(q => q.kind !== 'price');
  const timingPrefix = questions.duration || questions.completionDate ? 'The team needs to assess the job scope before estimating how long the work will take or when it can be completed. ' : '';
  const pricingPrefix = timingPrefix + (classification.intents?.pricing ? `${approvedEstimate || "I don't have a confirmed price for that work."} ` : '');
  const persist = async () => {
    checkActive(); await lead.save(); checkActive();
    if (understoodAnswer) { await resetUncertainTurns(conversation); checkActive(); }
    state.serviceNeeded = lead.serviceNeeded; state.address = lead.address || '';
    state.preferredAppointmentTime = lead.preferredAppointmentTime || '';
    state.eligibility = conversation.serviceEligibility?.decision || 'not_checked';
    state.scope = { tradeQualification: state.tradeQualification || null, detail: state.serviceDetail || lead.serviceNeeded, triageAnswer: state.triageAnswer || '', problem: state.problem || null };
    state.activePreference = { date: state.date || '', time: state.time || '', label: lead.preferredAppointmentTime || '' };
    state.readiness = buildRequestReadiness({ lead, conversation, state, now });
    if (conversation.set) conversation.set('conversationMemory.recoveryIntake', state);
    else conversation.conversationMemory = { ...(conversation.conversationMemory || {}), recoveryIntake: state };
    conversation.markModified?.('conversationMemory.recoveryIntake');
    await conversation.save(); checkActive();
  };
  const ask = async (field, reply) => {
    const facts = JSON.stringify([lead.serviceNeeded, lead.address, lead.preferredAppointmentTime, state.triageResolved]);
    if (!turnId || state.lastTurnId !== String(turnId)) state.failures = !understoodAnswer && state.field === field && state.lastFacts === facts ? Math.min(2, (state.failures || 0) + 1) : 0;
    state.lastTurnId = String(turnId);
    state.field = field; state.lastFacts = facts;
    state.decision = { action: field === 'available_preference' ? 'offer_alternatives' : 'clarify', field, turnId: String(turnId) };
    await persist();
    if (reviewOnly) {
      checkActive();
      const saved = await AlertService.create({ businessId: business._id, leadId: lead._id, conversationId: conversation._id,
        type: 'system', title: 'Customer request needs clarification', priority: 'high', actionRequired: true,
        message: `${lead.serviceNeeded}; ${lead.preferredAppointmentTime || ''}; ${text}`.slice(0, 1000),
        recommendedAction: 'Review the latest preference and unresolved customer questions before approval.',
        metadata: { intakeReview: { ...state, reviewReady: false } },
        dedupeKey: `intake-question:${conversation._id}:${String(turnId || text).slice(0, 200)}` });
      if (!saved?.alert?._id) throw Object.assign(new Error('Customer clarification was not queued for review.'), { code: 'STAFF_ACTION_NOT_SAVED' });
      state.review = { status: 'queued', alertId: String(saved.alert._id), queuedAt: now.toISOString() };
      await persist();
    }
    if (state.failures >= 2) {
      const result = fixed("I've saved your details for team review so you don't need to repeat them. I don't have a response timeframe.", lead, { actionType: 'human_handoff', handoff: { required: true, reason: 'intake_unclear', callbackRequested: false } });
      if (channel === 'voice') {
        checkActive();
        await AlertService.createHumanHandoffAlert({ businessId: business._id, leadId: lead._id, conversationId: conversation._id, providerMessageId: `voice-unclear:${session?._id || conversation._id}:${journeyKey}`, customerPhone: lead.phone || conversation.customerPhone, customerMessage: text, lead, result });
        checkActive(); state.submitted = true; await persist(); result.outcome = 'callback_saved';
      }
      return result;
    }
    const addressAcknowledgement = channel === 'voice' && address && extractCustomerPostalCode(address) ? `I have ZIP ${extractCustomerPostalCode(address).split('').join(' ')}. ` : '';
    const acknowledged = urgentPlumbing ? 'I have flagged this urgent repair for the team. An arrival time is not confirmed. Stay away from standing water and electrical equipment; call 911 if anyone is in immediate danger. ' : !wasTriageResolved && state.triageResolved && state.leakPattern === 'during_use'
      ? 'Thanks for clarifying that it leaks during use. Please avoid using it for now. '
      : '';
    return fixed(`${isRepeatCorrection(text) && address ? 'Sorry, I have your address now. ' : ''}${pricingPrefix}${addressAcknowledgement}${acknowledged}${reply}`, lead);
  };
  return { completed: false, context: { approvedEstimate, timingPrefix, pricingPrefix, persist, ask } };
}
