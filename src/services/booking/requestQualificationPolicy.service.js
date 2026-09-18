import crypto from 'node:crypto';
import { serviceDomains } from '../serviceEligibility/policy.js';

export const REQUEST_POLICY_VERSION = 1;
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const vague = /\b(?:broken|broke|not working|doesn['’]?t work|does not work|won['’]?t work|will not work|problem|issue|something wrong|damage|damaged|acting up|messed up)\b/i;
const unsure = /\b(?:not sure|unsure|don['’]?t know|do not know|can['’]?t tell|cannot tell|no idea)\b/i;
const explicitWork = /\b(?:install|installation|replace|replacement|inspect|inspection|maintenance|tune[ -]?up|cleaning|reseal|rekey|mow|mowing|trim|trimming)\b/i;
const symptoms = /\b(?:leak\w*|overflow\w*|clogg?\w*|blocked|back(?:ing)? up|stopped up|won['’]?t flush|not flushing|doesn['’]?t flush|won['’]?t start|not starting|won['’]?t turn on|not turning on|not cooling|no cooling|not heating|no heat|no power|without power|lost power|tripp?\w*|spark\w*|smok\w*|burn\w*|hot to (?:the )?touch|humm?\w*|rattl\w*|nois\w*|crack\w*|loose|handle|flapper|running constantly|keeps running|stuck|off (?:the )?track|won['’]?t (?:open|close)|locked out|lockout|missing shingles?|fallen|falling|standing water|water damage|mold|uneven|brown patches|dead grass|key (?:broke|broken)|water stain\w*)\b/i;
const questions = {
  plumbing: 'What is happening—leaking or overflowing, a blockage, not operating, or something else?',
  hvac: 'Is it not heating or cooling, not turning on, leaking, making an unusual noise, or something else?',
  electrical: 'Is there no power, physical damage, heat, a burning smell, or sparking?',
  roofing: 'What roof damage have you noticed, and is water coming inside now?',
  restoration: 'What area is damaged, what caused it if known, and is the damage still spreading?',
  garage_door: 'Is the door stuck open or closed, visibly damaged, or is the opener not responding?',
  locksmith: 'Are you locked out, is the lock or key damaged, or do you need a lock changed?',
  landscaping: 'What part of the yard or equipment needs attention, and what is happening?',
};

// This is intake clarity, not a diagnosis or a service acceptance decision.
// Unrecognized answers remain uncertain; the model cannot grant permission.
export function assessProblemClarity({ service, text, previous, policy = {}, category = '', turnId = '', interrupt = false, factualTurn = false, correction = false }) {
  const request = clean(service), answer = clean(text);
  const key = request.toLowerCase();
  const prior = previous?.serviceKey === key && !correction ? previous : null;
  const domain = serviceDomains(request)[0] || category;
  const question = clean(policy.clarificationQuestion).slice(0, 240) || questions[domain] || 'What is happening with it, or what work would you like done?';
  const base = { policyVersion: REQUEST_POLICY_VERSION, serviceKey: key, question, attempts: prior?.attempts || 0 };
  const detailTerms = (Array.isArray(policy.detailKeywords) ? policy.detailKeywords : []).slice(0, 30).map(clean).filter(Boolean);
  const hasDetail = value => clean(value).split(/\b(?:but|however|and)\b|[;.!?]/i).some(clause => {
    // Absence of a danger symptom is useful triage, but does not explain a
    // vague malfunction. Loss-of-function phrases ('no power') remain evidence.
    if (/\b(?:no|not|isn['’]?t|without|never|no longer)\s+(?:\w+\s+){0,2}(?:leak\w*|overflow\w*|smok\w*|spark\w*|burn\w*)\b/i.test(clause)) return false;
    if (/\b(?:don['’]?t|do not|not)\s+(?:need|want|request)\b/i.test(clause)) return false;
    return symptoms.test(clause) || explicitWork.test(clause) || detailTerms.some(term =>
      new RegExp(`(?:^|\\W)${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\W)`, 'i').test(clause));
  });
  const assertedDetail = hasDetail(answer) && !/\b(?:what if|suppose|could it|is it|does it mean)\b/i.test(answer);
  const eligibleAnswer = (!interrupt && !factualTurn) || assertedDetail;
  if ((prior && eligibleAnswer && unsure.test(answer)) || unsure.test(request)) {
    return { ...base, status: 'needs_staff_review', reason: 'customer_unsure', evidence: answer.slice(0, 500) };
  }
  if (hasDetail(request) || (prior && eligibleAnswer && assertedDetail)) {
    return { ...base, status: 'clear', reason: 'problem_detail_captured', evidence: (prior && assertedDetail ? (prior.evidence && !prior.evidence.includes(answer) ? `${prior.evidence}; ${answer}` : answer) : request).slice(0, 500) };
  }
  if (prior?.status === 'clear' || prior?.status === 'needs_staff_review') return prior;
  if (!vague.test(request) && !prior && policy.requireClarification !== true) {
    return { ...base, status: 'clear', reason: 'specific_service_request', evidence: request.slice(0, 500) };
  }
  // Date/address answers and side questions never consume the clarification budget.
  const repeatedTurn = turnId && prior?.lastTurnId === String(turnId);
  const attempts = base.attempts + (prior?.asked && eligibleAnswer && !repeatedTurn ? 1 : 0);
  return { ...base, attempts, lastTurnId: String(turnId), asked: prior?.asked === true,
    status: attempts >= 2 ? 'needs_staff_review' : 'needs_clarification',
    reason: attempts >= 2 ? 'problem_still_unclear' : 'problem_detail_required', evidence: prior?.evidence || request.slice(0, 500) };
}

export const requestEvidenceKey = ({ lead = {}, conversation = {}, state = {} }) => crypto.createHash('sha256').update(JSON.stringify([
  conversation.orchestration?.recoveryJourneyKey || '', lead.serviceNeeded || '', lead.address || '',
  lead.preferredAppointmentTime || '', conversation.serviceEligibility?.serviceId || '', state.problem?.evidence || '',
])).digest('hex');

export function buildRequestReadiness({ lead, conversation, state, now = new Date() }) {
  const evidenceKey = requestEvidenceKey({ lead, conversation, state });
  const blockers = [];
  if (conversation.serviceEligibility?.decision !== 'supported') blockers.push('service_not_verified');
  if (state.problem?.status !== 'clear') blockers.push(state.problem?.reason || 'problem_not_evaluated');
  if (!lead.address || /^(unknown|not provided|n\/a)$/i.test(lead.address)) blockers.push('address_required');
  if (state.coverage?.supported !== true || state.coverage.address !== lead.address) blockers.push(state.coverage?.reason || 'coverage_not_evaluated');
  if (state.triagePending || state.clogPending) blockers.push('triage_unresolved');
  const readyForOptions = blockers.length === 0;
  const age = new Date(now).getTime() - new Date(state.availability?.checkedAt || 0).getTime();
  const availabilityVerified = readyForOptions && state.availability?.status === 'available' && state.availability.evidenceKey === evidenceKey && age >= 0 && age <= 5 * 60_000;
  return { policyVersion: REQUEST_POLICY_VERSION, evidenceKey, evaluatedAt: new Date(now).toISOString(),
    blockers, readyForStaffReview: Boolean(lead.serviceNeeded && !/^unknown$/i.test(lead.serviceNeeded)),
    readyForOptions, readyForApproval: readyForOptions && availabilityVerified,
    availabilityVerified, appointmentStatus: conversation.bookingState?.status || 'not_started' };
}
