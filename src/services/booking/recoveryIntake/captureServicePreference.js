import { AlertService, addressFrom, classifyLeakActivityAnswer, clean, findDateRange, formatTimePreferenceLabel, isContextualSymptomAnswer, isUrgentPlumbingRequest, known, normalizeRequestService, parseTimePreference, schedulingEvidence } from './context.js';

export async function captureServicePreference(context) {
  const { semanticAssessment, classification, lead, text, state, turnId, questions, capturedAddress, checkActive, business, conversation, journeyKey, channel, timezone, now, bookingActive, reviewOnly, oldPreference, oldService, oldAddress } = context;
const semantic = semanticAssessment?.isInScope === true &&
    Number.isFinite(semanticAssessment.confidence) && semanticAssessment.confidence >= 60 &&
    !semanticAssessment.guardrail?.usedFallback && !(semanticAssessment.riskFlags?.length) &&
    (!semanticAssessment.decision || ['send', 'send_ai_response', 'send_fixed_response'].includes(semanticAssessment.decision))
    ? semanticAssessment : null;
  const contextualPriceQuestion = classification.intents?.pricing && known(lead.serviceNeeded) && !classification.entities?.serviceNeeded;
  const leakActivityAnswer = classifyLeakActivityAnswer({ text, state, service: lead.serviceNeeded });
  const useDependentAnswer = leakActivityAnswer === 'during_use';
  const triageFieldAnswer = Boolean(leakActivityAnswer) || (state.triagePending || state.clogPending || state.triageAnswer === text) &&
    !classification.entities?.serviceNeeded && /^(?:yes|yeah|yep|no|nope|only|just)\b/i.test(text);
  const symptomAnswer = isContextualSymptomAnswer(text, lead.serviceNeeded);
  if (symptomAnswer) {
    state.symptomUpdates = [...(state.symptomUpdates || []).filter(item => item.text !== text), { text: text.slice(0, 500), turnId: String(turnId) }].slice(-10);
  }
  const service = symptomAnswer || triageFieldAnswer || questions.ambiguous || questions.duration || questions.completionDate || questions.clarificationAnswer ? '' : classification.entities?.serviceNeeded || (!contextualPriceQuestion && typeof semantic?.serviceNeeded === 'string' ? clean(semantic.serviceNeeded).slice(0, 160) : '');
  if (!state.started && !known(service) && !known(lead.serviceNeeded) && !classification.intents?.scheduling && !capturedAddress && !addressFrom(text)) return { completed: true, value: null };
  state.started = true;
  const urgentPlumbing = isUrgentPlumbingRequest(text);
  if (urgentPlumbing) {
    if (lead.urgency !== 'emergency') lead.urgency = 'high';
    checkActive();
    const saved = await AlertService.create({ businessId: business._id, leadId: lead._id, conversationId: conversation._id,
      type: 'system', title: 'Urgent plumbing repair requested', priority: 'high', actionRequired: true,
      message: text, recommendedAction: 'Review the urgent repair request and contact the customer. No arrival time or dispatch is promised.',
      dedupeKey: `urgent-plumbing:${conversation._id}:${journeyKey}`, metadata: { channel, urgentRepair: true } });
    if (!saved?.alert?._id) throw Object.assign(new Error('Urgent repair review could not be saved'), { code: 'STAFF_ACTION_NOT_SAVED' });
    state.urgentRepair = { alertId: String(saved.alert._id), request: text };
    state.triageResolved = true; state.triagePending = false;
    state.clogResolved = true; state.clogPending = false;
  }
  if (state.submitted && state.failures >= 2 && known(service)) { state.submitted = false; state.failures = 0; }
  if (known(service) && known(lead.serviceNeeded) && clean(service).toLowerCase() !== clean(lead.serviceNeeded).toLowerCase() &&
      (classification.intents?.correction || classification.intents?.newService)) {
    state.triageResolved = false; state.triagePending = false; state.triageAsked = false;
    delete state.triageAnswer; delete state.leakPattern; delete state.leakSubstance;
    delete state.clogAsked; delete state.clogPending; delete state.clogResolved;
  }
  if (known(service) && (!known(lead.serviceNeeded) || classification.intents?.correction || classification.intents?.newService)) lead.serviceNeeded = service;
  if (!known(lead.serviceNeeded)) return { completed: true, value: null };
  lead.serviceNeeded = normalizeRequestService(lead.serviceNeeded);
  const address = capturedAddress || addressFrom(text);
  if (address) lead.address = address;

  // Lead is the current request projection, including edits made by interrupt
  // and callback paths. Never resurrect an older intake date on a later turn.
  const savedRange = findDateRange(lead.preferredAppointmentTime || '', timezone, now);
  const savedTime = parseTimePreference(lead.preferredAppointmentTime || '', timezone, now);
  state.date = savedRange ? savedRange.startDate === savedRange.endDate ? savedRange.startDate : `${savedRange.startDate} through ${savedRange.endDate}` : '';
  state.time = savedTime.targetMinutes != null || savedTime.timeOfDay ? formatTimePreferenceLabel(savedTime) : '';
  // An activity answer such as 'right now' describes the leak, not a date.
  const schedulingText = triageFieldAnswer ? '' : address ? clean(text.replace(address, '')) : text;
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
  return { completed: false, context: { address, leakActivityAnswer, service, useDependentAnswer, urgentPlumbing, incomingRange, incomingTime, evidence, rejectedDateOnly, rejectedTimeOnly } };
}
