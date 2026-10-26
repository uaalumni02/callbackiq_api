/**
 * Shared orchestration adapter; enters AFTER safety, STOP, human, and service
 * eligibility guards but BEFORE long scheduling/valuation paths.
 */
import Conversation from '../../models/conversation.js';
import { planReadOnlyTurn, dialogMode, asSmsDialogResult, detectDialogAct, protectedTurnText } from './dialogPolicy.js';
import { classifyReadOnlyQuestion } from './semanticRouter.js';
import { buildDialogState, assertNoUnauthorizedEffects } from './dialogState.js';
import { emitDialogMetric } from './dialogMetrics.js';
import { reserveAiUsage } from '../communicationUsage.service.js';
import { assertDistributedLeaseActive } from '../distributedLease.service.js';
import { assertVoiceTurnActive } from '../voiceTurnContext.service.js';

export async function maybeAnswerDialogQuestion({ business, lead, conversation, customerMessage,
  channel = 'sms', recentMessages = [], signal = null, env = process.env } = {}) {
  const mode = dialogMode(env);
  if (!conversation || !lead || !business || conversation.humanTakeover || conversation.aiEnabled === false ||
      ['closed','archived'].includes(conversation.status)) return null;
  // No LLM call for obvious command/mutation facts. This is a read-only adapter.
  let semantic = null;
  if (mode === 'active' && !detectDialogAct(customerMessage) && !protectedTurnText(customerMessage) &&
      env.MEEKCALL_DIALOG_SEMANTIC_ENABLED === 'true' &&
      (channel === 'sms' || env.MEEKCALL_DIALOG_VOICE_SEMANTIC_ENABLED === 'true') &&
      /[?]|\b(?:how|when|what|where|is|are|did|do|can|could|would|will|should|any update|next step)\b/i.test(String(customerMessage))) {
    // Reserve usage BEFORE an additional semantic request; fail closed if
    // the existing tenant budget refuses or tracking is degraded.
    let allowance = null;
    try { allowance = await reserveAiUsage({ business, customerPhone: lead?.phone || conversation.customerPhone || '' }); }
    catch { allowance = null; }
    if (allowance?.allowed === true && allowance?.degraded !== true) {
      semantic = await classifyReadOnlyQuestion({ customerMessage, recentMessages, signal, env });
    }
  }
  const plan = planReadOnlyTurn({ customerMessage, semantic, lead, conversation, channel, recentMessages });
  const previous = conversation.conversationMemory?.dialogPolicy;
  const state = buildDialogState({ previous, plan, conversation, channel });
  emitDialogMetric({ businessId: business._id, conversationId: conversation._id,
    channel, outcome: plan.handled ? mode === 'active' ? 'handled' : 'observed' : 'deferred',
    intent: plan.intent, phase: state.phase });
  if (!plan.handled || mode !== 'active') return null;
  assertNoUnauthorizedEffects(plan);
  if (channel === 'voice') assertVoiceTurnActive();
  assertDistributedLeaseActive();
  // Persist across SMS and voice, scoped to the current business and only while
  // automation owns the conversation. No raw user message or PII stored here.
  const updated = await Conversation.updateOne({ _id: conversation._id, business: business._id,
    humanTakeover: { $ne: true }, aiEnabled: { $ne: false }, status: { $nin: ['closed','archived'] } },
    { $set: { 'conversationMemory.dialogPolicy': state } });
  if (channel === 'voice') assertVoiceTurnActive();
  assertDistributedLeaseActive();
  if (updated.matchedCount !== 1) return null;
  conversation.conversationMemory = conversation.conversationMemory || {};
  conversation.conversationMemory.dialogPolicy = state;
  if (channel === 'voice') return { reply: plan.reply, outcome: 'direct_answer_resolved', dialogPolicy: { intent: plan.intent, phase: state.phase } };
  return asSmsDialogResult(plan, lead);
}
