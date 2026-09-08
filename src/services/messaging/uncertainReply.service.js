// Low-confidence model output must not overwrite captured facts or drive an action.
export const constrainUncertainReply = async ({ result, lead, conversation, turnId = "" }) => {
  if (Number.isFinite(result?.confidence) && result.confidence >= 60 && conversation?.save && conversation?.conversationMemory?.uncertainTurns) {
    if (conversation.set) conversation.set('conversationMemory.uncertainTurns', 0);
    else conversation.conversationMemory.uncertainTurns = 0;
    await conversation.save();
  }
  if (!result || result.decision === 'no_reply' || result.guardrail?.skipAI === true ||
      result.guardrail?.usedFallback || !Number.isFinite(result.confidence) || result.confidence >= 60 ||
      typeof conversation?.save !== 'function') return result;
  const memory = conversation.conversationMemory || {};
  const count = turnId && memory.uncertainTurnId === String(turnId) ? Number(memory.uncertainTurns || 1) : Math.min(2, Number(memory.uncertainTurns || 0) + 1);
  if (conversation.set) conversation.set('conversationMemory.uncertainTurns', count);
  else conversation.conversationMemory = { ...memory, uncertainTurns: count };
  if (conversation.set) conversation.set('conversationMemory.uncertainTurnId', String(turnId));
  else conversation.conversationMemory.uncertainTurnId = String(turnId);
  await conversation.save();
  return { ...result, decision: 'send_fixed_response', actionType: count >= 2 ? 'human_handoff' : 'request_information',
    messageCategory: 'unknown', serviceNeeded: lead?.serviceNeeded || '', address: lead?.address || '',
    preferredAppointmentTime: lead?.preferredAppointmentTime || '', urgency: lead?.urgency || 'medium',
    reply: count >= 2 ? "Your message is saved for team review. I don't have a response timeframe." : "I didn't understand that. Could you rephrase what you need help with?",
    intakeReady: false, ...(count >= 2 ? { handoff: { required: true, reason: 'intake_unclear', callbackRequested: false } } : {}),
    guardrail: { skipAI: true, usedFallback: false, reason: 'uncertain_model_reply' },
  };
};
