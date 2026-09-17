import Conversation from '../models/conversation.js';
import Lead from '../models/lead.js';
import VoiceSession from '../models/voiceSession.js';
import { handleVoiceExit } from '../voice/voiceExit.service.js';
import { withDistributedLease, registerDistributedLeaseGuard, assertDistributedLeaseActive } from './distributedLease.service.js';
import { assertVoiceTurnActive } from './voiceTurnContext.service.js';
import { detectSafetyHazardType, getEmergencyReply } from '../helpers/ai/aiGuardrails.js';

const overlapReply = customerMessage => {
  const hazard = detectSafetyHazardType(customerMessage);
  return { reply: hazard ? getEmergencyReply(hazard) :
    'Another call from this number is already handling this request. I cannot change it on this call. Please finish the other call, then call again if you need help with a separate request.' };
};

// Keep one intake writer for the lifetime of a voice call, not merely one turn.
// A contending call remains read-only even if the original call later ends.
// All ownership reads and writes happen under the shared SMS/voice lease.
const ownsVoiceIntake = async (session, conversation, businessId) => {
  if (session.metadata?.sharedRequestReadOnly) return false;
  const owner = conversation.orchestration?.activeVoiceIntakeSession;
  if (owner && String(owner) !== String(session._id)) {
    const active = await VoiceSession.findOne({
      _id: owner, business: businessId, conversation: conversation._id,
      status: { $nin: ['completed', 'failed', 'canceled'] },
    });
    assertDistributedLeaseActive();
    if (active) {
      await VoiceSession.updateOne({ _id: session._id, business: businessId },
        { $set: { 'metadata.sharedRequestReadOnly': true } });
      session.metadata = { ...(session.metadata || {}), sharedRequestReadOnly: true };
      return false;
    }
  }
  if (String(owner || '') !== String(session._id)) {
    const updated = await Conversation.findOneAndUpdate({
      _id: conversation._id, business: businessId,
      'orchestration.activeVoiceIntakeSession': owner || null,
    }, { $set: { 'orchestration.activeVoiceIntakeSession': session._id } }, { returnDocument: 'after' });
    assertDistributedLeaseActive();
    if (!updated) return false;
    conversation.orchestration = conversation.orchestration || {};
    conversation.orchestration.activeVoiceIntakeSession = session._id;
  }
  return true;
};

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
    const lead = await Lead.findOne({ _id: conversation.lead, business: businessId });
    assertVoiceTurnActive();
    if (!lead) throw new Error('Voice lead no longer exists.');
    session.conversation = conversation; session.lead = lead;
    // Ending a call / withdrawing contact consent is always available, even
    // when another voice call owns intake or staff have taken over.
    const exit = await handleVoiceExit({ session, customerMessage });
    if (exit) return exit;
    if (conversation.humanTakeover || conversation.aiEnabled === false || ['closed', 'archived'].includes(conversation.status)) {
      const hazard = detectSafetyHazardType(customerMessage);
      return { reply: hazard ? getEmergencyReply(hazard) : 'This request is under team review. I cannot change or confirm an appointment here.' };
    }
    if (!await ownsVoiceIntake(session, conversation, businessId)) return overlapReply(customerMessage);
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
