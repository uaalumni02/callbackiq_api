import { currentCoverage } from '../booking/coverageConversation.service.js';
import { applyCustomerAddressRevision } from './customerRequestRevision.service.js';
import { planCustomerTurn } from './customerTurnPlan.service.js';
import { selectOfferedSlot } from '../booking/bookingStateMachine.service.js';
import { guardServiceRequest, blocksServiceAutomation } from '../serviceEligibility/serviceEligibility.service.js';
import { requestWasWithdrawn } from '../conversationControlPolicy.js';
import { getApprovedServiceEstimate } from '../booking/approvedServiceEstimate.service.js';
import { assertDistributedLeaseActive } from '../distributedLease.service.js';
import { assertVoiceTurnActive } from '../voiceTurnContext.service.js';
import { classifySmsIntent } from './smsIntentClassifier.service.js';
import { evaluateDeterministicInboundGuardrails } from '../../helpers/ai/aiGuardrails.js';
import { isSoftOptOutPhrase } from './smsCompliance.service.js';
import { captureTurnFacts } from '../booking/turnFactCapture.service.js';

export async function handleCompoundCustomerTurn({ business, lead, conversation, customerMessage, turnId = '', channel = 'sms', now = new Date() }) {
  if (!conversation || !lead || conversation.humanTakeover || conversation.aiEnabled === false ||
      ['closed', 'archived'].includes(conversation.status) || requestWasWithdrawn(conversation) ||
      typeof lead.save !== 'function' || typeof conversation.save !== 'function') return null;
  if (isSoftOptOutPhrase(customerMessage) || evaluateDeterministicInboundGuardrails({ customerMessage }).handled) return null;
  const plan = planCustomerTurn({ customerMessage, business, lead, conversation });
  if (!plan.compound) return null;
  const check = () => { assertDistributedLeaseActive(); assertVoiceTurnActive(); };
  const prior = conversation.conversationMemory?.recoveryIntake?.compoundTurn;
  if (turnId && prior?.turnId === String(turnId) && prior.text === plan.text) {
    // Repair an interrupted lead write before allowing handoff acknowledgment.
    if (prior.result?.preferredAppointmentTime) { lead.preferredAppointmentTime = prior.result.preferredAppointmentTime; check(); await lead.save(); }
    return prior.result;
  }
  const { addressChanged } = await applyCustomerAddressRevision({ business, lead, conversation, customerMessage, turnId });
  const priorService = lead.serviceNeeded;
  const boundary = await guardServiceRequest({ business, lead, conversation, customerMessage, channel, turnId });
  if (boundary && !boundary.additionalRequest) return boundary;
  const state = conversation.bookingState || {};
  const slots = state.status === 'offering_slots' ? state.offeredSlots || [] :
    state.status === 'awaiting_confirmation' && state.selectedSlot ? [state.selectedSlot] : [];
  const timezone = business.timezone || 'America/New_York';
  const clauses = plan.text.split(/[.!?;]+|,\s*(?=(?:please|can|could|also|have|call|give|is|will)\b)|\s+(?:and|but)\s+(?=(?:please|can|could|also|have|call|give|is|will|option)\b)|\s+(?=(?:please|call me|give me a call)\b)/i).map(s => s.trim()).filter(Boolean);
  const choices = clauses.filter(clause => {
    const intent = classifySmsIntent({ customerMessage: clause }).intents;
    return !intent.human && !intent.callback && !intent.pricing && !intent.status && !/^(?:can|could|do|does|is|are|will|would|what|when|how)\b/i.test(clause);
  }).map(clause => selectOfferedSlot(clause, slots, timezone)).filter(Boolean);
  const distinct = [...new Map(choices.map(slot => [String(slot.startAt), slot])).values()];
  const rejected = /\b(?:not that|neither|none of|don['’]?t book|do not book|don['’]?t select|do not select|no longer|doesn['’]?t work|does not work)\b/i.test(plan.text);
  const expired = !state.expiresAt || !Number.isFinite(new Date(state.expiresAt).getTime()) || new Date(state.expiresAt) <= now;
  const selection = !plan.classified.intents.reschedule && !rejected && !expired && !blocksServiceAutomation(conversation) && distinct.length === 1 &&
    new Date(distinct[0].startAt) > now && new Date(distinct[0].endAt) > new Date(distinct[0].startAt) ? distinct[0] : null;
  const requestChanged = addressChanged || priorService !== lead.serviceNeeded;
  let selectionReply = requestChanged ? 'Request updated; earlier time options need rechecking. ' : '';
  const schedulingClauses = clauses.filter(clause => {
    const intents = classifySmsIntent({ customerMessage: clause }).intents;
    return !intents.callback && !intents.human && !intents.pricing && !intents.status &&
      !/^(?:can|could|do|does|is|are|will|would|what|when|how)\b/i.test(clause);
  }).join(' ');
  let preference = captureTurnFacts({ customerMessage: schedulingClauses, business, lead }).preferredAppointmentTime || lead.preferredAppointmentTime || '';
  if (plan.classified.intents.reschedule) {
    const schedulingText = clauses.filter(clause => {
      const intents = classifySmsIntent({customerMessage:clause}).intents;
      return (intents.reschedule || intents.scheduling) && !intents.callback && !intents.human;
    }).join(' ');
    preference = captureTurnFacts({ customerMessage:schedulingText, business, lead }).preferredAppointmentTime || preference;
    selectionReply = 'Your rescheduling request needs staff review. ';
  } else if (plan.classified.intents.availabilityInquiry && !slots.length) {
    selectionReply += 'Your availability question needs staff review; no opening is verified by this message. ';
  }
  if (selection) {
    preference = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(selection.startAt));
    selectionReply = `Requested ${preference}. `;
  } else if (slots.length && !plan.classified.intents.reschedule) {
    selectionReply = rejected ? 'No time selected. ' : expired ? 'The earlier options expired; the team must recheck availability. ' : 'Which offered option do you prefer? ';
  }
  let price = '';
  if (plan.classified.intents.pricing && !plan.additionalRequest) {
    try { price = await getApprovedServiceEstimate({ businessId: business._id, serviceNeeded: lead.serviceNeeded, customerMessage }); }
    catch { /* A price-read outage never invents a quote or loses a callback. */ }
    price = price ? `${price} ` : 'No approved price range is available. ';
  }
  const approval = state.appointment
    ? 'The team must verify your appointment status; this message does not change it. '
    : 'Not a confirmed appointment; business approval is required. ';
  const extra = boundary?.additionalRequest ? 'Your original service stays active. Additional work needs separate review and is not accepted. ' : '';
  const coverage = currentCoverage(conversation, lead);
  const coverageNote = coverage?.supported === null && coverage.address === lead.address ? 'Coverage for your address also needs team review. ' : '';
  const reply = `${selectionReply}${coverageNote}${approval}Callback requested; response time is not guaranteed. ${extra}${price}`.trim();
  const result = { decision: 'send_fixed_response', actionType: 'human_handoff', messageCategory: 'human_requested',
    reply, compoundTurn: true, serviceNeeded: lead.serviceNeeded || '', address: lead.address || '',
    preferredAppointmentTime: preference, urgency: lead.urgency || 'medium', intakeReady: false, shouldAlertOwner: true,
    handoff: { required: true, reason: 'scheduling_review', callbackRequested: true },
    summary: `Callback requested. ${lead.serviceNeeded || ''}; ${lead.address || ''}; preferred time: ${preference || 'not supplied'}. ${selectionReply}${coverageNote}${approval}${extra}`.trim(),
    guardrail: { skipAI: true, usedFallback: false, reason: 'compound_customer_turn' } };
  const intake = conversation.conversationMemory?.recoveryIntake || {};
  const next = { ...intake, compoundTurn: { turnId: String(turnId), text: plan.text, result,
    selectedSlot: selection ? { startAt: selection.startAt, endAt: selection.endAt } : null, recordedAt: now } };
  check();
  if (conversation.set) conversation.set('conversationMemory.recoveryIntake', next);
  else conversation.conversationMemory = { ...(conversation.conversationMemory || {}), recoveryIntake: next };
  conversation.markModified?.('conversationMemory.recoveryIntake');
  // Save the replayable decision before projecting the selected preference.
  // Booking/Appointment state is intentionally owned by the established engine.
  await conversation.save(); check();
  if (preference && preference !== lead.preferredAppointmentTime) { lead.preferredAppointmentTime = preference; await lead.save(); check(); }
  return result;
}
