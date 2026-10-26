import { OUTCOME, verifyOutcome } from './outcomeContract.js';

/**
 * Conversation Policy v3: a read-only shared decision plane for SMS and voice.
 * Does not grant booking, dispatch, human ownership or delivery authority.
 * Existing deterministic safety/consent/eligibility guards MUST run first.
 */
export const DIALOG_POLICY_VERSION = 3;
const norm = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const known = v => Boolean(norm(v) && !/^(unknown|n\/a|not provided|none)$/i.test(norm(v)));
const normalize = v => norm(v).toLowerCase().replace(/[’]/g, "'");
const PROGRESS_PATTERNS = [
  /\bwhat(?:'s| is| are)? (?:the )?(?:next steps?|process|status|procedure)\b/i,
  /\b(?:what|how) (?:happens|comes|should i proceed|do we proceed) next\b/i,
  /\bwhat (?:do|should|can) (?:i|we) (?:do|expect) (?:next|now|from here)\b/i,
  /\b(?:where do we go|how do we move forward|how do i move forward) from here\b/i,
  /\b(?:when|how soon) (?:will|can|should) (?:someone|anyone|the team|you) (?:get back to me|respond|follow up|call|text)\b/i,
  /\bwhen (?:will|should) (?:i|we) (?:hear back|hear from|expect a response)\b/i,
  /\b(?:any|have you got an?|is there an?) (?:update|news)\b/i,
  /\b(?:where are we with|what(?:'s| is) the status of) (?:my|the|this) (?:request|appointment|booking|job)\b/i,
  /\b(?:did you get|did they receive|was (?:my|the) request received)\b/i,
];
const ARRIVAL_PATTERNS = [
  /\b(?:is|are) (?:you|they|someone|anyone|the (?:tech|technician|crew)) (?:coming|on the way|arriving|dispatched)\b/i,
  /\b(?:have|has) (?:you|they|someone|anyone|the (?:tech|technician|crew)) (?:been )?dispatched\b/i,
  /\bwhere(?:'s| is) (?:my|the) (?:technician|tech|crew)\b/i,
];
const CONFIRMATION_PATTERNS = [
  /\b(?:is|was) (?:my|the|this|it) (?:appointment|booking|visit) (?:booked|confirmed|approved)\b/i,
  /\b(?:did|have) (?:you|they) (?:confirm(?:ed)?|approv(?:e|ed)|book(?:ed)?|schedul(?:e|ed)) (?:my|the|it|this)\b/i,
];
const OPT_OUT = /^(?:stop|stopall|unsubscribe|cancel all texts|end|quit|help|start|unstop)(?:\W.*)?$/i;
const MUTATION = /\b(?:cancel|reschedule|change|move (?:my|the|it|appointment|booking|visit)|correct(?:ion)?|instead|actually|another (?:service|job)|also (?:need|have)|wrong address|different address|not that time)\b/i;
const TIME = /\b(?:today|tonight|tomorrow|yesterday|next (?:week|month|mon|tues|wednes|thurs|fri|satur|sun)|this (?:evening|afternoon|morning|weekend)|\d{1,2}:\d\d|\d{1,2}\s*(?:am|pm)|\d{4}-\d\d-\d\d)\b/i;
const HAZARD = /\b(?:emergency|danger|gas|fire|smoke|electric shock|sparks|flooding|gushing|overflown|injur(?:ed|y)|hazard|911|bleeding)\b/i;
const NEW_FACT = /\b(?:leak(?:ing|s)?|broken|clog(?:ged)?|repair|install|replace|pipe|faucet|toilet|roof|lock|water heater|furnace|air conditioner|plumbing)\b|\b\d{5}(?:-\d{4})?\b|\b\d+\s+(?:st|street|rd|road|ave|avenue|blvd|drive|dr|lane|ln)\b/i;
const HUMAN = /\b(?:talk to|speak with|speak to|connect me to|human|real person|representative|manager|call me back|have someone call)\b/i;
const MAX_CHARS = 1200;
export const protectedTurnText = text => {
  const s = normalize(text);
  return !s || OPT_OUT.test(s) || MUTATION.test(s) || HAZARD.test(s) || HUMAN.test(s) || TIME.test(s) || NEW_FACT.test(s);
};
export const dialogEnabled = env => ['active','observe'].includes(String(env?.MEEKCALL_DIALOG_POLICY_MODE || 'observe').toLowerCase());
export const dialogMode = env => ['active','observe'].includes(String(env?.MEEKCALL_DIALOG_POLICY_MODE || '').toLowerCase()) ? String(env.MEEKCALL_DIALOG_POLICY_MODE).toLowerCase() : 'observe';

// Low-cost deterministic recognition; on unknown language the optional semantic adapter
// can suggest an intent. This classifier intentionally makes NO mutation decisions.
export function detectDialogAct(text, semantic = null) {
  const utterance = normalize(text);
  if (!utterance || utterance.length > MAX_CHARS) return null;
  if (OPT_OUT.test(utterance) || MUTATION.test(utterance) || HAZARD.test(utterance) || HUMAN.test(utterance)) return null;
  if (TIME.test(utterance) || NEW_FACT.test(utterance)) return null; // defer compound turns to full intake
  if (ARRIVAL_PATTERNS.some(p => p.test(utterance))) return 'arrival_question';
  if (CONFIRMATION_PATTERNS.some(p => p.test(utterance))) return 'confirmation_question';
  if (PROGRESS_PATTERNS.some(p => p.test(utterance))) return 'progress_question';
  // Semantic proposals MUST be constrained by the deterministic vetoes above.
  if (semantic && ['progress_question','arrival_question','confirmation_question'].includes(semantic.intent) &&
      semantic.confidence >= 0.88 && semantic.readOnly === true && semantic.hasNewFacts === false &&
      semantic.hasSafetyConcern === false && semantic.hasControlRequest === false) return semantic.intent;
  return null;
}

export function evidenceSnapshot({ lead = {}, conversation = {}, channel = 'sms' } = {}) {
  const memory = conversation.conversationMemory || {};
  const intake = memory.recoveryIntake || {};
  const booking = conversation.bookingState || {};
  const preference = norm(lead.preferredAppointmentTime || intake.preferredAppointmentTime || memory.preferredAppointmentTime);
  const coverage = intake.coverage?.supported === true ? 'verified' : intake.coverage?.supported === false ? 'outside' : 'unknown';
  const reviewQueued = verifyOutcome(OUTCOME.STAFF_TASK_QUEUED, {
    alertId: intake.review?.alertId, alertPersisted: intake.review?.status === 'queued',
  }).verified;
  const booked = Boolean(booking.appointment) || booking.status === 'booked';
  return Object.freeze({
    channel, requestRecorded: Boolean(known(lead.serviceNeeded || intake.serviceNeeded || memory.serviceNeeded) ||
      known(lead.address || intake.address || memory.address) || known(preference)),
    hasService: known(lead.serviceNeeded || intake.serviceNeeded || memory.serviceNeeded),
    hasAddress: known(lead.address || intake.address || memory.address), hasPreference: known(preference),
    reviewQueued, reviewStatus: reviewQueued ? 'queued' : 'unverified',
    qualifyingPending: Boolean(intake.triagePending || intake.clogPending ||
      intake.problem?.status === 'needs_clarification' || intake.tradeQualification?.status === 'needs_clarification'),
    coverage, booked, bookingStatus: norm(booking.status || 'not_started'),
    humanOwns: conversation.humanTakeover === true || conversation.aiEnabled === false || booking.status === 'human_takeover',
    closed: ['closed','archived'].includes(conversation.status),
    pendingOffer: ['offering_slots','awaiting_confirmation','booking','pending_business_confirmation'].includes(booking.status),
    // A transport ACK is NOT staff acknowledgment. Explicit staff actions own that state.
    staffAccepted: false,
  });
}

const questionBoundary = (text, channel) => channel === 'voice' ? text : text;
function processAnswer(intent, snapshot, { channel, recentMessages = [] } = {}) {
  const prior = [...recentMessages].reverse().find(m => m?.direction === 'outbound' || m?.role === 'assistant');
  const lastReply = norm(prior?.body || prior?.text || prior?.content || '');
  const recentDisclosure = /\b(?:team review|business approval|not confirmed|cannot confirm|can't confirm)\b/i.test(lastReply);
  const next = [];
  if (!snapshot.hasService) next.push('Tell me what service you need so I can record the request.');
  else if (!snapshot.hasAddress) next.push('What is the service address?');
  else if (!snapshot.hasPreference) next.push('What day would work best for you?');
  else if (intent === 'progress_question' && !recentDisclosure) next.push(channel === 'voice'
    ? 'If that requested day does not work, you can tell me a backup day.'
    : 'You can reply with a backup day if your first choice is unavailable.');
  const source = snapshot.reviewQueued
    ? 'Your request is recorded for team review.'
    : snapshot.requestRecorded
      ? "I have your request details, but I can't verify that a staff-review task is queued yet."
      : 'I can collect your request details for the business.';
  let response;
  if (intent === 'arrival_question') {
    response = `I can't verify that a technician has been dispatched or is on the way. No appointment or dispatch is confirmed here. ${source}`;
  } else if (intent === 'confirmation_question') {
    response = `I can't confirm an appointment or dispatch for this request. ${source} The team must verify availability and approve a visit.`;
  } else if (recentDisclosure) {
    response = `The next action is for the business to review your request and verify a time. ${source} No visit has been confirmed. I don't have a guaranteed response timeframe.`;
  } else {
    response = `${source} Next, the business must check availability and approve a visit before anything is confirmed. There is no guaranteed callback time or dispatch.`;
  }
  return questionBoundary(`${response}${next.length ? ' ' + next[0] : ''}`, channel);
}

export function planReadOnlyTurn({ customerMessage, semantic = null, lead = {}, conversation = {}, channel = 'sms', recentMessages = [] } = {}) {
  const intent = detectDialogAct(customerMessage, semantic);
  const snapshot = evidenceSnapshot({ lead, conversation, channel });
  if (!intent || snapshot.humanOwns || snapshot.closed || snapshot.booked || snapshot.pendingOffer || snapshot.qualifyingPending) {
    return { handled: false, intent: intent || 'none', reason: snapshot.booked ? 'authoritative_appointment_required' :
      snapshot.pendingOffer ? 'booking_engine_owns_offer' : snapshot.qualifyingPending ? 'qualification_engine_owns_question' : snapshot.humanOwns ? 'human_owner' : snapshot.closed ? 'closed' : 'normal_pipeline', snapshot };
  }
  return { handled: true, intent, reason: 'read_only_policy', reply: processAnswer(intent, snapshot, { channel, recentMessages }), snapshot,
    sideEffects: [], requiresApproval: false, appointmentConfirmed: false };
}

export function asSmsDialogResult(plan, lead = {}) {
  if (!plan?.handled) return null;
  return {
    decision: 'send_fixed_response', actionType: 'answer_question', messageCategory: 'appointment_status',
    reply: plan.reply, serviceNeeded: known(lead.serviceNeeded) ? norm(lead.serviceNeeded) : '',
    address: known(lead.address) ? norm(lead.address) : '',
    preferredAppointmentTime: known(lead.preferredAppointmentTime) ? norm(lead.preferredAppointmentTime) : '',
    urgency: lead.urgency || 'medium',
    shouldAlertOwner: false, intakeReady: false, riskFlags: [], confidence: 100,
    guardrail: { skipAI: true, usedFallback: false, reason: 'dialog_policy_v3_read_only', violations: [] },
    dialogPolicy: { version: DIALOG_POLICY_VERSION, intent: plan.intent, reason: plan.reason },
  };
}
