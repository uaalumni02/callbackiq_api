import { classifySmsIntent } from '../messaging/smsIntentClassifier.service.js';
import { findDateRange, parseTimePreference, filterSlotsByTimePreference } from './appointmentPreferenceParser.service.js';
import searchServices from '../../helpers/ai/tools/searchServices.tool.js';
import getAvailability from '../../helpers/ai/tools/getAvailability.tool.js';
import validateServiceArea from '../../helpers/ai/tools/validateServiceArea.tool.js';
import AlertService from '../alert.service.js';
import { isConfirmationQuestion } from './conversationQuestions.service.js';
import { assertVoiceTurnActive } from '../voiceTurnContext.service.js';

const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const known = value => clean(value) && !/^(unknown|not provided|n\/a)$/i.test(clean(value));
const leak = /\b(?:leak(?:ing|s)?|overflow(?:ing)?|water spreading)\b/i;
const active = /\b(?:(?:actively|still|currently) (?:leaking|overflowing)|(?:leaking|overflowing) right now|won't stop leaking|will not stop leaking|overflowing|spreading|gushing|flooding)\b/i;
const stopped = /\b(?:not leaking|no (?:active )?leak|stopped leaking|leak(?:ing)? (?:has )?stopped|no longer leaking|only when|only (?:leaks|leaking))\b/i;
const bypass = /\b(?:stop|unsubscribe|help|cancel|reschedule|call me|human|representative|speak to|talk to|gas|smoke|sparking|fire|injured|911|waitlist|wait list|emergency time|how much|price|pricing|cost|hours|open|close)\b/i;
const addressFrom = text => {
  const value = clean(text).replace(/^(?:my |the )?address is\s+/i, '').replace(/^(?:i am at|i'm at|we are at|we're at|at)\s+/i, '');
  return /^\d{1,7}[a-z]?\s+.+\b(?:st(?:reet)?|ave(?:nue)?|rd|road|dr(?:ive)?|ln|lane|ct|court|blvd|boulevard|way|pkwy|parkway|place|pl|circle|cir|trail|trl|terrace|ter|highway|hwy)\b/i.test(value) ? value.slice(0, 500) : '';
};
const fixed = (reply, lead, extra = {}) => ({
  decision: 'send_fixed_response', actionType: 'request_information', messageCategory: 'service_request',
  reply, serviceNeeded: lead.serviceNeeded || '', urgency: lead.urgency || 'medium', address: lead.address || '',
  preferredAppointmentTime: lead.preferredAppointmentTime || '', shouldAlertOwner: false, riskFlags: [],
  guardrail: { skipAI: true, usedFallback: false, reason: 'shared_recovery_intake' }, intakeReady: false, ...extra,
});
export const confirmationTimingReply = ({ lead = {}, channel = 'sms' } = {}) =>
  `The business must approve the appointment. I don't have a confirmation timeframe.${!known(lead.address) ? ' What is the service address?' : channel === 'voice' ? ' Please wait for confirmation before expecting a visit.' : ''}`;

const slotLabel = (slot, timezone) => new Intl.DateTimeFormat('en-US', {
  timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(new Date(slot.startAt));

// This layer captures facts and reads scheduling data. It never creates an appointment.
// The existing booking engine still owns every automatically booked appointment.
export const handleRecoveryIntake = async ({ business, lead, conversation, customerMessage, channel = 'sms', session = null, turnId = '', now = new Date() }) => {
  const text = clean(customerMessage);
  if (!text || !lead || !conversation || conversation.humanTakeover || ['closed', 'archived'].includes(conversation.status)) return null;
  if (isConfirmationQuestion(text) && !/\b(?:cancel|reschedule|call me|human)\b/i.test(text)) {
    if (!conversation.bookingState?.appointment && !['offering_slots', 'awaiting_confirmation'].includes(conversation.bookingState?.status)) {
      return fixed(confirmationTimingReply({ lead, channel }), lead, { messageCategory: 'appointment_status' });
    }
  }
  // Persistence is mandatory; callers without a durable context use the established flow.
  if (typeof lead.save !== 'function' || typeof conversation.save !== 'function') return null;
  if (bypass.test(text) || conversation.orchestration?.handoffReason) return null;
  if (channel === 'voice' && (session?.metadata?.callbackCapture?.status || session?.metadata?.currentUnderstanding?.language === 'es' || session?.metadata?.currentUnderstanding?.language === 'other')) return null;
  if (['offering_slots', 'awaiting_confirmation', 'booking', 'pending_business_confirmation', 'booked', 'human_takeover'].includes(conversation.bookingState?.status)) return null;
  const checkActive = () => { if (channel === 'voice') assertVoiceTurnActive(); };
  const timezone = business.timezone || 'America/New_York';
  const journeyKey = conversation.orchestration?.recoveryJourneyKey || '';
  const oldState = conversation.conversationMemory?.recoveryIntake;
  const state = oldState?.journeyKey === journeyKey ? { ...oldState } : { journeyKey };
  if (state.submitted) return fixed('Your service request is saved for team review. The appointment still needs business confirmation.', lead);
  const classification = classifySmsIntent({ business, conversation, customerMessage: text, now });
  const service = classification.entities?.serviceNeeded;
  if (!state.started && !known(service) && !classification.intents?.scheduling && !addressFrom(text)) return null;
  state.started = true;
  if (known(service) && (!known(lead.serviceNeeded) || classification.intents?.correction)) lead.serviceNeeded = service;
  if (!known(lead.serviceNeeded)) return null;
  const address = addressFrom(text);
  if (address) lead.address = address;
  if (!address && /^\d{5}(?:-\d{4})?$/.test(text) && known(lead.address) && !/\b\d{5}\b/.test(lead.address)) lead.address = `${lead.address}, ${text}`;

  const incomingRange = !address && !/^\d{5}(?:-\d{4})?$/.test(text) ? findDateRange(text, timezone, now) : null;
  const incomingTime = parseTimePreference(address ? '' : text, timezone);
  if (incomingRange) state.date = incomingRange.startDate === incomingRange.endDate ? incomingRange.startDate : `${incomingRange.startDate} through ${incomingRange.endDate}`;
  if (incomingTime.targetMinutes !== null || incomingTime.timeOfDay) state.time = incomingTime.exactMinutes !== null ? `${Math.floor(incomingTime.exactMinutes / 60)}:${String(incomingTime.exactMinutes % 60).padStart(2, '0')}` : incomingTime.raw.slice(0, 300);
  if (state.date || state.time) lead.preferredAppointmentTime = [state.date, state.time].filter(Boolean).join(' at ');

  const contextHasLeak = leak.test(`${lead.serviceNeeded} ${text}`);
  if (state.triagePending) {
    if (stopped.test(text) || /^(?:no|nope)[.! ]*$/i.test(text)) { state.triagePending = false; state.triageResolved = true; }
    else if (active.test(text) || /^(?:yes|yeah|yep)[.! ]*$/i.test(text)) { state.triagePending = false; state.triageResolved = true; if (lead.urgency !== 'emergency') lead.urgency = 'high'; }
    // A customer may answer another question first. Preserve it without repeating triage.
  } else if (contextHasLeak && !state.triageResolved) {
    if (stopped.test(text) || active.test(text)) { state.triageResolved = true; if (!stopped.test(text) && lead.urgency !== 'emergency') lead.urgency = 'high'; }
    else state.triagePending = true;
  }
  const persist = async () => {
    checkActive(); await lead.save(); checkActive();
    if (conversation.set) conversation.set('conversationMemory.recoveryIntake', state);
    else conversation.conversationMemory = { ...(conversation.conversationMemory || {}), recoveryIntake: state };
    conversation.markModified?.('conversationMemory.recoveryIntake');
    await conversation.save(); checkActive();
  };
  const ask = async (field, reply) => {
    const facts = JSON.stringify([lead.serviceNeeded, lead.address, lead.preferredAppointmentTime, state.triageResolved]);
    if (!turnId || state.lastTurnId !== String(turnId)) state.failures = state.field === field && state.lastFacts === facts ? Math.min(2, (state.failures || 0) + 1) : 0;
    state.lastTurnId = String(turnId);
    state.field = field; state.lastFacts = facts;
    await persist();
    if (state.failures >= 2) {
      const result = fixed("I've saved your details for team review so you don't need to repeat them. I don't have a response timeframe.", lead, { actionType: 'human_handoff', handoff: { required: true, reason: 'intake_unclear', callbackRequested: false } });
      if (channel === 'voice') {
        checkActive();
        await AlertService.createHumanHandoffAlert({ businessId: business._id, leadId: lead._id, conversationId: conversation._id, providerMessageId: `voice-unclear:${session?._id || conversation._id}:${journeyKey}`, customerPhone: lead.phone || conversation.customerPhone, customerMessage: text, lead, result });
        checkActive(); state.submitted = true; await persist(); result.outcome = 'callback_saved';
      }
      return result;
    }
    return fixed(reply, lead);
  };
  if (state.triagePending && !state.triageAsked) {
    state.triageAsked = true; await persist();
    return ask('leak_activity', "Is water leaking or overflowing right now, or only when the toilet is used?".replace('the toilet', /toilet/i.test(lead.serviceNeeded) ? 'the toilet' : 'the fixture'));
  }
  if (business.features?.aiBookingEnabled === true) {
    if (state.triagePending) return ask('leak_activity', 'Is water leaking right now?');
    await persist(); return null;
  }
  await persist();
  if (!known(lead.address)) return ask('address', 'What is the service address?');
  if (!/\b\d{5}(?:-\d{4})?\b/.test(lead.address)) return ask('postal_code', 'What is the ZIP code for that address?');
  const preference = clean(lead.preferredAppointmentTime);
  const range = findDateRange(preference, timezone, now);
  const time = parseTimePreference(preference, timezone);
  if (!range) return ask('date', 'What day works best for you?');
  if (time.targetMinutes === null && !time.timeOfDay) return ask('time', 'What time works best that day?');
  if (state.triagePending) return ask('leak_activity', 'Before I finish, is water leaking right now?');

  let availabilityNote = "I couldn't verify that time's availability; it needs team review.";
  let ready = true;
  try {
    const postalCode = lead.address.match(/\b\d{5}\b/)[0];
    const area = await validateServiceArea({ businessId: business._id, postalCode }); checkActive();
    if (area.supported === false) {
      ready = false; availabilityNote = 'That address is outside the configured service area. Is there another service address?';
    } else {
      const services = await searchServices({ businessId: business._id, query: lead.serviceNeeded }); checkActive();
      if (services.length === 1) {
        const available = await getAvailability({ business, serviceOfferingId: services[0].id, startDate: range.startDate, endDate: range.endDate, postalCode }); checkActive();
        if (available.supportedServiceArea === false) { ready = false; availabilityNote = 'That address needs a service-area review before scheduling.'; }
        else if (Array.isArray(available.slots)) {
          const future = available.slots.filter(slot => new Date(slot.startAt) > now);
          const matches = filterSlotsByTimePreference(future, time, timezone);
          if (matches.length) availabilityNote = `${slotLabel(matches[0], timezone)} is currently available, subject to business approval.`;
          else {
            ready = false;
            const alternatives = future.slice(0, 2).map(slot => slotLabel(slot, timezone));
            availabilityNote = alternatives.length ? `That time isn't available. Current openings: ${alternatives.join(' or ')}. Which works for you?` : "There are no available openings in that window. What other day could work?";
          }
        }
      }
    }
  } catch (error) {
    if (error?.code === 'VOICE_STALE_TURN') throw error;
    // A provider failure is unknown availability, never an empty calendar or a confirmed slot.
  }
  if (!ready) return ask('available_preference', availabilityNote);
  const result = fixed(availabilityNote, lead, { intakeReady: ready, messageCategory: 'appointment_preference', intakeCompletionReply: `Your service request is saved for team review. ${availabilityNote} The appointment is not confirmed.` });
  if (ready && channel === 'voice') {
    checkActive();
    await AlertService.createHumanHandoffAlert({ businessId: business._id, leadId: lead._id, conversationId: conversation._id, providerMessageId: `voice-intake:${session?._id || conversation._id}:${journeyKey}`, customerPhone: lead.phone || conversation.customerPhone, customerName: lead.customerName, customerMessage: text, lead, result: { ...result, handoff: { reason: 'intake_complete' } } });
    checkActive(); state.submitted = true; await persist();
    result.reply = result.intakeCompletionReply;
    result.outcome = 'callback_saved';
  }
  return result;
};
