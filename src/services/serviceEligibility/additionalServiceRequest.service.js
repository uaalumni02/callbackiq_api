import crypto from 'node:crypto';
import AlertService from '../alert.service.js';
import { staffReviewDueAt } from '../staffReviewPolicy.service.js';
import { assertDistributedLeaseActive } from '../distributedLease.service.js';
import { assertVoiceTurnActive } from '../voiceTurnContext.service.js';

export async function preserveAdditionalServiceRequest({ request, business, lead, conversation, customerMessage, evaluate }) {
  if (typeof conversation.save !== 'function') return null;
  const check = () => { assertDistributedLeaseActive(); assertVoiceTurnActive(); };
  let eligibility;
  try { eligibility = await evaluate({ businessId: business._id, request }); }
  catch { eligibility = { decision: 'needs_staff_review', reason: 'catalog_unavailable' }; }
  check();
  const journeyKey = conversation.orchestration?.recoveryJourneyKey || '';
  const key = crypto.createHash('sha256').update(`${journeyKey}:${request.toLowerCase()}`).digest('hex').slice(0, 32);
  const entry = { key, request, decision: eligibility.decision, reason: eligibility.reason,
    serviceId: eligibility.serviceId || null, accepted: false, observedAt: new Date() };
  const saved = await AlertService.create({ businessId: business._id, leadId: lead?._id, conversationId: conversation._id,
    type: 'system', title: 'Additional service question', priority: 'medium',
    actionRequired: eligibility.decision !== 'unsupported', dueAt: staffReviewDueAt('medium'),
    message: `Additional request: ${request}. Existing request retained: ${lead.serviceNeeded}.`,
    recommendedAction: 'Review additional work separately. Preserve the original request and appointment; do not add work or promise a visit without business approval.',
    lastCustomerMessage: customerMessage,
    metadata: { additionalRequest: entry, primaryService: lead.serviceNeeded },
    dedupeKey: `additional-service:${conversation._id}:${key}` });
  if (!saved?.alert?._id) throw Object.assign(new Error('Additional request review was not saved'), { code: 'STAFF_ACTION_NOT_SAVED' });
  check();
  const intake = conversation.conversationMemory?.recoveryIntake || {};
  const entries = Array.isArray(intake.additionalRequests) ? intake.additionalRequests : [];
  const next = { ...intake, additionalRequests: [...entries.filter(item => item.key !== key), entry].slice(-10) };
  if (conversation.set) conversation.set('conversationMemory.recoveryIntake', next);
  else conversation.conversationMemory = { ...(conversation.conversationMemory || {}), recoveryIntake: next };
  conversation.markModified?.('conversationMemory.recoveryIntake');
  await conversation.save(); check();
  const answer = eligibility.decision === 'unsupported'
    ? 'The business does not offer that additional work.'
    : eligibility.decision === 'supported'
      ? 'The additional work is listed as a service, but needs separate business approval.'
      : 'The team must review whether it can accept the additional work.';
  return { decision: 'send_fixed_response', actionType: 'send_fixed_response', messageCategory: 'service_details',
    reply: `Your ${String(lead.serviceNeeded).slice(0, 70)} request stays active. ${answer} It has not been added to your appointment.`,
    serviceNeeded: lead.serviceNeeded, address: lead.address || '', preferredAppointmentTime: lead.preferredAppointmentTime || '',
    urgency: lead.urgency || 'medium', intakeReady: false, additionalRequest: entry,
    guardrail: { skipAI: true, usedFallback: false, reason: 'additional_service_preserved' } };
}
