import Conversation from '../../models/conversation.js';
export const RECOVERY_INTRO_COOLDOWN_MS = 15 * 60_000;
export const hasRecentRecoveryIntroduction = (conversation, now = new Date()) => {
  const at = conversation?.orchestration?.recoveryIntroClaimedAt;
  return Boolean(at && new Date(at).getTime() > now.getTime() - RECOVERY_INTRO_COOLDOWN_MS);
};
// Per customer conversation, not per CallSid: simultaneous repeat calls share one
// opening. Keep the claim on ambiguous provider failures; never blindly resend.
export const claimRecoveryIntroduction = async ({ businessId, conversationId, operationKey = "", now = new Date() }) => {
  const cutoff = new Date(now.getTime() - RECOVERY_INTRO_COOLDOWN_MS);
  return Boolean(await Conversation.findOneAndUpdate({
    _id: conversationId, business: businessId,
    status: 'open', humanTakeover: { $ne: true }, aiEnabled: { $ne: false },
    $or: [
      ...(operationKey ? [{ "orchestration.recoveryIntroOperationKey": operationKey }] : []),
      { 'orchestration.recoveryIntroClaimedAt': null },
      { 'orchestration.recoveryIntroClaimedAt': { $lte: cutoff } },
    ],
  }, { $set: { 'orchestration.recoveryIntroClaimedAt': now, ...(operationKey ? { 'orchestration.recoveryIntroOperationKey': operationKey } : {}) } }, { returnDocument: 'after' }));
};
