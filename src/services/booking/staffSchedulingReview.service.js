import { captureTurnFacts } from './turnFactCapture.service.js';
import AlertService from '../alert.service.js';
import { assertDistributedLeaseActive } from '../distributedLease.service.js';
import { assertVoiceTurnActive } from '../voiceTurnContext.service.js';

export async function requestStaffSchedulingReview({ business, lead, conversation, customerMessage, channel = 'sms', now = new Date() }) {
  const check = () => { assertDistributedLeaseActive(); if (channel === 'voice') assertVoiceTurnActive(); };
  check();
  const facts = captureTurnFacts({ customerMessage, business, lead, now });
  const result = {
    decision: 'send_fixed_response', actionType: 'human_handoff', messageCategory: 'appointment_preference',
    reply: "Your requested timing is saved for team review. This is not a confirmed appointment or dispatch, and a response time is not guaranteed.",
    serviceNeeded: lead?.serviceNeeded || '', urgency: lead?.urgency || 'medium', address: lead?.address || '',
    preferredAppointmentTime: facts.preferredAppointmentTime || customerMessage || lead?.preferredAppointmentTime || '',
    shouldAlertOwner: true, alertPriority: lead?.urgency === 'emergency' ? 'critical' : 'high', riskFlags: [],
    intakeReady: false, handoff: { required: true, reason: 'scheduling_review', callbackRequested: false },
    guardrail: { skipAI: true, usedFallback: false, reason: 'staff_scheduling_review' },
  };
  if (lead && typeof lead.save === 'function') {
    lead.preferredAppointmentTime = result.preferredAppointmentTime;
    await lead.save(); check();
  }
  if (channel === 'voice') {
    await AlertService.createHumanHandoffAlert({ businessId: business._id, leadId: lead?._id,
      conversationId: conversation._id, customerPhone: lead?.phone || conversation.customerPhone,
      customerName: lead?.customerName, customerMessage, lead, result,
      providerMessageId: `voice-scheduling:${conversation._id}:${conversation.orchestration?.recoveryJourneyKey || now.toISOString().slice(0, 10)}` });
    check();
    result.outcome = 'callback_saved';
  }
  // Retire earlier numbered offers, so a later "1" cannot select a stale
  // appointment after the customer asked for a different, unavailable day.
  if (conversation && typeof conversation.save === 'function') {
    conversation.bookingState = { ...(conversation.bookingState?.toObject?.() || conversation.bookingState || {}),
      status: 'collecting_preference', offeredSlots: [], selectedSlot: null, expiresAt: null };
    conversation.markModified?.('bookingState');
    if (channel === 'voice') {
      conversation.orchestration = { ...(conversation.orchestration?.toObject?.() || conversation.orchestration || {}),
        phase: 'handoff_pending', handoffStatus: 'pending_ack', handoffReason: 'scheduling_review',
        handoffRequestedAt: now, handoffAcknowledgedAt: null };
      conversation.markModified?.('orchestration');
    }
    check(); await conversation.save(); check();
  }
  return result;
}
