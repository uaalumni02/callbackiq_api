import Conversation from '../models/conversation.js';
import Lead from '../models/lead.js';
import { withDistributedLease, registerDistributedLeaseGuard, assertDistributedLeaseActive } from './distributedLease.service.js';
import { assertVoiceTurnActive } from './voiceTurnContext.service.js';
import { detectSafetyHazardType, getEmergencyReply } from '../helpers/ai/aiGuardrails.js';

// SMS workers use this same per-conversation key. Refresh after acquiring it:
// a populated voice session is a snapshot, not the current shared intake state.
export const runVoiceConversationTurn = async ({ session, customerMessage, operation }) => {
  const businessId = session.business?._id || session.business;
  const conversationId = session.conversation?._id || session.conversation;
  const lease = await withDistributedLease(`sms-conversation:${conversationId}`, async () => {
    registerDistributedLeaseGuard(assertVoiceTurnActive);
    assertVoiceTurnActive();
    const conversation = await Conversation.findOne({ _id: conversationId, business: businessId });
    assertVoiceTurnActive();
    if (!conversation) throw new Error('Voice conversation no longer exists.');
    if (conversation.humanTakeover || conversation.aiEnabled === false || ['closed', 'archived'].includes(conversation.status)) {
      return { reply: 'This request is under team review. I cannot change or confirm an appointment here.' };
    }
    const lead = await Lead.findOne({ _id: conversation.lead, business: businessId });
    assertVoiceTurnActive();
    if (!lead) throw new Error('Voice lead no longer exists.');
    session.conversation = conversation; session.lead = lead;
    assertDistributedLeaseActive();
    const result = await operation();
    assertDistributedLeaseActive();
    assertVoiceTurnActive();
    const latest = await Conversation.findOne({ _id: conversationId, business: businessId });
    assertVoiceTurnActive();
    if (latest?.humanTakeover || latest?.aiEnabled === false) {
      return { reply: 'The team has taken over this request. No additional appointment is confirmed by this call.' };
    }
    return result;
  }, { ttlMs: 60000, metadata: { worker: 'voice_turn', businessId: String(businessId), sessionId: String(session._id) } });
  if (lease.acquired) return lease.value;
  // A busy SMS turn must not suppress immediate hazard guidance.
  const hazard = detectSafetyHazardType(customerMessage);
  return { reply: hazard ? getEmergencyReply(hazard) : 'Another message for this request is still being processed. Please try again in a moment; no appointment is confirmed.' };
};
