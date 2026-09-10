import { detectSafetyHazardType, getEmergencyReply } from '../helpers/ai/aiGuardrails.js';
import { assertDistributedLeaseActive } from './distributedLease.service.js';
import { assertVoiceTurnActive } from './voiceTurnContext.service.js';

const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const inability = /\b(?:can['’]?t|cannot|unable to|couldn['’]?t|can not)\b/i;
const water = /\bwater\b/i;
const power = /\b(?:power|electricity|breaker|panel)\b/i;
const control = /\b(?:turn|shut|switch|reach|find|locate|access|stop)\b/i;

export function customerConstraint(text) {
  const value = clean(text);
  if (/\b(?:what if|suppose|hypothetically)\b/i.test(value)) return '';
  const unavailableControl = /\b(?:valve|shutoff|shut-off|breaker|panel)\b.{0,30}\b(?:stuck|inaccessible|unreachable|won['’]?t turn|will not turn)\b/i.test(value);
  if (!unavailableControl && (!inability.test(value) || !control.test(value))) return '';
  const resource = value.match(/\b(?:turn|shut|switch|reach|find|locate|access|stop)\b.{0,25}?\b(water|power|electricity|breaker|panel|gas|valve|shutoff)\b/i)?.[1]?.toLowerCase();
  if (resource === 'water') return 'water_control_unavailable';
  if (resource && power.test(resource)) return 'power_control_unavailable';
  if (resource) return 'control_unavailable_unspecified';
  if (water.test(value)) return 'water_control_unavailable';
  if (power.test(value)) return 'power_control_unavailable';
  return 'control_unavailable_unspecified';
}

export function currentConstraints(conversation) {
  const state = conversation?.conversationMemory?.recoveryIntake;
  if (state?.journeyKey !== (conversation?.orchestration?.recoveryJourneyKey || '')) return [];
  return Array.isArray(state?.customerConstraints) ? state.customerConstraints : [];
}

// Safety advice must respect both this turn and limitations recorded earlier.
// Remove only the unavailable action; retain evacuation/emergency guidance.
export function respectCustomerConstraints(reply, { conversation, customerMessage = '' } = {}) {
  if (!clean(reply)) return '';
  const constraints = [...currentConstraints(conversation), customerConstraint(customerMessage)];
  let text = clean(reply);
  if (constraints.some(value => value === 'water_control_unavailable' || value === 'power_control_unavailable')) {
    text = text.replace(/ and stay away/gi, '. Stay away');
  }
  if (constraints.includes('water_control_unavailable')) {
    text = text.replace(/(?:If [^.!?]*,\s*)?(?:shut|turn|switch) (?:off (?:the )?(?:main )?water (?:supply|off)|(?:the )?(?:main )?water (?:supply )?off)[^.!?]*[.!?]?/gi, '');
    text = text.replace(/If [^.!?]*(?:shutoff|shut-off|water valve)[^.!?]*,?\s*turn it off[.!?]?/gi, '');
    text = text.replace(/If water is actively leaking[^.!?]*turn it off[.!?]?/gi, '');
  }
  if (constraints.includes('power_control_unavailable')) {
    text = text.replace(/(?:If [^.!?]*,\s*)?(?:shut|turn|switch) off (?:the )?(?:power|electricity)[^.!?]*[.!?]?/gi, '');
  }
  return clean(text) || 'Please avoid the affected equipment. What is happening right now?';
}

// Both channel entry points run this before routine intake. No appointment or
// takeover state is changed. A failed persistence attempt must not be acknowledged.
export async function observeCustomerConstraint({ conversation, lead, customerMessage, channel = 'sms' }) {
  let constraint = customerConstraint(customerMessage);
  const prior = conversation?.conversationMemory?.recoveryIntake;
  const sameJourney = prior?.journeyKey === (conversation?.orchestration?.recoveryJourneyKey || '');
  if (!constraint && sameJourney && prior?.field === 'constraint_control') {
    if (/^(?:the )?(?:water|water supply|valve|shutoff)[.! ]*$/i.test(clean(customerMessage))) constraint = 'water_control_unavailable';
    if (/^(?:the )?(?:power|electricity|breaker|panel)[.! ]*$/i.test(clean(customerMessage))) constraint = 'power_control_unavailable';
  }
  const negative = sameJourney && prior?.field === 'constraint_condition' && prior?.constraintQuestion && /^(?:no|nope)[.! ]*$/i.test(clean(customerMessage));
  const affirmative = /^(?:yes|yeah|yep)[.! ]*$/i.test(clean(customerMessage));
  const contextualHazard = sameJourney && affirmative && prior?.constraintQuestion && prior?.field === 'constraint_condition';
  if (!constraint && (contextualHazard || negative)) constraint = prior.constraintQuestion;
  if (!constraint || !conversation || conversation.humanTakeover || ['closed', 'archived'].includes(conversation.status)) return null;
  if (typeof conversation.save !== 'function') return null;
  const check = () => { assertDistributedLeaseActive(); if (channel === 'voice') assertVoiceTurnActive(); };
  const journeyKey = conversation.orchestration?.recoveryJourneyKey || '';
  const old = conversation.conversationMemory?.recoveryIntake;
  const state = old?.journeyKey === journeyKey ? { ...old } : { journeyKey };
  state.customerConstraints = [...new Set([...(state.customerConstraints || []), constraint])];
  if (!contextualHazard && !negative) state.constraintEvidence = clean(customerMessage).slice(0, 300);
  if (constraint === 'water_control_unavailable') {
    state.triagePending = true;
    state.triageResolved = false;
    state.triageAsked = true;
    state.field = 'constraint_condition';
    state.leakPattern = 'unknown';
  }
  if (constraint === 'control_unavailable_unspecified') state.field = 'constraint_control';
  state.constraintQuestion = contextualHazard || negative || constraint === 'control_unavailable_unspecified' ? '' : constraint;
  if (constraint === 'power_control_unavailable') state.field = 'constraint_condition';
  if (contextualHazard) { state.triagePending = false; state.triageResolved = true; state.leakPattern = constraint === 'water_control_unavailable' ? 'active' : state.leakPattern; }
  check();
  if (conversation.set) conversation.set('conversationMemory.recoveryIntake', state);
  else conversation.conversationMemory = { ...(conversation.conversationMemory || {}), recoveryIntake: state };
  conversation.markModified?.('conversationMemory.recoveryIntake');
  await conversation.save(); check();
  if (negative) return null;
  if (contextualHazard) {
    return {
      decision: 'send_fixed_response', actionType: 'human_handoff', messageCategory: 'emergency',
      reply: respectCustomerConstraints(getEmergencyReply(constraint === 'water_control_unavailable' ? 'flood' : 'electrical'), { conversation }),
      urgency: 'emergency', intakeReady: false, shouldAlertOwner: true, alertPriority: 'critical',
      alertTitle: 'Active concern with unavailable shutoff', summary: `${state.constraintEvidence}; customer confirmed the condition is active.`,
      customerConstraints: state.customerConstraints, riskFlags: ['safety_hazard'],
      guardrail: { skipAI: true, usedFallback: false, reason: 'confirmed_condition_with_constraint' },
    };
  }
  // A concrete hazard still goes through the existing emergency path.
  if (detectSafetyHazardType(customerMessage)) return null;
  return {
    decision: 'send_fixed_response', actionType: 'request_information', messageCategory: 'service_request',
    reply: constraint === 'water_control_unavailable'
      ? "Understood—you’re unable to shut off the water. Is water still leaking right now?"
      : constraint === 'control_unavailable_unspecified'
      ? "Understood. What are you unable to shut off or reach?"
      : "Understood—you’re unable to shut off the power. Stay away from the affected equipment. Are there sparks, smoke, or a burning smell right now?",
    serviceNeeded: lead?.serviceNeeded || '', urgency: lead?.urgency || 'medium',
    address: lead?.address || '', preferredAppointmentTime: lead?.preferredAppointmentTime || '',
    intakeReady: false, shouldAlertOwner: true, alertPriority: 'high',
    alertTitle: 'Customer cannot perform suggested action',
    alertMessage: clean(customerMessage).slice(0, 300), summary: clean(customerMessage).slice(0, 300),
    customerConstraints: state.customerConstraints, riskFlags: [],
    guardrail: { skipAI: true, usedFallback: false, reason: 'customer_constraint_clarification' },
  };
}
