import { active, cloggedFixture, known, leak, leakContext, normalizeRequestService, patternHasAffirmedSafetyMatch, stopped } from './context.js';

export async function assessTriageEvidence(context) {
  const { state, classification, text, service, turnId, leakActivityAnswer, lead, useDependentAnswer, evidence, oldState, address, incomingRange, incomingTime } = context;
const triageOnlyAnswer = (state.triagePending || state.clogPending) && !classification.entities?.serviceNeeded &&
    (stopped.test(text) || /^(?:yes|yeah|yep|no|nope)\b|^(?:only|just)\b/i.test(text));
  if (known(service) && !triageOnlyAnswer) {
    state.serviceDetail = normalizeRequestService(service);
    state.serviceSourceTurnId = String(turnId);
  }
  const activeEvidence = leakActivityAnswer === 'active' || text.split(/\b(?:but|however)\b|[;.!?]/i).some(clause =>
    !stopped.test(clause) && patternHasAffirmedSafetyMatch(active, clause));
  const roofCondition = leakActivityAnswer === 'during_rain' || leakContext(lead.serviceNeeded) === 'roof' && /\b(?:only (?:when|during|in) (?:it )?(?:rain|rains|raining|storms?)|when it rains)\b/i.test(text);
  const stoppedEvidence = (stopped.test(text) || roofCondition || useDependentAnswer || leakActivityAnswer === 'not_active') && !activeEvidence;
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
    state.leakPattern = !activeEvidence && (useDependentAnswer || roofCondition || /\bonly (?:when|during)\b/i.test(text)) ? (roofCondition ? 'during_rain' : 'during_use') : stoppedEvidence || /^(?:no|nope)[.! ]*$/i.test(text) ? 'not_active' : 'active';
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
  return { completed: false, context: { activeEvidence, wasTriageResolved, understoodAnswer } };
}
