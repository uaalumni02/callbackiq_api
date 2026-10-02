import { tradeLeakQuestion } from '../trades/tradeProfiles.service.js';
import { SMS_MAX_LENGTH, truncateText } from '../../helpers/ai/aiGuardrails.js';

const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
export const recoveryLeakQuestion = service => {
  const contextual = tradeLeakQuestion(service);
  if (contextual) return contextual;
  const fixture = clean(service).match(/\b(bathtub|tub|toilet|shower|sink|water heater|dishwasher|washing machine|pipe)\b/i)?.[1]?.toLowerCase();
  return fixture
    ? `Is the ${fixture === 'tub' ? 'bathtub' : fixture} leaking right now, or only when you use it?`
    : 'Is water leaking right now, or only when you use it?';
};

export const recoveryPreferenceLabel = state => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(state?.date || '')
    ? new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${state.date}T12:00:00Z`))
    : clean(state?.date);
  const clock = clean(state?.time).match(/^(\d{1,2}):(\d{2})$/);
  const time = clock ? `${Number(clock[1]) % 12 || 12}${clock[2] === '00' ? '' : `:${clock[2]}`} ${Number(clock[1]) >= 12 ? 'PM' : 'AM'}` : clean(state?.time);
  return [date, time].filter(Boolean).join(' at ') || clean(state?.preferredAppointmentTime);
};

// The caller must only send this text after the durable review alert succeeds.
// Keep the unconfirmed state and next step within the existing SMS limit.
export const recoveryCompletionReply = ({ lead, state, channel = 'sms' }) => {
  const preference = truncateText(recoveryPreferenceLabel(state), 55);
  const qualification = state.leakPattern === 'during_use' ? ' (leaks during use)' : '';
  const service = clean(state.serviceDetail || lead.serviceNeeded);
  const address = clean(lead.address);
  const opening = 'Request saved for team review. The appointment is not confirmed.';
  const availability = state.availability?.status === 'available' && state.readiness?.availabilityVerified === true
    ? 'Time currently available; business approval required.'
    : state.availability?.status === 'no_matching_slot' ? 'The requested time is unavailable.'
    : state.availability?.status === 'check_failed' ? 'Availability could not be checked; staff must verify it.'
    : 'Availability needs staff review.';
  const ending = 'Please wait for confirmation before expecting a technician.';
  const compose = (serviceText, addressText) => `${opening} ${serviceText}${qualification}; ${addressText}. Requested: ${preference}. ${availability} ${ending}`;
  if (channel === 'voice') return compose(truncateText(service, 120), truncateText(address, 160));
  const overhead = compose('', '').length;
  const budget = Math.max(0, SMS_MAX_LENGTH - overhead);
  const serviceBudget = Math.min(service.length, Math.max(25, budget - Math.min(address.length, 160)));
  return compose(truncateText(service, serviceBudget), truncateText(address, Math.max(0, budget - serviceBudget)));
};
