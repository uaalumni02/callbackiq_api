import { withDistributedLease } from './distributedLease.service.js';
import crypto from 'node:crypto';
import Conversation from '../models/conversation.js';
import Lead from '../models/lead.js';
import VoiceSession from '../models/voiceSession.js';
import AlertService from './alert.service.js';
import { enqueueWebhookWork } from './webhooks/webhookWork.service.js';
import { evaluateDeterministicInboundGuardrails, getEmergencyReply, redactSensitiveData } from '../helpers/ai/aiGuardrails.js';
import { staffReviewDueAt } from './staffReviewPolicy.service.js';
import { logOperationalError } from '../helpers/logging/safeLogger.js';

export function voiceSafetyAssessment(customerMessage) {
  const assessment = evaluateDeterministicInboundGuardrails({ customerMessage });
  return assessment.handled && (['emergency', 'hazardous_diy_request'].includes(assessment.category) ||
    assessment.reason === 'safety_clarification_required') ? assessment : null;
}

// This event never authorizes intake writes, a transfer, dispatch, or a customer
// message. It can be processed outside the intake lease while another caller or
// staff owns the request. The durable worker retries partial persistence safely.
export async function processVoiceSafetyReview(payload) {
  const { businessId, conversationId, sessionId, eventId, assessment, customerMessage, observedAt } = payload;
  const session = await VoiceSession.findOne({ _id: sessionId, business: businessId, conversation: conversationId });
  const conversation = await Conversation.findOne({ _id: conversationId, business: businessId });
  if (!session || !conversation) throw Object.assign(new Error('Safety review context is unavailable'), { code: 'SAFETY_CONTEXT_MISSING' });
  await VoiceSession.updateOne({ _id: sessionId, business: businessId, conversation: conversationId },
    { $set: { 'metadata.safetyConcernReportedAt': observedAt, fallbackSmsStatus: 'suppressed' } });
  const priority = assessment.category === 'emergency' ? 'critical' : 'high';
  const urgency = priority === 'critical' ? 'emergency' : 'high';
  const leadId = conversation.lead;
  const saved = await AlertService.create({ businessId, leadId, conversationId,
    type: 'safety_emergency', priority, actionRequired: true,
    dueAt: staffReviewDueAt(priority, new Date(observedAt)),
    title: 'Caller-reported safety concern — business review required',
    message: 'A caller reported a possible safety concern. This is unverified customer information, not an emergency dispatch or a promise of response.',
    reason: assessment.reason || assessment.category,
    recommendedAction: 'Review the caller report. Staff receipt and response are unconfirmed. Do not treat this alert as emergency monitoring, dispatch, or an accepted service appointment.',
    lastCustomerMessage: customerMessage,
    metadata: { source: 'voice_safety_review', voiceSessionId: String(sessionId), eventId,
      hazardType: assessment.hazardType || '', observedAt, emergencyDispatch: false,
      staffResponseGuaranteed: false, customerGuidance: 'Do not wait for a business callback.' },
    dedupeKey: `voice-safety:${eventId}` });
  if (!saved?.alert?._id) throw Object.assign(new Error('Safety review alert was not saved'), { code: 'STAFF_ACTION_NOT_SAVED' });
  // Alert creation does not wait for intake ownership. Project urgency under
  // the shared lease so an in-flight intake save cannot overwrite it afterward.
  const lease = await withDistributedLease(`sms-conversation:${conversationId}`, async () => {
    await Lead.updateOne({ _id: leadId, business: businessId, urgency: { $ne: 'emergency' } }, { $set: { urgency } });
    await Conversation.updateOne({ _id: conversationId, business: businessId, 'conversationMemory.urgency': { $ne: 'emergency' } },
      { $set: { 'conversationMemory.urgency': urgency } });
  });
  if (!lease.acquired) throw Object.assign(new Error('Safety urgency projection is waiting for intake'), { code: 'SAFETY_REVIEW_BUSY' });
}

export async function voiceSafetyReviewReply({ session, customerMessage, turnId = '', assessment = voiceSafetyAssessment(customerMessage) }) {
  if (!assessment) return null;
  const businessId = session.business?._id || session.business;
  const conversationId = session.conversation?._id || session.conversation;
  const lastCustomer = session.transcript?.filter(entry => entry.role === 'customer').at(-1);
  const sourceTurn = lastCustomer?.at && Number.isFinite(new Date(lastCustomer.at).getTime())
    ? new Date(lastCustomer.at).toISOString() : String(turnId || session.transcript?.length || '');
  const eventId = crypto.createHash('sha256').update(JSON.stringify([
    String(session._id), sourceTurn, String(customerMessage),
  ])).digest('hex');
  const payload = { businessId, conversationId, sessionId: session._id, eventId,
    observedAt: new Date().toISOString(),
    assessment: { category: assessment.category, reason: assessment.reason, hazardType: assessment.hazardType },
    customerMessage: redactSensitiveData(String(customerMessage)).slice(0, 1600) };
  // Never withhold safety guidance waiting on a database or imply alert delivery.
  // A late successful insert is still useful; failures are explicitly observable.
  let timer;
  session.metadata = { ...(session.metadata || {}), safetyConcernReportedAt: payload.observedAt };
  const persist = enqueueWebhookWork({ kind: 'voice_safety_review', businessId, eventId, payload })
    .catch(error => logOperationalError('voice.safety_review_not_recorded', error, { businessId, voiceSessionId: session._id, eventId }));
  try { await Promise.race([persist, new Promise(resolve => { timer = setTimeout(resolve, 400); })]); }
  finally { clearTimeout(timer); }
  return { reply: assessment.category === 'emergency' ? getEmergencyReply(assessment.hazardType) : assessment.reply,
    ...(assessment.category === 'emergency' ? { outcome: 'safety_guidance',
      handoff: { type: 'end', handoffData: JSON.stringify({ reasonCode: 'safety_guidance' }) } } : {}) };

}
