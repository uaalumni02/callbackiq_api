import { applyBookingStateTransition, completionClarification, coverageReviewReply, extractCustomerPostalCode, fixed, formatDateKey, known, logOperationalError, requestStaffSchedulingReview, validateServiceArea } from './context.js';

export async function verifyCoverage(context) {
  const { lead, business, checkActive, state, now, conversation, ask, reviewQualification, coverageQuestion, classification, incomingRange, incomingTime, persist, timezone, text, channel, questions } = context;
const postalCode = extractCustomerPostalCode(lead.address);
  if (known(lead.address) && postalCode) {
    try {
      const coverage = await validateServiceArea({ businessId: business._id, postalCode }); checkActive();
      state.coverage = { ...coverage, address: lead.address, postalCode, checkedAt: now.toISOString() };
    } catch (error) {
      if (['VOICE_STALE_TURN', 'DISTRIBUTED_LEASE_LOST'].includes(error?.code)) throw error;
      state.coverage = { supported: null, status: 'unknown', reason: 'service_area_validation_unavailable',
        address: lead.address, postalCode, checkedAt: now.toISOString() };
      logOperationalError('intake.coverage_lookup_failed', error, { businessId: business._id });
    }
    if (state.coverage.supported !== true) {
      state.availability = { status: 'unknown' };
      if (!conversation.bookingState?.appointment) {
        applyBookingStateTransition(conversation, 'intake_coverage_unavailable');
      }
      if (state.coverage.supported === false && !conversation.bookingState?.appointment) {
        state.reviewReady = false; state.submitted = false;
        return { completed: true, value: ask('coverage', 'That address is outside the configured service area, so I cannot offer appointment times there. If the address is incorrect, please send the correction.') };
      }
      state.coverageReviewPending = true;
      return { completed: true, value: reviewQualification(state.coverage.reason, coverageReviewReply({
        lead, conversation, state, coverageQuestion,
        availabilityQuestion: classification.intents?.availabilityInquiry,
        preferenceCaptured: Boolean(incomingRange || incomingTime.targetMinutes !== null || incomingTime.timeOfDay),
      })) };
    }
  } else {
    state.coverage = { supported: null, status: 'unknown', reason: 'zip_code_required', address: lead.address || '' };
  }
  if (state.coverage.supported === true && state.coverageReviewPending && !conversation.bookingState?.appointment) {
    state.coverageReviewPending = false; state.reviewReady = false; state.submitted = false;
  }
  if (coverageQuestion) {
    await persist();
    if (state.coverage.supported === true) {
      return { completed: true, value: fixed(`I rechecked the service area: ZIP ${postalCode} is covered. ${conversation.bookingState?.appointment
        ? 'This check does not change your existing appointment.'
        : 'Availability and business approval are still required; no appointment is confirmed.'}`, lead) };
    }
    return { completed: true, value: ask('postal_code', known(lead.address) ? 'What is the ZIP code for that address so I can check coverage?' : 'What is the service address, including ZIP code, so I can check coverage?') };
  }
  // Existing appointments remain manageable. New or unresolved details are
  // reviewed without changing their committed service, location, or time.
  if (state.problem.status === 'needs_staff_review') {
    return { completed: true, value: reviewQualification(state.problem.reason, "The problem details need team review. Your request is not a confirmed appointment, and I cannot guarantee a response time.") };
  }
  if (state.problem.status === 'needs_clarification' && !conversation.bookingState?.appointment) {
    state.problem.asked = true;
    return { completed: true, value: ask('problem_detail', state.problem.question) };
  }
  if (state.tradeQualification.status === 'needs_clarification' && !conversation.bookingState?.appointment && incomingRange?.startDate === formatDateKey(now, timezone)) {
    await persist();
    return { completed: true, value: requestStaffSchedulingReview({ business, lead, conversation, customerMessage: text, channel, now }) };
  }
  if (state.tradeQualification.status === 'needs_clarification' && !conversation.bookingState?.appointment) {
    state.tradeQualification.asked = true;
    return { completed: true, value: ask('trade_detail', state.tradeQualification.question) };
  }
  if (questions.ambiguous || state.unresolvedQuestions.some(q => q.kind === 'completion_meaning')) {
    return { completed: true, value: ask('question_meaning', completionClarification) };
  }
  return { completed: false, context: { postalCode } };
}
