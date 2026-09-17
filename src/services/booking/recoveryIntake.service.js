import { extractCustomerAddress, addressFromTurn, isRepeatCorrection } from './customerAddress.service.js';
import { isSoftOptOutPhrase } from '../messaging/smsCompliance.service.js';
import { guardServiceRequest } from '../serviceEligibility/serviceEligibility.service.js';
import { patternHasAffirmedSafetyMatch } from '../../helpers/ai/aiGuardrails.js';
import { requestStaffSchedulingReview } from "./staffSchedulingReview.service.js";
import { recoveryLeakQuestion, recoveryCompletionReply } from './recoveryIntakePresentation.service.js';
import { getApprovedServiceEstimate } from './approvedServiceEstimate.service.js';
import { logOperationalError } from '../../helpers/logging/safeLogger.js';
import { pricingReply } from '../messaging/smsTurnPolicy.service.js';
import { classifySmsIntent } from '../messaging/smsIntentClassifier.service.js';
import { findDateRange, parseTimePreference, filterSlotsByTimePreference } from './appointmentPreferenceParser.service.js';
import searchServices from '../../helpers/ai/tools/searchServices.tool.js';
import getAvailability from '../../helpers/ai/tools/getAvailability.tool.js';
import validateServiceArea from '../../helpers/ai/tools/validateServiceArea.tool.js';
import AlertService from '../alert.service.js';
import { isConfirmationQuestion } from './conversationQuestions.service.js';
import { assertDistributedLeaseActive } from '../distributedLease.service.js';
import { assertVoiceTurnActive } from '../voiceTurnContext.service.js';
import { resetUncertainTurns } from '../messaging/uncertainReply.service.js';
import { filterAutomatedSlots, automatedSchedulingNotice } from '../scheduling/automatedSchedulingPolicy.service.js';
import { formatDateKey } from '../scheduling/timezone.service.js';

const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const known = value => clean(value) && !/^(unknown|not provided|n\/a)$/i.test(clean(value));
const leak = /\b(?:leak(?:ing|s)?|overflow(?:ing)?|water spreading)\b/i;
const active = /\b(?:(?:actively|still|currently) (?:leaking|overflowing)|(?:leaking|overflowing) right now|won't stop leaking|will not stop leaking|overflowing|spreading|gushing|flooding)\b/i;
const stopped = /\b(?:(?:not|no longer|stopped) (?:leaking|overflowing|flooding|spreading|gushing)|no (?:active )?(?:leak|overflow|flooding)|(?:leak(?:ing)?|overflow(?:ing)?) (?:has )?stopped|only when|only (?:leaks|leaking|overflows|overflowing))\b/i;
const controlMessage = /^(?:stop|unsubscribe|help|start|unstop)[.! ]*$/i;
const clogQuestion = 'Is water overflowing or backing up into other fixtures?';
const cloggedFixture = value => /\b(?:clogged|blocked|stopped up)\b/i.test(value) && /\b(?:toilet|sink|drain|tub|shower|sewer)\b/i.test(value);
const businessHoursQuestion = /\b(?:what (?:are|time)|when (?:are|do|will)).{0,35}\b(?:hours|open|close)\b/i;
const addressFrom = extractCustomerAddress;
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
export const handleRecoveryIntake = async ({ business, lead, conversation, customerMessage, channel = 'sms', session = null, turnId = '', semanticAssessment = null, recentMessages = [], now = new Date() }) => {
  const text = clean(customerMessage);
  if (isSoftOptOutPhrase(text)) return null;
  if (!text || !lead || !conversation || conversation.humanTakeover || conversation.aiEnabled === false || ['closed', 'archived'].includes(conversation.status)) return null;
  const capturedAddress = addressFromTurn({ customerMessage: text, recentMessages, conversation, knownAddress: known(lead.address) ? lead.address : '' });
  if (capturedAddress) {
    assertDistributedLeaseActive(); assertVoiceTurnActive();
    if (known(lead.address) && capturedAddress !== lead.address && !conversation.bookingState?.appointment) {
      conversation.bookingState = { status: 'not_started' };
      if (conversation.conversationMemory?.recoveryIntake) {
        conversation.conversationMemory.recoveryIntake.availability = { status: 'unknown' };
        conversation.conversationMemory.recoveryIntake.submitted = false;
        conversation.markModified?.('conversationMemory.recoveryIntake');
      }
      await conversation.save?.();
      assertDistributedLeaseActive(); assertVoiceTurnActive();
    }
    lead.address = capturedAddress; await lead.save?.();
  }
  const serviceGuard = await guardServiceRequest({ business, lead, conversation, customerMessage, channel, turnId, semanticAssessment, recentMessages });
  if (serviceGuard) return serviceGuard;
  if (isConfirmationQuestion(text) && !/\b(?:cancel|reschedule|call me|human)\b/i.test(text)) {
    if (!conversation.bookingState?.appointment && !['offering_slots', 'awaiting_confirmation'].includes(conversation.bookingState?.status)) {
      return fixed(confirmationTimingReply({ lead, channel }), lead, { messageCategory: 'appointment_status' });
    }
  }
  // Persistence is mandatory; callers without a durable context use the established flow.
  if (typeof lead.save !== 'function' || typeof conversation.save !== 'function') return null;
  const classification = classifySmsIntent({ business, lead, conversation, customerMessage: text, now });
  if (controlMessage.test(text) || businessHoursQuestion.test(text) ||
      ['human', 'callback', 'cancel', 'reschedule', 'status', 'availabilityInquiry'].some(intent => classification.intents?.[intent])) return null;
  if (channel === 'voice' && (session?.metadata?.callbackCapture?.status || session?.metadata?.currentUnderstanding?.language === 'es' || session?.metadata?.currentUnderstanding?.language === 'other')) return null;
  if (['offering_slots', 'awaiting_confirmation', 'booking', 'pending_business_confirmation', 'booked', 'human_takeover'].includes(conversation.bookingState?.status)) return null;
  const checkActive = () => { assertDistributedLeaseActive(); if (channel === 'voice') assertVoiceTurnActive(); };
  const timezone = business.timezone || 'America/New_York';
  const journeyKey = conversation.orchestration?.recoveryJourneyKey || '';
  const oldState = conversation.conversationMemory?.recoveryIntake;
  const state = oldState?.journeyKey === journeyKey ? { ...oldState } : { journeyKey };
  // Semantic evidence uses the existing metered, schema-validated qualification.
  // It describes the request; it never authorizes a service, price or booking.
  const semantic = semanticAssessment?.isInScope === true &&
    Number.isFinite(semanticAssessment.confidence) && semanticAssessment.confidence >= 60 &&
    !semanticAssessment.guardrail?.usedFallback && !(semanticAssessment.riskFlags?.length) &&
    (!semanticAssessment.decision || ['send', 'send_ai_response', 'send_fixed_response'].includes(semanticAssessment.decision))
    ? semanticAssessment : null;
  const service = classification.entities?.serviceNeeded || (typeof semantic?.serviceNeeded === 'string' ? clean(semantic.serviceNeeded).slice(0, 160) : '');
  if (!state.started && !known(service) && !known(lead.serviceNeeded) && !classification.intents?.scheduling && !capturedAddress && !addressFrom(text)) return null;
  state.started = true;
  if (state.submitted && state.failures >= 2 && known(service)) { state.submitted = false; state.failures = 0; }
  if (known(service) && known(lead.serviceNeeded) && clean(service).toLowerCase() !== clean(lead.serviceNeeded).toLowerCase() &&
      (classification.intents?.correction || classification.intents?.newService)) {
    state.triageResolved = false; state.triagePending = false; state.triageAsked = false;
    delete state.triageAnswer; delete state.leakPattern;
    delete state.clogAsked; delete state.clogPending; delete state.clogResolved;
  }
  if (known(service) && (!known(lead.serviceNeeded) || classification.intents?.correction || classification.intents?.newService)) lead.serviceNeeded = service;
  if (!known(lead.serviceNeeded)) return null;
  const address = capturedAddress || addressFrom(text);
  if (address) lead.address = address;

  const schedulingText = address ? clean(text.replace(address, '')) : text;
  const incomingRange = !/^\d{5}(?:-\d{4})?$/.test(schedulingText) ? findDateRange(schedulingText, timezone, now) : null;
  const incomingTime = parseTimePreference(schedulingText, timezone, now);
  if (incomingRange) state.date = incomingRange.startDate === incomingRange.endDate ? incomingRange.startDate : `${incomingRange.startDate} through ${incomingRange.endDate}`;
  if (incomingTime.targetMinutes !== null || incomingTime.timeOfDay) state.time = incomingTime.exactMinutes !== null ? `${Math.floor(incomingTime.exactMinutes / 60)}:${String(incomingTime.exactMinutes % 60).padStart(2, '0')}` : incomingTime.raw.slice(0, 300);
  if (state.date || state.time) lead.preferredAppointmentTime = [state.date, state.time].filter(Boolean).join(' at ');

  // Keep new detail even if the canonical service remains unchanged. It is
  // bounded, scoped to this recovery journey, and explicitly customer evidence.
  const triageOnlyAnswer = state.triagePending && !classification.entities?.serviceNeeded &&
    (stopped.test(text) || /^(?:yes|yeah|yep|no|nope)[.! ]*$/i.test(text));
  if (known(service) && !triageOnlyAnswer) {
    state.serviceDetail = service;
    state.serviceSourceTurnId = String(turnId);
  }
  const activeEvidence = text.split(/\b(?:but|however)\b|[;.!?]/i).some(clause =>
    !stopped.test(clause) && patternHasAffirmedSafetyMatch(active, clause));
  const stoppedEvidence = stopped.test(text) && !activeEvidence;
  const shortTriageAnswer = state.triagePending && ['leak_activity', 'constraint_condition'].includes(state.field);
  if (state.field === 'constraint_condition' && /^(?:no|nope)[.! ]*$/i.test(text)) state.constraintQuestion = '';
  const wasTriageResolved = state.triageResolved;
  const wasClogResolved = state.clogResolved;
  if (state.clogPending && /^(?:no|nope|yes|yeah|yep)\b|\b(?:only|just) (?:the |this |my )?(?:sink|toilet|drain|tub|shower)|\b(?:not overflowing|no backup|no other fixtures|other fixtures (?:are )?fine)\b/i.test(text)) {
    state.clogPending = false; state.clogResolved = true;
    state.triageAnswer = text.slice(0, 250);
    if (/^(?:yes|yeah|yep)\b/i.test(text) && lead.urgency !== 'emergency') lead.urgency = 'high';
  }
  if (cloggedFixture(`${lead.serviceNeeded} ${text}`) && !state.clogAsked && !leak.test(`${lead.serviceNeeded} ${text}`)) state.clogPending = true;
  const triageRelevant = state.triagePending || leak.test(`${lead.serviceNeeded} ${text}`);
  if (triageRelevant && (stoppedEvidence || activeEvidence || (shortTriageAnswer && /^(?:yes|yeah|yep|no|nope)[.! ]*$/i.test(text)))) {
    state.triageAnswer = text.slice(0, 250);
    state.leakPattern = !activeEvidence && /\bonly (?:when|during)\b/i.test(text) ? 'during_use' : stoppedEvidence || /^(?:no|nope)[.! ]*$/i.test(text) ? 'not_active' : 'active';
  }
  if (activeEvidence) {
    state.triageResolved = true;
    state.triagePending = false;
    if (lead.urgency !== 'emergency') lead.urgency = 'high';
  } else if (state.triageResolved && /\b(?:now|again|started|worse)\b/i.test(text) && leak.test(text) && !stoppedEvidence) {
    state.triageResolved = false;
    state.triageAsked = false;
  }
  const contextHasLeak = leak.test(`${lead.serviceNeeded} ${text}`);
  if (state.triagePending) {
    if (stoppedEvidence || /^(?:no|nope)[.! ]*$/i.test(text)) { state.triagePending = false; state.triageResolved = true; }
    else if (activeEvidence || /^(?:yes|yeah|yep)[.! ]*$/i.test(text)) { state.triagePending = false; state.triageResolved = true; if (lead.urgency !== 'emergency') lead.urgency = 'high'; }
    // A customer may answer another question first. Preserve it without repeating triage.
  } else if (contextHasLeak && !state.triageResolved) {
    if (stoppedEvidence || activeEvidence) { state.triageResolved = true; if (!stoppedEvidence && lead.urgency !== 'emergency') lead.urgency = 'high'; }
    else state.triagePending = true;
  }
  const understoodAnswer = Boolean((!oldState?.started && known(lead.serviceNeeded)) || known(service) || address || incomingRange ||
    incomingTime.targetMinutes !== null || incomingTime.timeOfDay ||
    state.triageResolved !== wasTriageResolved || state.clogResolved !== wasClogResolved || stopped.test(text) || active.test(text));
  // An unanswered field is not proof the customer was unintelligible. Let the
  // existing semantic pipeline answer off-script questions or interpret novel
  // details before choosing a clarification. Do not consume retry budget here.
  if (!understoodAnswer && !classification.intents?.pricing && !semanticAssessment &&
      !(/^\d{5}(?:-\d{4})?$/.test(text) && known(lead.address))) return null;
  let approvedEstimate = '';
  if (classification.intents?.pricing) {
    checkActive();
    try { approvedEstimate = await getApprovedServiceEstimate({ businessId: business._id, serviceNeeded: lead.serviceNeeded, customerMessage: text }); }
    catch (error) { logOperationalError('intake.price_lookup_failed', error, { businessId: business._id }); }
    checkActive();
  }
  const pricingPrefix = classification.intents?.pricing ? `${approvedEstimate || "I don't have a confirmed price for that work."} ` : '';
  const persist = async () => {
    checkActive(); await lead.save(); checkActive();
    if (understoodAnswer) { await resetUncertainTurns(conversation); checkActive(); }
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
    const addressAcknowledgement = channel === 'voice' && address && /\b\d{5}\b/.test(address) ? `I have ZIP ${address.match(/\b\d{5}\b/)[0].split('').join(' ')}. ` : '';
    const acknowledged = !wasTriageResolved && state.triageResolved && state.leakPattern === 'during_use'
      ? 'Thanks for clarifying that it leaks during use. Please avoid using it for now. '
      : '';
    return fixed(`${isRepeatCorrection(text) && address ? 'Sorry, I have your address now. ' : ''}${pricingPrefix}${addressAcknowledgement}${acknowledged}${reply}`, lead);
  };
  if (state.triagePending && !state.triageAsked) {
    state.triageAsked = true; await persist();
    return ask('leak_activity', recoveryLeakQuestion(state.serviceDetail || lead.serviceNeeded));
  }
  if (state.clogPending && !state.clogAsked) {
    state.clogAsked = true;
    return ask('clog_scope', clogQuestion);
  }
  if (state.submitted) {
    await persist();
    const reply = classification.intents?.pricing
      ? `${approvedEstimate || "I don't have an approved estimate for that request."} The service request still needs team review.`
      : 'Your additional details are saved with this conversation. The service request still needs team review.';
    return fixed(reply, lead);
  }
  // Pricing is a question within intake, not a reason to discard its facts.
  if (classification.intents?.pricing) {
    await persist();
    const priceResponse = pricingReply({ business, lead, triageResolved: state.triageResolved === true });
    const reply = approvedEstimate ? `${approvedEstimate} ${priceResponse.replace(`For ${clean(lead.serviceNeeded)}, I don't have a confirmed price yet.`, '').trim()}` : priceResponse;
    return fixed(reply, lead, { messageCategory: 'pricing_request' });
  }
  if (business.features?.aiBookingEnabled === true) {
    if (state.triagePending) return ask('leak_activity', 'Is water leaking right now?');
    if (state.clogPending) return ask('clog_scope', clogQuestion);
    await persist(); return null;
  }
  await persist();
  if (!known(lead.address)) return ask('address', 'What is the service address?');
  if (!/\b\d{5}(?:-\d{4})?\b/.test(lead.address)) return ask('postal_code', 'What is the ZIP code for that address?');
  const preference = clean(lead.preferredAppointmentTime);
  const range = findDateRange(preference, timezone, now);
  const time = parseTimePreference(state.time || preference, timezone, now);
  if (!range) return ask('date', 'What day would you prefer? The business will need to approve the appointment.');
  const sameDayRequest = range.startDate === formatDateKey(now, timezone) && range.endDate === range.startDate;
  if (sameDayRequest && time.targetMinutes === null && !time.timeOfDay) {
    return requestStaffSchedulingReview({ business, lead, conversation, customerMessage: text, channel, now });
  }
  if (time.targetMinutes === null && !time.timeOfDay) return ask('time', 'What time works best that day?');
  if (state.triagePending) return ask('leak_activity', 'Before I finish, is water leaking right now?');
  if (state.clogPending) return ask('clog_scope', clogQuestion);

  let availabilityNote = "I couldn't verify that time's availability; it needs team review.";
  let ready = true;
  state.availability = { status: 'unknown', checkedAt: now.toISOString(), timezone };
  try {
    const postalCode = lead.address.match(/\b\d{5}\b/)[0];
    const area = await validateServiceArea({ businessId: business._id, postalCode }); checkActive();
    if (area.supported === false) {
      ready = false; availabilityNote = 'That address is outside the configured service area. Is there another service address?';
    } else {
      const services = await searchServices({ businessId: business._id, query: lead.serviceNeeded }); checkActive();
      if (services.length === 1 && Number.isFinite(services[0].score) && services[0].score > 0) {
        const available = await getAvailability({ business, leadId: lead._id, conversationId: conversation._id, serviceQuery: lead.serviceNeeded, serviceOfferingId: services[0].id, startDate: range.startDate, endDate: range.endDate, postalCode }); checkActive();
        if (available.supportedServiceArea === false) { ready = false; availabilityNote = 'That address needs a service-area review before scheduling.'; }
        else if (Array.isArray(available.slots)) {
          const future = filterAutomatedSlots(available.slots, now);
          const matches = filterSlotsByTimePreference(future, time, timezone);
          if (matches.length) {
            availabilityNote = `${slotLabel(matches[0], timezone)} is currently available, subject to business approval.`;
            state.availability = { status: 'available', checkedAt: now.toISOString(), serviceOfferingId: String(services[0].id), startAt: matches[0].startAt, endAt: matches[0].endAt, timezone, provider: available.provider || '' };
          }
          else {
            ready = false;
            state.availability.status = 'no_matching_slot';
            const alternatives = future.slice(0, 2).map(slot => slotLabel(slot, timezone));
            availabilityNote = alternatives.length ? `That time isn't available. Current openings: ${alternatives.join(' or ')}. Which works for you?` : `${automatedSchedulingNotice} There are no eligible openings in that window. What later day could work?`;
          }
        }
      }
    }
  } catch (error) {
    if (['VOICE_STALE_TURN', 'DISTRIBUTED_LEASE_LOST'].includes(error?.code)) throw error;
    // A provider failure is unknown availability, never an empty calendar or a confirmed slot.
  }
  if (!ready && sameDayRequest && state.availability.status === 'no_matching_slot') {
    return requestStaffSchedulingReview({ business, lead, conversation, customerMessage: text, channel, now });
  }
  if (!ready) return ask('available_preference', availabilityNote);
  state.reviewReady = true;
  state.serviceNeeded = lead.serviceNeeded;
  state.address = lead.address;
  state.preferredAppointmentTime = lead.preferredAppointmentTime;
  await persist();
  const intakeReview = { reviewReady: true, journeyKey, serviceNeeded: state.serviceNeeded, serviceDetail: state.serviceDetail || '', address: state.address, preferredAppointmentTime: state.preferredAppointmentTime, triageAnswer: state.triageAnswer || '', availability: state.availability };
  const result = fixed(availabilityNote, lead, { intakeReady: true, intakeReview, summary: `${state.serviceDetail || lead.serviceNeeded}; ${state.triageAnswer || ''}; ${lead.address}; requested ${lead.preferredAppointmentTime}`, messageCategory: 'appointment_preference', intakeCompletionReply: recoveryCompletionReply({ lead, state, channel }) });
  if (ready && channel === 'voice') {
    checkActive();
    await AlertService.createHumanHandoffAlert({ businessId: business._id, leadId: lead._id, conversationId: conversation._id, providerMessageId: `voice-intake:${session?._id || conversation._id}:${journeyKey}`, customerPhone: lead.phone || conversation.customerPhone, customerName: lead.customerName, customerMessage: text, lead, result: { ...result, handoff: { reason: 'intake_complete' } } });
    checkActive(); state.submitted = true; await persist();
    result.reply = result.intakeCompletionReply;
    result.outcome = 'callback_saved';
  }
  return result;
};
