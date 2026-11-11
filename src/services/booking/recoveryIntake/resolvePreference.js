import { applyBookingStateTransition, clean, clogQuestionFor, extractCustomerPostalCode, findDateRange, formatDateKey, known, leakContext, parseTimePreference, recoveryLeakQuestion, requestStaffSchedulingReview } from './context.js';

export async function resolvePreference(context) {
  const { lead, ask, timezone, now, state, business, conversation, text, channel, persist } = context;
if (!known(lead.address)) return { completed: true, value: ask('address', 'What is the service address?') };
  if (!extractCustomerPostalCode(lead.address)) return { completed: true, value: ask('postal_code', 'What is the ZIP code for that address?') };
  const preference = clean(lead.preferredAppointmentTime);
  const range = findDateRange(preference, timezone, now);
  const time = parseTimePreference(state.time || preference, timezone, now);
  if (!range) return { completed: true, value: ask('date', 'What day would you prefer? The business will need to approve the appointment.') };
  const sameDayRequest = range.startDate === formatDateKey(now, timezone) && range.endDate === range.startDate;
  if (sameDayRequest && time.targetMinutes === null && !time.timeOfDay) {
    return { completed: true, value: requestStaffSchedulingReview({ business, lead, conversation, customerMessage: text, channel, now }) };
  }
  // The booking engine can offer times for a supplied date; manual intake
  // collects a preference. Both modes share address and qualification rules.
  if (business.features?.aiBookingEnabled === true && !state.triagePending && !state.clogPending) {
    if (!conversation.bookingState?.status || conversation.bookingState.status === 'not_started') {
      applyBookingStateTransition(conversation, 'intake_booking_started');
    }
    await persist(); return { completed: true, value: null };
  }
  if (time.targetMinutes === null && !time.timeOfDay) return { completed: true, value: ask('time', 'What time works best that day?') };
  if (state.triagePending) return { completed: true, value: ask(leakContext(state.serviceDetail || lead.serviceNeeded) === 'unknown_fluid' ? 'leak_substance' : 'leak_activity', recoveryLeakQuestion(state.serviceDetail || lead.serviceNeeded)) };
  if (state.clogPending) return { completed: true, value: ask('clog_scope', clogQuestionFor(`${lead.serviceNeeded} ${state.serviceDetail || ''} ${text}`)) };
  return { completed: false, context: { time, range, sameDayRequest } };
}
