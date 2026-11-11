import { AlertService, BookingStateMachine, clean, clogQuestionFor, fixed, known, leakContext, pricingReply, recoveryLeakQuestion, requestEvidenceKey } from './context.js';

export async function routeScheduling(context) {
  const { classification, conversation, state, ask, lead, text, postalCode, persist, business, channel, bookingActive, reviewOnly, activeEvidence, checkActive, journeyKey, turnId, now, address, pricingPrefix, approvedEstimate, timingPrefix, incomingRange, incomingTime } = context;
if (classification.intents?.availabilityInquiry) {
    // A request for times is not an answer to an outstanding intake question.
    // Resolve customer-supplied prerequisites before invoking provider tools;
    // otherwise missing facts are misreported as calendar/coverage failures.
    if (!conversation.bookingState?.appointment) {
      if (state.triagePending) return { completed: true, value: ask(leakContext(state.serviceDetail || lead.serviceNeeded) === 'unknown_fluid' ? 'leak_substance' : 'leak_activity', recoveryLeakQuestion(state.serviceDetail || lead.serviceNeeded)) };
      if (state.clogPending) return { completed: true, value: ask('clog_scope', clogQuestionFor(`${lead.serviceNeeded} ${state.serviceDetail || ''} ${text}`)) };
      if (!known(lead.address)) return { completed: true, value: ask('address', 'What is the service address so I can check appointment times?') };
      if (!postalCode) return { completed: true, value: ask('postal_code', 'What is the ZIP code for that address so I can check appointment times?') };
    }
    delete state.pendingAvailabilityQuestion;
    await persist(); return { completed: true, value: null };
  }
  if (state.pendingAvailabilityQuestion && !state.triagePending && !state.clogPending && known(lead.address) && postalCode) {
    const pendingQuestion = state.pendingAvailabilityQuestion;
    await persist();
    const availability = await BookingStateMachine.handle({ business, lead, conversation, customerMessage: pendingQuestion, channel });
    if (availability?.handled) {
      delete state.pendingAvailabilityQuestion;
      await persist();
      return { completed: true, value: availability.result };
    }
  }
  // Facts remain writable during scheduling and review. Do not replace the
  // booking proposal or claim that an existing appointment has changed.
  if (bookingActive) {
    await persist();
    if (reviewOnly || activeEvidence || ['pending_business_confirmation', 'booked', 'human_takeover'].includes(conversation.bookingState?.status)) {
      checkActive();
      const savedUpdate = await AlertService.create({ businessId: business._id, leadId: lead._id, conversationId: conversation._id,
        type: 'system', title: activeEvidence ? 'Customer reports an ongoing leak' : 'Customer updated a scheduling request',
        message: `${lead.serviceNeeded}; ${text}`.slice(0, 1000), actionRequired: true,
        metadata: { intakeReview: { ...state, reviewReady: false } },
        priority: activeEvidence ? 'high' : 'medium',
        recommendedAction: 'Review the new customer information before approving or dispatching. Existing appointment details have not been changed.',
        dedupeKey: `intake-update:${conversation._id}:${journeyKey}:${String(turnId || text).slice(0, 200)}` });
      if (!savedUpdate?.alert?._id) throw Object.assign(new Error('Customer update was not queued for review.'), { code: 'STAFF_ACTION_NOT_SAVED' });
      checkActive();
      state.review = { status: 'queued', alertId: String(savedUpdate.alert._id), queuedAt: now.toISOString(), evidenceKey: requestEvidenceKey({ lead, conversation, state }) };
      await persist();
    }
    const detail = activeEvidence ? 'I’ve noted that it is leaking continuously. Avoid using the affected equipment or area for now. ' : address ? 'I’ve saved the service address. ' : 'I’ve saved those additional details. ';
    const pending = conversation.bookingState?.status === 'offering_slots'
      ? 'Your earlier time choices are still listed. The team must verify availability; no appointment is confirmed.'
      : 'Your scheduling status has not changed. The team must review changes to the request.';
    return { completed: true, value: fixed(pricingPrefix + detail + pending, lead, { shouldAlertOwner: false, alertPriority: activeEvidence ? 'high' : 'medium', alertTitle: activeEvidence ? 'Customer reports an ongoing leak' : '' }) };
  }
  if (state.triagePending) {
    state.triageAsked = true; await persist();
    return { completed: true, value: ask(leakContext(state.serviceDetail || lead.serviceNeeded) === 'unknown_fluid' ? 'leak_substance' : 'leak_activity', recoveryLeakQuestion(state.serviceDetail || lead.serviceNeeded)) };
  }
  if (state.clogPending) {
    state.clogAsked = true;
    return { completed: true, value: ask('clog_scope', clogQuestionFor(`${lead.serviceNeeded} ${state.serviceDetail || ''} ${text}`)) };
  }
  if (state.submitted) {
    await persist();
    const reply = classification.intents?.pricing
      ? `${approvedEstimate || "I don't have an approved estimate for that request."} The service request still needs team review.`
      : 'Your additional details are saved with this conversation. The service request still needs team review.';
    return { completed: true, value: fixed(timingPrefix + reply, lead) };
  }
  // Pricing is a question within intake, not a reason to discard its facts.
  if (classification.intents?.pricing && !incomingRange && incomingTime.targetMinutes === null && !incomingTime.timeOfDay) {
    await persist();
    const priceResponse = pricingReply({ business, lead, triageResolved: state.triageResolved === true || state.clogResolved === true });
    const reply = approvedEstimate ? `${approvedEstimate} ${priceResponse.replace(`For ${clean(lead.serviceNeeded)}, I don't have a confirmed price yet.`, '').trim()}` : priceResponse;
    return { completed: true, value: fixed(timingPrefix + reply, lead, { messageCategory: 'pricing_request' }) };
  }
  await persist();
  return { completed: false, context: {  } };
}
