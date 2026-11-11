import { AlertService, applyBookingStateTransition, assessProblemClarity, assessTradeQualification, fixed, getEmergencyReply, known, tradeReviewReply } from './context.js';

export async function assessQualification(context) {
  const { classification, state, lead, text, conversation, turnId, address, incomingRange, incomingTime, service, oldState, persist, pricingPrefix, channel, checkActive, business, session, journeyKey, rejectedDateOnly, rejectedTimeOnly, ask } = context;
const problemInterrupt = Boolean(classification.intents?.pricing || classification.intents?.availabilityInquiry ||
    classification.intents?.human || classification.intents?.callback || classification.intents?.status);
  state.problem = assessProblemClarity({ service: lead.serviceNeeded, text,
    previous: state.problem, policy: conversation.serviceEligibility?.intakePolicy || {},
    category: conversation.serviceEligibility?.category || '', turnId,
    interrupt: problemInterrupt, factualTurn: Boolean(address || incomingRange || incomingTime.targetMinutes !== null || incomingTime.timeOfDay),
    correction: Boolean(classification.intents?.correction && known(service)),
  });
  if (state.problem.status === 'clear' && state.problem.reason === 'problem_detail_captured' &&
      state.problem.evidence && state.problem.evidence !== lead.serviceNeeded) {
    state.serviceDetail = `${lead.serviceNeeded}; ${state.problem.evidence}`.slice(0, 500);
  }
  state.tradeQualification = assessTradeQualification({ service: lead.serviceNeeded, category: conversation.serviceEligibility?.category, text: state.leakSubstance && !/water/i.test(state.leakSubstance) ? `${text}; leak substance: ${state.leakSubstance}` : text, previous: state.tradeQualification, policy: conversation.serviceEligibility?.intakePolicy || {}, turnId, interrupt: problemInterrupt, factualTurn: Boolean(address || incomingRange || incomingTime.targetMinutes !== null || incomingTime.timeOfDay), correction: Boolean(classification.intents?.correction && known(service)) });
  if (oldState?.tradeQualification && JSON.stringify(oldState.tradeQualification.answers || {}) !== JSON.stringify(state.tradeQualification.answers || {})) {
    state.availability = { status: 'not_checked', reason: 'job_details_changed' };
    state.reviewReady = false; state.submitted = false;
  }
  const reviewQualification = async (reason, reply) => {
    state.reviewReady = true;
    state.availability = { status: 'unknown' };
    await persist();
    const result = fixed(pricingPrefix + reply, lead, {
      actionType: 'human_handoff', messageCategory: 'service_request',
      handoff: { required: true, reason: 'intake_unclear', callbackRequested: false },
      ...(state.tradeQualification?.hazardType ? { messageCategory: 'emergency', riskFlags: ['safety_hazard'], alertPriority: 'critical' } : {}),
      qualificationReason: reason, intakeReview: { ...state.readiness, problem: state.problem,
        tradeQualification: state.tradeQualification, coverage: state.coverage, serviceNeeded: lead.serviceNeeded, address: lead.address,
        preferredAppointmentTime: lead.preferredAppointmentTime, triageAnswer: state.triageAnswer || '' },
      summary: `${state.serviceDetail || lead.serviceNeeded}; ${lead.address || 'Address not supplied'}; preferred time: ${lead.preferredAppointmentTime || 'not supplied'}; triage: ${state.triageAnswer || 'not supplied'}. Review required: ${reason}.`,
    });
    if (channel === 'voice') {
      checkActive();
      const savedQualification = await AlertService.createHumanHandoffAlert({ businessId: business._id, leadId: lead._id, conversationId: conversation._id,
        providerMessageId: `voice-qualification:${session?._id || conversation._id}:${journeyKey}:${state.readiness.evidenceKey}:${reason}`,
        customerPhone: lead.phone || conversation.customerPhone, customerMessage: text, lead, result });
      if (!savedQualification?.alert?._id) throw Object.assign(new Error('Trade qualification review was not saved.'), { code: 'STAFF_ACTION_NOT_SAVED' });
      checkActive(); state.submitted = true; await persist(); result.outcome = 'callback_saved';
    }
    return result;
  };
  if (state.tradeQualification.status === 'needs_staff_review') {
    if (state.tradeQualification.hazardType) lead.urgency = 'emergency';
    return { completed: true, value: reviewQualification(state.tradeQualification.reason, state.tradeQualification.hazardType ? getEmergencyReply(state.tradeQualification.hazardType) : tradeReviewReply(state.tradeQualification.reason)) };
  }
  if (rejectedDateOnly || rejectedTimeOnly) {
    if (!conversation.bookingState?.appointment) {
      lead.preferredAppointmentTime = [state.date, state.time].filter(Boolean).join(' at ');
      applyBookingStateTransition(conversation, 'intake_preference_rejected', { enabled: business.features?.aiBookingEnabled });
    }
    state.availability = { status: 'not_checked', reason: 'customer_rejected_preference' };
    state.reviewReady = false; state.submitted = false;
    return { completed: true, value: ask('scheduling_correction', `What ${rejectedDateOnly ? 'day' : 'time'} would work instead?${conversation.bookingState?.appointment ? ' Your existing appointment has not been changed.' : ' No appointment is confirmed.'}`) };
  }
  return { completed: false, context: { reviewQualification } };
}
