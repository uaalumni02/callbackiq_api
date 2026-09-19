import { REPLY_ACTION_TYPES } from '../../helpers/ai/aiGuardrails.js';
import { captureTurnFacts } from '../booking/turnFactCapture.service.js';
import { classifySmsIntent } from './smsIntentClassifier.service.js';
import { requestWasWithdrawn } from '../conversationControlPolicy.js';

// Application decisions, independent of the model's proposed action vocabulary.
// None of these values authorizes an appointment or a provider side effect.
export const SMS_WORKFLOW_ACTIONS = Object.freeze([
  'answer_question', 'update_request', 'ask_missing_detail', 'safety_response',
  'service_boundary', 'request_business_approval', 'staff_review', 'suppress_reply',
]);
const clean = value => typeof value === 'string' ? value.trim() : '';
const known = value => clean(value) && !/^(unknown|not provided|n\/a)$/i.test(clean(value));
const factualFields = ['serviceNeeded', 'address', 'preferredAppointmentTime'];
const interruptCategories = new Set(['human_requested', 'appointment_status', 'pricing_request']);

// Early question/callback branches must retain facts supplied in the same turn.
// Do not reinterpret opt-outs, withdrawals, or service-eligibility decisions.
// These are customer-request facts only, never changes to an Appointment.
export function preserveSmsInterruptFacts({ result, customerMessage, business, lead, conversation }) {
  if (!result || result.compoundTurn || result.additionalRequest || result.decision === 'no_reply' || result.serviceEligibility ||
      requestWasWithdrawn(conversation) ||
      (!interruptCategories.has(result.messageCategory) && result.guardrail?.reason !== 'ai_pipeline_error')) return result;
  const classification = classifySmsIntent({ customerMessage, business, lead, conversation });
  const facts = captureTurnFacts({ customerMessage, classification, business, lead });
  const next = { ...result };
  for (const field of factualFields) {
    if (known(facts[field])) next[field] = facts[field];
    else if (!known(next[field]) && known(lead?.[field])) next[field] = lead[field];
  }
  return next;
}

// Changing request facts invalidates an uncommitted offer, not an appointment.
// Preserve the rest of intake memory so an interruption cannot restart intake.
export function buildSmsRequestRevisionPatch({ result = {}, lead = {}, conversation = {} } = {}) {
  const patch = {};
  const changed = factualFields.filter(field => known(result[field]) && clean(result[field]) !== clean(lead[field]));
  for (const field of changed) patch[`conversationMemory.${field}`] = result[field];
  if (interruptCategories.has(result.messageCategory) &&
      changed.some(field => factualFields.includes(field)) && !conversation.bookingState?.appointment) {
    if (['offering_slots', 'awaiting_confirmation'].includes(conversation.bookingState?.status)) {
      Object.assign(patch, { 'bookingState.status': 'not_started', 'bookingState.offeredSlots': [],
        'bookingState.selectedSlot': null, 'bookingState.expiresAt': null });
    }
    const intake = conversation.conversationMemory?.recoveryIntake;
    if (intake) patch['conversationMemory.recoveryIntake'] = { ...intake, submitted: false, reviewReady: false, availability: { status: 'not_checked', reason: 'request_changed' }, review: { status: 'update_required' }, activePreference: { label: result.preferredAppointmentTime || lead.preferredAppointmentTime || '' }, ...(changed.includes('preferredAppointmentTime') ? { date: '', time: '' } : {}) };
  }
  return patch;
}

export function reviewSmsAppointmentRevision({ result, lead, conversation }) {
  if (!result || result.decision === 'no_reply' || !conversation?.bookingState?.appointment ||
      result.handoff?.required || !Object.keys(buildSmsRequestRevisionPatch({ result, lead, conversation })).length) return result;
  return { ...result, shouldAlertOwner: true, intakeReady: false,
    handoff: { required: true, reason: 'scheduling_review', callbackRequested: false } };
}

export function enforceSmsWorkflowResult(result, { lead = {} } = {}) {
  if (!result) return result; // The orchestrator owns missing-result recovery.
  const model = result.guardrail?.skipAI === false;
  const intentionalSilence = ['stop', 'possible_spam', 'abusive', 'off_topic', 'prompt_injection'].includes(result.messageCategory);
  const unsupportedAction = model && result.actionType && !REPLY_ACTION_TYPES.includes(result.actionType);
  const accidentalSilence = model && result.decision === 'no_reply' && !intentionalSilence;
  const pipelineFailure = result.guardrail?.reason === 'ai_pipeline_error';
  if (!unsupportedAction && !accidentalSilence && !pipelineFailure) return result;
  return {
    ...result,
    // A rejected model action cannot also replace the saved request facts.
    ...(unsupportedAction ? Object.fromEntries(factualFields.map(field => [field, known(lead[field]) ? lead[field] : ''])) : {}),
    decision: 'send_fixed_response', actionType: 'human_handoff',
    reply: 'Your message needs team review. Your request is not a confirmed appointment, and I cannot guarantee a response time.',
    intakeReady: false, shouldAlertOwner: true, alertPriority: 'high',
    handoff: { required: true, reason: 'intake_unclear', callbackRequested: false },
    guardrail: { ...(result.guardrail || {}), skipAI: true, usedFallback: true,
      reason: pipelineFailure ? 'ai_pipeline_error' : unsupportedAction ? 'unsupported_sms_action' : 'unexpected_model_silence' },
  };
}

// Called after intake/handoff selection. A proposal is recorded separately from
// delivery and staff acknowledgment; it is never evidence of either.
export function describeSmsWorkflowDecision({ result = {}, conversation = {} } = {}) {
  let action = 'update_request';
  if (result.decision === 'no_reply') action = 'suppress_reply';
  else if (['emergency', 'hazardous_diy_request'].includes(result.messageCategory) || result.riskFlags?.includes('safety_hazard')) action = 'safety_response';
  else if (result.serviceEligibility && result.serviceEligibility.decision !== 'supported') action = 'service_boundary';
  else if (result.handoff?.reason === 'intake_complete') action = 'request_business_approval';
  else if (result.handoff?.required || result.shouldAlertOwner || result.messageCategory === 'human_requested') action = 'staff_review';
  else if (conversation.bookingState?.status === 'pending_business_confirmation') action = 'request_business_approval';
  else if (['pricing_request', 'appointment_status', 'human_handoff_status', 'business_information', 'service_area_question', 'availability_inquiry'].includes(result.messageCategory)) action = 'answer_question';
  else if (result.actionType === 'request_information' || result.actionType === 'collect_appointment_preference') action = 'ask_missing_detail';
  return { version: 1, action, reason: clean(result.guardrail?.reason || result.handoff?.reason || result.messageCategory).slice(0, 120) || 'existing_workflow',
    bookingStatus: clean(conversation.bookingState?.status) || 'not_started' };
}
