import { assessTradeQualification, tradeReviewReply } from '../trades/tradeQualification.service.js';
import { leakContext } from '../trades/tradeProfiles.service.js';
import { confirmationFollowUpReply } from './confirmationFollowUp.service.js';
import { schedulingEvidence } from './schedulingEvidence.service.js';
import { completionClarification, updateRequestQuestions, normalizeRequestService } from './requestQuestionPolicy.service.js';
import { assessProblemClarity, buildRequestReadiness, requestEvidenceKey } from "./requestQualificationPolicy.service.js";
import { extractCustomerAddress, addressFromTurn, resolveRequestAddress, isRepeatCorrection, extractCustomerPostalCode } from './customerAddress.service.js';
import { isSoftOptOutPhrase } from '../messaging/smsCompliance.service.js';
import { guardServiceRequest } from '../serviceEligibility/serviceEligibility.service.js';
import { patternHasAffirmedSafetyMatch, getEmergencyReply } from '../../helpers/ai/aiGuardrails.js';
import { requestStaffSchedulingReview } from "./staffSchedulingReview.service.js";
import { recoveryLeakQuestion, recoveryCompletionReply } from './recoveryIntakePresentation.service.js';
import { getApprovedServiceEstimate } from './approvedServiceEstimate.service.js';
import { logOperationalError } from '../../helpers/logging/safeLogger.js';
import { pricingReply } from '../messaging/smsTurnPolicy.service.js';
import { classifySmsIntent } from '../messaging/smsIntentClassifier.service.js';
import { findDateRange, parseTimePreference, formatTimePreferenceLabel, filterSlotsByTimePreference } from './appointmentPreferenceParser.service.js';
import searchServices from '../../helpers/ai/tools/searchServices.tool.js';
import getAvailability from '../../helpers/ai/tools/getAvailability.tool.js';
import validateServiceArea from '../../helpers/ai/tools/validateServiceArea.tool.js';
import AlertService from '../alert.service.js';
import { isCoverageQuestion, coverageReviewReply, currentCoverage } from './coverageConversation.service.js';
import { isConfirmationQuestion } from './conversationQuestions.service.js';
import { assertDistributedLeaseActive } from '../distributedLease.service.js';
import { assertVoiceTurnActive } from '../voiceTurnContext.service.js';
import { resetUncertainTurns } from '../messaging/uncertainReply.service.js';
import { filterAutomatedSlots } from '../scheduling/automatedSchedulingPolicy.service.js';
import { formatDateKey } from '../scheduling/timezone.service.js';

const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const known = value => clean(value) && !/^(unknown|not provided|n\/a)$/i.test(clean(value));
const leak = /\b(?:leak(?:ing|s)?|overflow(?:ing)?|water spreading)\b/i;
const active = /\b(?:(?:actively|still|currently) (?:leaking|overflowing)|(?:leaking|overflowing) (?:right now|constantly|continuously|nonstop|all the time)|(?:constantly|continuously) (?:leaking|overflowing)|won't stop leaking|will not stop leaking|overflowing|spreading|gushing|flooding)\b/i;
const stopped = /\b(?:(?:not|isn['’]?t|aren['’]?t|no longer|stopped) (?:(?:actively|currently|still) )?(?:leaking|overflowing|flooding|spreading|gushing)|(?:doesn['’]?t|does not) (?:leak|overflow)|no (?:active )?(?:leak(?:ing|s)?|overflow(?:ing)?|flooding)|(?:leak(?:ing)?|overflow(?:ing)?) (?:has )?stopped|only when|only (?:leaks|leaking|overflows|overflowing))\b/i;
const controlMessage = /^(?:stop|unsubscribe|help|start|unstop)[.! ]*$/i;
const clogQuestion = 'Is water overflowing or backing up into other fixtures?';
// Do not re-ask what the customer already answered ("it is not overflowing").
const noOverflowStated = value => /\b(?:not|isn['’]?t|no|without)\s+(?:[a-z]+\s+){0,3}(?:overflow(?:ing)?|flood(?:ing|ed)?)\b/i.test(clean(value));
const clogQuestionFor = context => noOverflowStated(context)
  ? 'Thanks, I noted it is not overflowing. Is it backing up into any other sinks, tubs, or toilets?'
  : clogQuestion;
const cloggedFixture = value => /\b(?:clogged|blocked|stopped up)\b/i.test(value) && /\b(?:toilet|sink|drain|tub|shower|sewer)\b/i.test(value);
const businessHoursQuestion = /\b(?:what (?:are|time)|when (?:are|do|will)).{0,35}\b(?:hours|open|close)\b/i;
const addressFrom = extractCustomerAddress;
const fixed = (reply, lead, extra = {}) => ({
  decision: 'send_fixed_response', actionType: 'request_information', messageCategory: 'service_request',
  reply, serviceNeeded: lead.serviceNeeded || '', urgency: lead.urgency || 'medium', address: lead.address || '',
  preferredAppointmentTime: lead.preferredAppointmentTime || '', shouldAlertOwner: false, riskFlags: [],
  guardrail: { skipAI: true, usedFallback: false, reason: 'shared_recovery_intake' }, intakeReady: false, ...extra,
});
export const confirmationTimingReply = ({ lead = {}, conversation = {}, channel = 'sms' } = {}) => {
  const reply = confirmationFollowUpReply({ lead, conversation, channel });
  return reply + (currentCoverage(conversation, lead)?.supported === null ? ' Service-area coverage still needs team review.' : '') +
    (!known(lead.address) ? ' What is the service address?' : '');
};

const slotLabel = (slot, timezone) => new Intl.DateTimeFormat('en-US', {
  timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(new Date(slot.startAt));

// This layer captures facts and reads scheduling data. It never creates an appointment.
// The existing booking engine still owns every automatically booked appointment.
export const handleRecoveryIntake = async ({ business, lead, conversation, customerMessage, channel = 'sms', session = null, turnId = '', semanticAssessment = null, recentMessages = [], reviewOnly = false, now = new Date() }) => {
  const text = clean(customerMessage);
  if (isSoftOptOutPhrase(text)) return null;
  if (!text || !lead || !conversation || conversation.humanTakeover || conversation.aiEnabled === false || ['closed', 'archived'].includes(conversation.status)) return null;
  const existingAddress = resolveRequestAddress({ lead, conversation });
  const capturedAddress = addressFromTurn({ customerMessage: text, recentMessages, conversation, knownAddress: existingAddress });
  if (!capturedAddress && existingAddress && existingAddress !== lead.address) {
    assertDistributedLeaseActive(); assertVoiceTurnActive();
    lead.address = existingAddress; await lead.save?.();
  }
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
      return fixed(confirmationTimingReply({ lead, conversation, channel }), lead, { messageCategory: 'appointment_status' });
    }
  }
  // Persistence is mandatory; callers without a durable context use the established flow.
  if (typeof lead.save !== 'function' || typeof conversation.save !== 'function') return null;
  const classification = classifySmsIntent({ business, lead, conversation, customerMessage: text, now });
  const coverageQuestion = isCoverageQuestion(text);
  if (controlMessage.test(text) || businessHoursQuestion.test(text) ||
      ['human', 'callback', 'cancel', 'reschedule', 'status'].some(intent => classification.intents?.[intent])) return null;
  if (channel === 'voice' && (session?.metadata?.callbackCapture?.status || session?.metadata?.currentUnderstanding?.language === 'es' || session?.metadata?.currentUnderstanding?.language === 'other')) return null;
  const bookingActive = reviewOnly || ['offering_slots', 'awaiting_confirmation', 'booking', 'pending_business_confirmation', 'booked', 'human_takeover'].includes(conversation.bookingState?.status);
  // Slot selections and confirmations still belong to the booking engine,
  // including expiry and availability rechecks. A missing intake memory is not
  // evidence that a numeric option is a newly supplied service fact.
  if (bookingActive && !reviewOnly && !classification.intents?.availabilityInquiry && !capturedAddress && !classification.entities?.serviceNeeded &&
      (/^(?:option\s*)?\d+[.! ]*$/i.test(text) || /^(?:yes|yeah|yep|no|nope|confirm|okay|ok)[.! ]*$/i.test(text) || classification.intents?.scheduling)) return null;
  const checkActive = () => { assertDistributedLeaseActive(); if (channel === 'voice') assertVoiceTurnActive(); };
  const timezone = business.timezone || 'America/New_York';
  const journeyKey = conversation.orchestration?.recoveryJourneyKey || '';
  const oldState = conversation.conversationMemory?.recoveryIntake;
  const state = oldState?.journeyKey === journeyKey ? structuredClone(oldState) : { journeyKey };
  if (classification.intents?.callbackDeclined) {
    state.contactPreference = { callback: 'declined', preferredChannel: /\btext\s+me\s+instead\b/i.test(text) ? 'sms' : (state.contactPreference?.preferredChannel || ''), sourceTurnId: String(turnId || '') };
  } else if (classification.intents?.callback) {
    state.contactPreference = { callback: 'requested', preferredChannel: 'phone', sourceTurnId: String(turnId || '') };
  }
  const questions = updateRequestQuestions(state, text, turnId);
  const oldPreference = state.preferredAppointmentTime ?? lead.preferredAppointmentTime ?? '';
  const oldService = state.serviceNeeded ?? lead.serviceNeeded ?? '';
  const oldAddress = state.address || lead.address || '';
  if (questions.clarificationAnswer) classification.intents.pricing = questions.pricing;
  // A prepared but unsent question is not a question the customer received.
  // Keep the outstanding triage field and ask again after transport recovers.
  if (channel === 'sms') {
    const lastOutbound = recentMessages.filter(message => message.direction === 'outbound').at(-1);
    if (lastOutbound && ['suppressed', 'failed', 'undelivered'].includes(lastOutbound.deliveryStatus || lastOutbound.status)) {
      if (state.clogPending && /(?:overflowing or backing up into other fixtures|backing up into any other)/i.test(lastOutbound.body || '')) state.clogAsked = false;
      if (state.triagePending && /(?:leak|water coming|substance)/i.test(lastOutbound.body || '')) state.triageAsked = false;
      if (state.tradeQualification?.pending && lastOutbound.body === state.tradeQualification.question) state.tradeQualification.asked = false;
    }
  }
  // Semantic evidence uses the existing metered, schema-validated qualification.
  // It describes the request; it never authorizes a service, price or booking.
  const semantic = semanticAssessment?.isInScope === true &&
    Number.isFinite(semanticAssessment.confidence) && semanticAssessment.confidence >= 60 &&
    !semanticAssessment.guardrail?.usedFallback && !(semanticAssessment.riskFlags?.length) &&
    (!semanticAssessment.decision || ['send', 'send_ai_response', 'send_fixed_response'].includes(semanticAssessment.decision))
    ? semanticAssessment : null;
  const contextualPriceQuestion = classification.intents?.pricing && known(lead.serviceNeeded) && !classification.entities?.serviceNeeded;
  const triageFieldAnswer = (state.triagePending || state.clogPending || state.triageAnswer === text) &&
    !classification.entities?.serviceNeeded && /^(?:yes|yeah|yep|no|nope|only|just)\b/i.test(text);
  const service = triageFieldAnswer || questions.ambiguous || questions.duration || questions.completionDate || questions.clarificationAnswer ? '' : classification.entities?.serviceNeeded || (!contextualPriceQuestion && typeof semantic?.serviceNeeded === 'string' ? clean(semantic.serviceNeeded).slice(0, 160) : '');
  if (!state.started && !known(service) && !known(lead.serviceNeeded) && !classification.intents?.scheduling && !capturedAddress && !addressFrom(text)) return null;
  state.started = true;
  if (state.submitted && state.failures >= 2 && known(service)) { state.submitted = false; state.failures = 0; }
  if (known(service) && known(lead.serviceNeeded) && clean(service).toLowerCase() !== clean(lead.serviceNeeded).toLowerCase() &&
      (classification.intents?.correction || classification.intents?.newService)) {
    state.triageResolved = false; state.triagePending = false; state.triageAsked = false;
    delete state.triageAnswer; delete state.leakPattern; delete state.leakSubstance;
    delete state.clogAsked; delete state.clogPending; delete state.clogResolved;
  }
  if (known(service) && (!known(lead.serviceNeeded) || classification.intents?.correction || classification.intents?.newService)) lead.serviceNeeded = service;
  if (!known(lead.serviceNeeded)) return null;
  lead.serviceNeeded = normalizeRequestService(lead.serviceNeeded);
  const address = capturedAddress || addressFrom(text);
  if (address) lead.address = address;

  // Lead is the current request projection, including edits made by interrupt
  // and callback paths. Never resurrect an older intake date on a later turn.
  const savedRange = findDateRange(lead.preferredAppointmentTime || '', timezone, now);
  const savedTime = parseTimePreference(lead.preferredAppointmentTime || '', timezone, now);
  state.date = savedRange ? savedRange.startDate === savedRange.endDate ? savedRange.startDate : `${savedRange.startDate} through ${savedRange.endDate}` : '';
  state.time = savedTime.targetMinutes != null || savedTime.timeOfDay ? formatTimePreferenceLabel(savedTime) : '';
  const schedulingText = address ? clean(text.replace(address, '')) : text;
  const incomingRange = !/^\d{5}(?:-\d{4})?$/.test(schedulingText) ? findDateRange(schedulingText, timezone, now) : null;
  const incomingTime = parseTimePreference(schedulingText, timezone, now);
  const evidence = schedulingEvidence(schedulingText);
  const rejectedDateOnly = evidence.rejectedDate && !incomingRange;
  const rejectedTimeOnly = evidence.rejectedTime && incomingTime.targetMinutes === null && !incomingTime.timeOfDay;
  if (rejectedDateOnly) state.date = '';
  if (rejectedTimeOnly) state.time = '';
  if (incomingRange) state.date = incomingRange.startDate === incomingRange.endDate ? incomingRange.startDate : `${incomingRange.startDate} through ${incomingRange.endDate}`;
  if (incomingTime.targetMinutes !== null || incomingTime.timeOfDay) state.time = formatTimePreferenceLabel(incomingTime);
  if ((!bookingActive || (reviewOnly && !conversation.bookingState?.appointment)) && (state.date || state.time || evidence.rejected.length)) lead.preferredAppointmentTime = [state.date, state.time].filter(Boolean).join(' at ');

  const requestChanged = oldPreference !== (lead.preferredAppointmentTime || '') || oldService !== lead.serviceNeeded || oldAddress !== (lead.address || '');
  if (requestChanged) {
    state.availability = { status: 'not_checked', reason: 'request_changed' };
    state.reviewReady = false; state.submitted = false;
    state.review = { status: conversation.orchestration?.handoffReason ? 'update_required' : 'not_requested' };
    delete state.compoundTurn;
  }

  // Keep new detail even if the canonical service remains unchanged. It is
  // bounded, scoped to this recovery journey, and explicitly customer evidence.
  const triageOnlyAnswer = (state.triagePending || state.clogPending) && !classification.entities?.serviceNeeded &&
    (stopped.test(text) || /^(?:yes|yeah|yep|no|nope)\b|^(?:only|just)\b/i.test(text));
  if (known(service) && !triageOnlyAnswer) {
    state.serviceDetail = normalizeRequestService(service);
    state.serviceSourceTurnId = String(turnId);
  }
  const activeEvidence = text.split(/\b(?:but|however)\b|[;.!?]/i).some(clause =>
    !stopped.test(clause) && patternHasAffirmedSafetyMatch(active, clause));
  const roofCondition = leakContext(lead.serviceNeeded) === 'roof' && /\b(?:only (?:when|during|in) (?:it )?(?:rain|rains|raining|storms?)|when it rains)\b/i.test(text);
  const stoppedEvidence = (stopped.test(text) || roofCondition) && !activeEvidence;
  const shortTriageAnswer = state.triagePending && ['leak_activity', 'constraint_condition'].includes(state.field);
  if (state.field === 'constraint_condition' && /^(?:no|nope)[.! ]*$/i.test(text)) state.constraintQuestion = '';
  const wasTriageResolved = state.triageResolved;
  const wasClogResolved = state.clogResolved;
  if (state.clogPending && /^(?:no|nope|yes|yeah|yep)\b|\b(?:only|just) (?:the |this |my )?(?:sink|toilet|drain|tub|shower)|\b(?:no backup|no other fixtures|other fixtures (?:are )?fine)\b/i.test(text)) {
    state.clogPending = false; state.clogResolved = true;
    state.triageAnswer = text.slice(0, 250);
    if (/^(?:yes|yeah|yep)\b/i.test(text) && lead.urgency !== 'emergency') lead.urgency = 'high';
  }
  if (cloggedFixture(`${lead.serviceNeeded} ${text}`) && !state.clogAsked && !state.clogResolved && !patternHasAffirmedSafetyMatch(leak, `${lead.serviceNeeded} ${text}`)) state.clogPending = true;
  const triageRelevant = state.triagePending || leak.test(`${lead.serviceNeeded} ${text}`);
  if (triageRelevant && (stoppedEvidence || activeEvidence || (shortTriageAnswer && /^(?:yes|yeah|yep|no|nope)[.! ]*$/i.test(text)))) {
    state.triageAnswer = text.slice(0, 250);
    state.leakPattern = !activeEvidence && /\bonly (?:when|during)\b/i.test(text) ? (roofCondition ? 'during_rain' : 'during_use') : stoppedEvidence || /^(?:no|nope)[.! ]*$/i.test(text) ? 'not_active' : 'active';
  }
  if (activeEvidence) {
    state.triageResolved = true;
    state.triagePending = false;
    if (lead.urgency !== 'emergency') lead.urgency = 'high';
  } else if (state.triageResolved && /\b(?:now|again|started|worse)\b/i.test(text) && leak.test(text) && !stoppedEvidence) {
    state.triageResolved = false;
    state.triageAsked = false;
  }
  if (state.triagePending && leakContext(lead.serviceNeeded) === 'unknown_fluid' && /^(?:it(?:'s| is) )?(?:water|refrigerant|freon|coolant|oil|fuel|gas|propane|chemical|unknown|unsure|not sure)[.! ]*$/i.test(text)) {
    state.leakSubstance = text;
    state.triageAnswer = text;
    state.serviceDetail = `${lead.serviceNeeded}; leaking substance: ${text}`;
    if (/water/i.test(text)) state.triageAsked = false;
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
  if (contextHasLeak && leakContext(lead.serviceNeeded) === 'unknown_fluid' && !state.leakSubstance) { state.triagePending = true; state.triageResolved = false; }
  const understoodAnswer = Boolean(state.leakSubstance && state.triageAnswer === text || evidence.rejected.length || (!oldState?.started && known(lead.serviceNeeded)) || known(service) || address || incomingRange ||
    incomingTime.targetMinutes !== null || incomingTime.timeOfDay ||
    state.triageResolved !== wasTriageResolved || state.clogResolved !== wasClogResolved || stopped.test(text) || active.test(text));
  // An unanswered field is not proof the customer was unintelligible. Let the
  // existing semantic pipeline answer off-script questions or interpret novel
  // details before choosing a clarification. Do not consume retry budget here.
  // Availability questions must still pass the qualification checks below,
  // including follow-ups after a missing or unsupported coverage decision.
  if (!understoodAnswer && !classification.intents?.pricing && !classification.intents?.completionQuestion && !questions.clarificationAnswer && !classification.intents?.availabilityInquiry && !coverageQuestion && !semanticAssessment &&
      !(/^\d{5}(?:-\d{4})?$/.test(text) && known(lead.address)) && !state.problem?.asked && !state.tradeQualification?.pending && !(state.tradeQualification && /\b(?:actually|correction|now|instead|no longer)\b/i.test(text))) return null;
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
    const acknowledged = !wasTriageResolved && state.triageResolved && state.leakPattern === 'during_use'
      ? 'Thanks for clarifying that it leaks during use. Please avoid using it for now. '
      : '';
    return fixed(`${isRepeatCorrection(text) && address ? 'Sorry, I have your address now. ' : ''}${pricingPrefix}${addressAcknowledgement}${acknowledged}${reply}`, lead);
  };
  // One request assessment is shared by SMS and voice, before date collection
  // or availability inquiries. Persist blockers as evidence, not booking authority.
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
  if (oldState?.tradeQualification && JSON.stringify(oldState.tradeQualification.answers) !== JSON.stringify(state.tradeQualification.answers)) {
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
    return reviewQualification(state.tradeQualification.reason, state.tradeQualification.hazardType ? getEmergencyReply(state.tradeQualification.hazardType) : tradeReviewReply(state.tradeQualification.reason));
  }
  if (rejectedDateOnly || rejectedTimeOnly) {
    if (!conversation.bookingState?.appointment) {
      lead.preferredAppointmentTime = [state.date, state.time].filter(Boolean).join(' at ');
      conversation.bookingState = { ...conversation.bookingState,
        offeredSlots: [], selectedSlot: null, expiresAt: null,
        searchStartDate: null, searchEndDate: null, lastCustomerPreference: '',
        status: business.features?.aiBookingEnabled ? 'collecting_preference' : 'not_started',
        lastError: 'customer_rejected_preference' };
      conversation.markModified?.('bookingState');
    }
    state.availability = { status: 'not_checked', reason: 'customer_rejected_preference' };
    state.reviewReady = false; state.submitted = false;
    return ask('scheduling_correction', `What ${rejectedDateOnly ? 'day' : 'time'} would work instead?${conversation.bookingState?.appointment ? ' Your existing appointment has not been changed.' : ' No appointment is confirmed.'}`);
  }
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
        conversation.bookingState = { status: 'not_started' };
        conversation.markModified?.('bookingState');
      }
      if (state.coverage.supported === false && !conversation.bookingState?.appointment) {
        state.reviewReady = false; state.submitted = false;
        return ask('coverage', 'That address is outside the configured service area, so I cannot offer appointment times there. If the address is incorrect, please send the correction.');
      }
      state.coverageReviewPending = true;
      return reviewQualification(state.coverage.reason, coverageReviewReply({
        lead, conversation, state, coverageQuestion,
        availabilityQuestion: classification.intents?.availabilityInquiry,
        preferenceCaptured: Boolean(incomingRange || incomingTime.targetMinutes !== null || incomingTime.timeOfDay),
      }));
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
      return fixed(`I rechecked the service area: ZIP ${postalCode} is covered. ${conversation.bookingState?.appointment
        ? 'This check does not change your existing appointment.'
        : 'Availability and business approval are still required; no appointment is confirmed.'}`, lead);
    }
    return ask('postal_code', known(lead.address) ? 'What is the ZIP code for that address so I can check coverage?' : 'What is the service address, including ZIP code, so I can check coverage?');
  }
  // Existing appointments remain manageable. New or unresolved details are
  // reviewed without changing their committed service, location, or time.
  if (state.problem.status === 'needs_staff_review') {
    return reviewQualification(state.problem.reason, "The problem details need team review. Your request is not a confirmed appointment, and I cannot guarantee a response time.");
  }
  if (state.problem.status === 'needs_clarification' && !conversation.bookingState?.appointment) {
    state.problem.asked = true;
    return ask('problem_detail', state.problem.question);
  }
  if (state.tradeQualification.status === 'needs_clarification' && !conversation.bookingState?.appointment && incomingRange?.startDate === formatDateKey(now, timezone)) {
    await persist();
    return requestStaffSchedulingReview({ business, lead, conversation, customerMessage: text, channel, now });
  }
  if (state.tradeQualification.status === 'needs_clarification' && !conversation.bookingState?.appointment) {
    state.tradeQualification.asked = true;
    return ask('trade_detail', state.tradeQualification.question);
  }
  if (questions.ambiguous || state.unresolvedQuestions.some(q => q.kind === 'completion_meaning')) {
    return ask('question_meaning', completionClarification);
  }
  if (classification.intents?.availabilityInquiry) { await persist(); return null; }
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
    return fixed(pricingPrefix + detail + pending, lead, { shouldAlertOwner: false, alertPriority: activeEvidence ? 'high' : 'medium', alertTitle: activeEvidence ? 'Customer reports an ongoing leak' : '' });
  }
  if (state.triagePending && !state.triageAsked) {
    state.triageAsked = true; await persist();
    return ask(leakContext(state.serviceDetail || lead.serviceNeeded) === 'unknown_fluid' ? 'leak_substance' : 'leak_activity', recoveryLeakQuestion(state.serviceDetail || lead.serviceNeeded));
  }
  if (state.clogPending && !state.clogAsked) {
    state.clogAsked = true;
    return ask('clog_scope', clogQuestionFor(`${lead.serviceNeeded} ${state.serviceDetail || ''} ${text}`));
  }
  if (state.submitted) {
    await persist();
    const reply = classification.intents?.pricing
      ? `${approvedEstimate || "I don't have an approved estimate for that request."} The service request still needs team review.`
      : 'Your additional details are saved with this conversation. The service request still needs team review.';
    return fixed(timingPrefix + reply, lead);
  }
  // Pricing is a question within intake, not a reason to discard its facts.
  if (classification.intents?.pricing && !incomingRange && incomingTime.targetMinutes === null && !incomingTime.timeOfDay) {
    await persist();
    const priceResponse = pricingReply({ business, lead, triageResolved: state.triageResolved === true || state.clogResolved === true });
    const reply = approvedEstimate ? `${approvedEstimate} ${priceResponse.replace(`For ${clean(lead.serviceNeeded)}, I don't have a confirmed price yet.`, '').trim()}` : priceResponse;
    return fixed(timingPrefix + reply, lead, { messageCategory: 'pricing_request' });
  }
  if (business.features?.aiBookingEnabled === true) {
    if (state.triagePending) return ask(leakContext(state.serviceDetail || lead.serviceNeeded) === 'unknown_fluid' ? 'leak_substance' : 'leak_activity', recoveryLeakQuestion(state.serviceDetail || lead.serviceNeeded));
    if (state.clogPending) return ask('clog_scope', clogQuestionFor(`${lead.serviceNeeded} ${state.serviceDetail || ''} ${text}`));
    await persist(); return null;
  }
  await persist();
  if (!known(lead.address)) return ask('address', 'What is the service address?');
  if (!extractCustomerPostalCode(lead.address)) return ask('postal_code', 'What is the ZIP code for that address?');
  const preference = clean(lead.preferredAppointmentTime);
  const range = findDateRange(preference, timezone, now);
  const time = parseTimePreference(state.time || preference, timezone, now);
  if (!range) return ask('date', 'What day would you prefer? The business will need to approve the appointment.');
  const sameDayRequest = range.startDate === formatDateKey(now, timezone) && range.endDate === range.startDate;
  if (sameDayRequest && time.targetMinutes === null && !time.timeOfDay) {
    return requestStaffSchedulingReview({ business, lead, conversation, customerMessage: text, channel, now });
  }
  if (time.targetMinutes === null && !time.timeOfDay) return ask('time', 'What time works best that day?');
  if (state.triagePending) return ask(leakContext(state.serviceDetail || lead.serviceNeeded) === 'unknown_fluid' ? 'leak_substance' : 'leak_activity', recoveryLeakQuestion(state.serviceDetail || lead.serviceNeeded));
  if (state.clogPending) return ask('clog_scope', clogQuestionFor(`${lead.serviceNeeded} ${state.serviceDetail || ''} ${text}`));

  let availabilityNote = "I couldn't verify that time's availability; it needs team review.";
  let ready = true;
  state.availability = { status: 'not_checked', reason: 'service_match_unverified', checkedAt: now.toISOString(), timezone };
  try {
    const postalCode = extractCustomerPostalCode(lead.address);
    const area = state.coverage;
    if (area.supported !== true) {
      ready = false; availabilityNote = 'That address is outside the configured service area. Is there another service address?';
    } else {
      const services = await searchServices({ businessId: business._id, query: lead.serviceNeeded }); checkActive();
      if (services.length === 1 && Number.isFinite(services[0].score) && services[0].score > 0) {
        const available = await getAvailability({ business, leadId: lead._id, conversationId: conversation._id, serviceQuery: lead.serviceNeeded, serviceOfferingId: services[0].id, startDate: range.startDate, endDate: range.endDate, postalCode }); checkActive();
        if (available.supportedServiceArea === false) { state.availability = { status: 'not_checked', reason: 'coverage_unverified' }; ready = false; availabilityNote = 'That address needs a service-area review before scheduling.'; }
        else if (Array.isArray(available.slots)) {
          const future = filterAutomatedSlots(available.slots, now);
          const matches = filterSlotsByTimePreference(future, time, timezone);
          if (matches.length) {
            availabilityNote = `${slotLabel(matches[0], timezone)} is currently available, subject to business approval.`;
            state.availability = { status: 'available', checkedAt: now.toISOString(), serviceOfferingId: String(services[0].id), startAt: matches[0].startAt, endAt: matches[0].endAt, timezone, provider: available.provider || '', evidenceKey: requestEvidenceKey({ lead, conversation, state }) };
          }
          else {
            ready = false;
            state.availability.status = 'no_matching_slot';
            const alternatives = future.slice(0, 2).map(slot => slotLabel(slot, timezone));
            availabilityNote = alternatives.length ? `That time isn't available. Current openings: ${alternatives.join(' or ')}. Which works for you?` : 'There are no eligible openings for that requested time under the business scheduling rules. What later day could work?' ;
          }
        }
      }
    }
  } catch (error) {
    if (['VOICE_STALE_TURN', 'DISTRIBUTED_LEASE_LOST'].includes(error?.code)) throw error;
    state.availability = { status: 'check_failed', reason: 'availability_lookup_failed', checkedAt: now.toISOString(), timezone };
    logOperationalError('intake.availability_lookup_failed', error, { businessId: business._id });
    // A provider failure is unknown availability, never an empty calendar or a confirmed slot.
  }
  if (!ready && sameDayRequest && state.availability.status === 'no_matching_slot') {
    return requestStaffSchedulingReview({ business, lead, conversation, customerMessage: text, channel, now });
  }
  if (!ready) return ask('available_preference', availabilityNote);
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
  return result;
};
